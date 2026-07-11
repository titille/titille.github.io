// AudioWorklet temps réel : paysage sonore ↔ kit de batterie sur un seul
// morph. Chaque module (PLUIE, VAGUE, ORAGE, VENT) est un flux d'événements à
// renouvellement Gamma avec ses propres bornes de taux ; côté percussion tous
// les flux convergent vers la MÊME grille (slots calculés depuis l'horloge
// commune, "soft snap" continu au-delà de m≈0.55) → kick/hat/crash en phase.
//
// PLUIE : gouttes physiques (Marshall-Palmer + Minnaert) ↔ hi-hat 1/16
// VAGUE : déferlement de houle ↔ kick 808 sur le beat
// La nappe de Campbell tourne en continu (bandes calibrées dans rain-dsp.js).
//
// Vers le thread principal :
//   {type:'drops', events:[{kind, ...}]} — kind: water|hard|tick|wave|kick
//   {type:'tele', wash, gust, level} — ~20 Hz, pour la brume/le vent du visuel
import {
  RNG, Biquad, bandpassCoeffs, buildDerived, shapeFromRegularity,
  renderDrop, synthTick, TICK_ENERGY,
  synthWaveBreak, synthKick, waveEnergy, KICK_ENERGY, VAGUE_DEFAULTS,
  synthThunder, synthCrash, thunderEnergy, crashEnergy,
  WindVoice, windPower,
  clamp, lerp, loglerp,
} from './rain-dsp.js';

const BUF = 1 << 18;                 // ring ≈ 5.4 s @ 48 k (queues longues : écume…)
const MASK = BUF - 1;
const TWO_PI = Math.PI * 2;
const TARGET_RMS = 0.12;             // ≈ -18 dBFS avant master + limiteur
const TELE_EVERY = 2048;             // cadence télémétrie (échantillons)
const smooth01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

class RainProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.fs = sampleRate;
    const opt = options.processorOptions || {};
    this.macros = opt.macros;
    this.master = opt.macros.master ?? 0.8;
    this.seed = (opt.macros.seed ?? 1) >>> 0;
    this.playing = false;
    this.bufL = new Float32Array(BUF);
    this.bufR = new Float32Array(BUF);
    this.evQueue = [];
    this.makeup = 1;
    this._reset();
    this._rebuild();
    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _reset() {
    this.rng = new RNG(this.seed);
    this.washRngL = new RNG((this.seed ^ 0x9e3779b9) >>> 0);
    this.washRngR = new RNG((this.seed ^ 0x517cc1b7) >>> 0);
    this.gustRng = new RNG((this.seed ^ 0x2545f491) >>> 0);
    this.clock = 0;
    this.teleCount = 0;
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.gust = 0;
    this.gustLP = 0;
    this.washLPL = 0;
    this.washLPR = 0;
    // état d'ordonnancement par module : prochain événement, parité (swing),
    // dernier slot de grille servi (anti double-déclenchement au snap)
    this.st = {
      pluie: { next: 0, count: 0, lastSlot: -1 },
      vague: { next: 0, count: 0, lastSlot: -1 },
      orage: { next: 0, count: 0, lastSlot: -1, queue: [] },
    };
    if (this.washL) for (const f of [...this.washL, ...this.washR]) { f.b1.reset(); f.b2.reset(); }
    // état du RESSAC (biquads + swell) : sans ce reset, rejouer la MÊME graine
    // sur la MÊME instance (Stop→Play, re-seed) garde les filtres chargés et une
    // phase/fréquence de swell rejitterées → rendu différent = viole « même seed
    // = même rendu » (revue adversariale). Gardé pour le 1er _reset de la
    // construction (vagueP/biquads pas encore créés → _rebuild s'en charge).
    if (this.ressacB1) {
      for (const b of [this.ressacB1, this.ressacB2, this.ressacB1r, this.ressacB2r,
        this.ressacHL, this.ressacHR]) b.reset();
    }
    this.swellPhase = 0;
    if (this.vagueP) this.swellInc = (TWO_PI * this.vagueP.swellHz) / this.fs;
  }

  // macros → tables dérivées + calibration des générateurs de nappe
  _rebuild() {
    const M = this.macros;
    const mm = M.modules || {};
    this.D = buildDerived(M, this.fs);

    // bandes de nappe : bruit blanc → 2 biquads BP en cascade, calibrés pour
    // que le RMS de sortie = sqrt(puissance de Campbell) de la bande.
    // Deux chaînes indépendantes G/D = champ diffus décorrélé (comme l'offline).
    const cal = new RNG(0xc0ffee);
    const mkChain = () => this.D.washBands.map((b) => {
      const c = bandpassCoeffs(b.f, b.q, this.fs);
      const b1 = new Biquad(c), b2 = new Biquad(c);
      let ss = 0;
      for (let i = 0; i < 2048; i++) { const y = b2.tick(b1.tick(cal.gauss())); ss += y * y; }
      const rmsRaw = Math.sqrt(ss / 2048) || 1;
      b1.reset(); b2.reset();
      return { b1, b2, gain: b.rms / rmsRaw };
    });
    this.washL = mkChain();
    this.washR = mkChain();
    this.washLPa = 1 - Math.exp((-2 * Math.PI * this.D.washLP) / this.fs);

    // morph : gains équi-puissance nature/percussion + transport commun
    const m = clamp(M.morph, 0, 1);
    this.gNat = Math.cos((m * Math.PI) / 2);
    this.gPerc = Math.sin((m * Math.PI) / 2);
    this.snap = smooth01((m - 0.55) / 0.35);   // attraction vers la grille
    this.regularity = M.regularity ?? m;
    this.beat = Math.round(this.fs * (60 / Math.max(40, M.bpm)));

    // PLUIE : taux physique ↔ grille BPM×subdiv
    this.pluieOn = mm.pluie ? mm.pluie.on !== false : true;
    const rateHat = Math.max(0.5, (M.bpm / 60) * M.subdiv);
    this.ratePluie = loglerp(this.D.rateRain, rateHat, m);
    this.slotPluie = Math.max(1, Math.round(this.beat / M.subdiv));

    // VAGUE : période de houle ↔ un kick par beat
    const vg = mm.vague || { on: false };
    // params de timbre de la voix vague (cf VAGUE_DEFAULTS) : pilotables pour
    // l'auto-tuning ; absents → défauts → rendu inchangé.
    this.vagueP = { ...VAGUE_DEFAULTS, ...(vg.params || {}) };
    this.vague = {
      on: !!vg.on,
      houle: vg.houle ?? 10, taille: vg.taille ?? 0.6, ressac: vg.ressac ?? 0.4,
      rate: loglerp(1 / clamp(vg.houle ?? 10, 3, 30), M.bpm / 60, m),
      slot: this.beat,
    };
    // ressac : LE cœur des petites vagues — écume médium continue qui RESPIRE
    // (le va-et-vient de la plage, mesuré : swell à ~0.39 Hz, profondeur 0.65).
    // Deux bandes décorrélées G/D pour la largeur stéréo ; + une bande HF
    // optionnelle (« l'air » d'écume) qui PARTAGE le bruit de la bande médium →
    // AUCUN tirage RNG en plus (déterminisme). Coeffs reconstruits seulement si
    // le timbre change (sinon on garde l'état des filtres : pas de clic au tweak).
    const vp = this.vagueP;
    const rsig = `${vp.ressacF},${vp.ressacQ},${vp.ressacHissF},${vp.ressacHissQ}`;
    if (!this.ressacB1 || this._lastFs !== this.fs || this._ressacSig !== rsig) {
      const c = bandpassCoeffs(vp.ressacF, vp.ressacQ, this.fs);
      this.ressacB1 = new Biquad(c); this.ressacB2 = new Biquad(c);
      this.ressacB1r = new Biquad(c); this.ressacB2r = new Biquad(c);
      const ch = bandpassCoeffs(vp.ressacHissF, vp.ressacHissQ, this.fs);
      this.ressacHL = new Biquad(ch); this.ressacHR = new Biquad(ch);
      this._ressacSig = rsig; this._lastFs = this.fs;
      if (this.swellPhase === undefined) this.swellPhase = 0;
    }
    this.ressacGain = this.vague.on ? (0.18 + 0.5 * this.vague.ressac) * 0.62 * this.gNat : 0;
    this.swellInc = (TWO_PI * vp.swellHz) / this.fs;   // recalé avec jitter dans process

    // ORAGE : coups de foudre en Poisson ↔ crash toutes les 2 mesures
    const og = mm.orage || { on: false };
    this.orage = {
      on: !!og.on,
      distance: og.distance ?? 0.8, traine: og.traine ?? 2.5,
      rate: loglerp(Math.max(0.5, og.activite ?? 4) / 60, M.bpm / 60 / 8, m),
      slot: this.beat * 8,
    };

    // VENT : voix continue (turbulence + sifflement ↔ riser sur 2 mesures)
    const vt = mm.vent || { on: false };
    this.vent = { on: !!vt.on, force: vt.force ?? 0.6, rafales: vt.rafales ?? 0.5 };
    if (!this.wind) this.wind = new WindVoice(this.fs, this.seed);
    this.wind.set(this.vent.force, this.vent.rafales, vt.sifflement ?? 0.35,
      this.gNat, this.gPerc);
    // le module VENT pilote la respiration de la nappe quand il est actif
    this.gustDepthDb = 1.2 + 4 * (this.vent.on ? this.vent.rafales : (M.gustDepth ?? 0.3));

    // normalisation analytique de loudness : puissance attendue totale
    const gn2 = this.gNat * this.gNat, gp2 = this.gPerc * this.gPerc;
    let P = 0;
    if (this.pluieOn) {
      P += gn2 * this.D.washPower * M.wash * M.wash
        + this.ratePluie * (gn2 * this.D.meanDropE + gp2 * TICK_ENERGY);
    }
    if (this.vague.on) {
      // la bande HF ajoute ~ressacHiss² à la puissance du ressac (×1 si hiss=0)
      P += this.vague.rate * (gn2 * waveEnergy(this.vague.taille) + gp2 * KICK_ENERGY)
        + this.ressacGain * this.ressacGain * 2 * (1 + this.vagueP.ressacHiss * this.vagueP.ressacHiss);
    }
    if (this.orage.on) {
      P += this.orage.rate * (gn2 * thunderEnergy(this.orage.distance, this.orage.traine)
        + gp2 * 0.8 * crashEnergy(this.orage.traine));
    }
    if (this.vent.on) P += windPower(this.vent.force, this.gNat, this.gPerc);
    this.makeupTarget = clamp(TARGET_RMS / Math.sqrt(Math.max(P, 1e-10)), 0.02, 40);
  }

  _onMessage(d) {
    switch (d.type) {
      case 'params':
        this.macros = d.macros;
        this.master = d.macros.master;
        this._rebuild();
        break;
      case 'play':
        if (d.seed != null) this.seed = d.seed >>> 0;
        this._reset();
        this.makeup = this.makeupTarget;
        this.playing = true;
        break;
      case 'stop':
        this.playing = false;
        break;
      case 'seed':
        this.seed = d.seed >>> 0;
        this._reset();
        break;
    }
  }

  // prochain événement d'un module : renouvellement Gamma (CV = 1-r), puis
  // attraction continue vers le slot de grille le plus proche ("soft snap").
  // Les slots sont des multiples de slotSamples depuis l'horloge 0 → tous les
  // modules snappés tombent en phase.
  _schedule(st, rate, slotSamples, swing = 0) {
    const k = shapeFromRegularity(this.regularity);
    rate = Math.max(rate, 1e-3);
    const ioi = k >= 1e5 ? 1 / rate : this.rng.gamma(k) / (rate * k);
    let tNext = st.next + Math.max(1, Math.round(ioi * this.fs));
    if (this.snap > 0 && slotSamples > 1) {
      let slot = Math.round(tNext / slotSamples);
      if (slot <= st.lastSlot) slot = st.lastSlot + 1;
      tNext = Math.round(lerp(tNext, slot * slotSamples, this.snap));
      st.pendingSlot = slot;
    } else {
      st.pendingSlot = -1;
    }
    st.count++;
    if (swing > 0 && st.count % 2 === 1) {
      tNext += Math.round(swing * 0.5 * slotSamples);
    }
    st.next = Math.max(tNext, this.clock + 1);
  }

  // ---------- PLUIE : une goutte physique et/ou un tick hi-hat ----------
  _trigPluie() {
    const M = this.macros, D = this.D, rng = this.rng;
    const rt = { bufL: this.bufL, bufR: this.bufR, mask: MASK, fs: this.fs, rng };

    // position dans le disque proche : 1/r, pan en azimut
    const rr = D.nearR * Math.sqrt(rng.uniform());
    const az = rng.uniform() * 2 * Math.PI;
    const path = Math.max(Math.hypot(rr, 1.5), 1.0);
    const pan = clamp(((rr * Math.cos(az)) / path) * D.panWidth * (1 - 0.7 * M.morph), -1, 1);
    const th = (Math.PI / 4) * (pan + 1);
    const gL = Math.cos(th), gR = Math.sin(th);

    // diamètre tiré de la CDF inverse du flux Marshall-Palmer résolu
    const u = rng.uniform() * 64;
    const k0 = Math.min(63, Math.floor(u));
    const dMm = D.invCdf[k0] + (u - k0) * (D.invCdf[k0 + 1] - D.invCdf[k0]);
    const hard = rng.uniform() < M.surface;

    let ev = null;
    if (this.gNat > 1e-3) {
      const meta = renderDrop(rt, this.clock, dMm, this.gNat / path, gL, gR, hard);
      const pathMax = Math.hypot(D.nearR, 1.5);
      ev = {
        d: dMm, pan,
        dist: clamp((path - 1.5) / (pathMax - 1.5 + 1e-6), 0, 1),
        // mapping linéaire calé pour que seul un vrai monstre proche sature
        energy: clamp(meta.energy * 2.0, 0.04, 1),
        kind: hard ? 'hard' : 'water',
        bloopF: meta.bloopF,
      };
    }
    if (this.gPerc > 1e-3) {
      const g = synthTick(M.brill, this.fs, rng);
      for (let i = 0; i < g.length; i++) {
        const idx = (this.clock + i) & MASK;
        this.bufL[idx] += g[i] * this.gPerc * gL;
        this.bufR[idx] += g[i] * this.gPerc * gR;
      }
      if (!ev) ev = { d: dMm, pan, dist: 0.2, energy: 0.8, kind: 'tick', bloopF: 0 };
      else if (this.gPerc > this.gNat) ev.kind = 'tick';
    }
    if (ev) this.evQueue.push(ev);
  }

  // ---------- VAGUE : un déferlement et/ou un kick 808 ----------
  _trigVague() {
    const rng = this.rng;
    const rt = { bufL: this.bufL, bufR: this.bufR, mask: MASK, fs: this.fs, rng };
    const taille = this.vague.taille;
    if (this.gNat > 1e-3) {
      // déferlement large (légèrement décentré, masse au milieu) — ACCENT
      // discret sur le ressac : pour des petites vagues, c'est le va-et-vient
      // continu qui domine, pas le déferlement isolé (sinon pompage on/off)
      const pan = (rng.uniform() * 2 - 1) * 0.25;
      const th = (Math.PI / 4) * (pan + 1);
      synthWaveBreak(rt, this.clock, taille, this.gNat * 0.12, Math.cos(th), Math.sin(th), this.vagueP);
      this.evQueue.push({ kind: 'wave', energy: clamp(0.3 + taille, 0, 1), pan, d: 0, dist: 0, bloopF: 0 });
    }
    if (this.gPerc > 1e-3) {
      synthKick(rt, this.clock, this.gPerc * (0.6 + 0.6 * taille), 0.71, 0.71);
      this.evQueue.push({ kind: 'kick', energy: 0.9, pan: 0, d: 0, dist: 0, bloopF: 0 });
    }
  }

  // ---------- ORAGE : éclair maintenant, tonnerre d/343 s plus tard ----------
  _trigOrage() {
    const rng = this.rng;
    const dist = this.orage.distance * (0.6 + 0.8 * rng.uniform());
    const pan = (rng.uniform() * 2 - 1) * 0.8;
    // le flash visuel part IMMÉDIATEMENT — la lumière va plus vite que le son
    this.evQueue.push({
      kind: 'strike', pan, d: 0, bloopF: 0,
      dist: clamp(dist / 3, 0, 1),
      energy: clamp(1.4 / (0.6 + dist), 0.2, 1),
    });
    if (this.gNat > 1e-3) {
      const delay = Math.min(4, (dist * 1000) / 343) * (1 - clamp(this.macros.morph, 0, 1));
      this.st.orage.queue.push({ at: this.clock + Math.round(delay * this.fs), dist });
    }
    if (this.gPerc > 1e-3) {
      const rt = { bufL: this.bufL, bufR: this.bufR, mask: MASK, fs: this.fs, rng };
      const tilt = 0.1 * (rng.uniform() * 2 - 1);
      synthCrash(rt, this.clock, this.orage.traine, this.macros.brill,
        this.gPerc * 0.9, 0.71 - tilt, 0.71 + tilt);
      this.evQueue.push({ kind: 'crash', pan: 0, d: 0, dist: 0, bloopF: 0, energy: 0.9 });
    }
  }

  // une marche d'une chaîne de nappe : Σ bandes filtrées, puis LP d'air
  _washChain(chain, rng, side) {
    let s = 0;
    for (const f of chain) s += f.b2.tick(f.b1.tick(rng.gauss())) * f.gain;
    if (side === 0) { this.washLPL += this.washLPa * (s - this.washLPL); return this.washLPL; }
    this.washLPR += this.washLPa * (s - this.washLPR); return this.washLPR;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    if (!this.playing) { L.fill(0); if (R !== L) R.fill(0); return true; }

    const M = this.macros;
    const washGain = this.pluieOn ? this.gNat * M.wash : 0;
    const stP = this.st.pluie, stV = this.st.vague, stO = this.st.orage;

    // tonnerres en attente (le retard distance/343) : précision au bloc
    if (this.orage.on && stO.queue.length) {
      const due = [];
      stO.queue = stO.queue.filter((q) => (q.at <= this.clock + 127 ? (due.push(q), false) : true));
      const rt = { bufL: this.bufL, bufR: this.bufR, mask: MASK, fs: this.fs, rng: this.rng };
      for (const q of due) {
        const tilt = 0.15 * (this.rng.uniform() * 2 - 1);
        synthThunder(rt, Math.max(q.at, this.clock), q.dist, this.orage.traine,
          this.gNat, 0.71 - tilt, 0.71 + tilt);
      }
    }

    for (let j = 0; j < L.length; j++) {
      if (this.pluieOn) {
        while (this.clock >= stP.next) {
          this._trigPluie();
          if (stP.pendingSlot >= 0) stP.lastSlot = stP.pendingSlot;
          this._schedule(stP, this.ratePluie, this.slotPluie, M.swing);
        }
      }
      if (this.vague.on) {
        while (this.clock >= stV.next) {
          this._trigVague();
          if (stV.pendingSlot >= 0) stV.lastSlot = stV.pendingSlot;
          this._schedule(stV, this.vague.rate, this.vague.slot);
        }
      }
      if (this.orage.on) {
        while (this.clock >= stO.next) {
          this._trigOrage();
          if (stO.pendingSlot >= 0) stO.lastSlot = stO.pendingSlot;
          this._schedule(stO, this.orage.rate, this.orage.slot);
        }
      }
      const idx = this.clock & MASK;
      let sl = this.bufL[idx], sr = this.bufR[idx];
      this.bufL[idx] = 0; this.bufR[idx] = 0;

      // rafales : marche aléatoire très lente (le module VENT règle la profondeur)
      this.gustLP += 1.5e-5 * (this.gustRng.gauss() * 30 - this.gustLP);
      this.gust = clamp(this.gustLP, -1, 1);
      if (washGain > 1e-4) {
        const am = Math.pow(10, (this.gustDepthDb * this.gust) / 20) * washGain;
        sl += this._washChain(this.washL, this.washRngL, 0) * am;
        sr += this._washChain(this.washR, this.washRngR, 1) * am;
      }
      if (this.ressacGain > 1e-5) {
        // swell quasi-périodique : la vague enfle et se retire (~0.39 Hz),
        // période rejitterée à chaque cycle (étale le pic, pas un sinus pur)
        const vp = this.vagueP;
        this.swellPhase += this.swellInc;
        if (this.swellPhase >= TWO_PI) {
          this.swellPhase -= TWO_PI;
          // NB (revue #5, LOW) : ce rejitter puise dans washRngR, partagé avec le
          // wash-droite de la PLUIE. En mix complet, faire varier swellHz change
          // donc le nombre de tirages et décale le bruit de pluie-droite. Le
          // déterminisme PAR GRAINE est préservé (et l'auto-tuner isole le module,
          // donc sans effet ici) ; on l'assume pour garder le rendu byte-identique.
          this.swellInc = (TWO_PI * clamp(vp.swellHz * Math.exp(0.3 * this.washRngR.gauss()), 0.2, 0.7)) / this.fs;
        }
        // profondeur douce (mesuré : le ressac réel respire à ~0.65, pas en on/off)
        const swell = vp.swellFloor + vp.swellDepth * (0.5 + 0.5 * Math.sin(this.swellPhase)) * (1 + 0.2 * this.gust);
        // un seul tirage par canal ; la bande HF réutilise le même bruit
        const nl = this.washRngL.gauss(), nr = this.washRngR.gauss();
        let wl = this.ressacB2.tick(this.ressacB1.tick(nl));
        let wr = this.ressacB2r.tick(this.ressacB1r.tick(nr));
        if (vp.ressacHiss > 0) {
          wl += vp.ressacHiss * this.ressacHL.tick(nl);
          wr += vp.ressacHiss * this.ressacHR.tick(nr);
        }
        sl += wl * this.ressacGain * swell;
        sr += wr * this.ressacGain * swell;
      }
      if (this.vent.on) {
        const phase = (this.clock % (this.beat * 8)) / (this.beat * 8);
        this.riserPhase = phase;
        const [wl, wr] = this.wind.tick(this.gust, phase);
        sl += wl; sr += wr;
      }

      // makeup lissé (≈ 8 ms) puis limiteur doux tanh
      this.makeup += 0.0002 * (this.makeupTarget - this.makeup);
      const g = this.makeup * this.master;
      L[j] = 0.95 * Math.tanh((sl * g) / 0.95);
      R[j] = 0.95 * Math.tanh((sr * g) / 0.95);
      this.clock++;
      this.teleCount++;
    }

    if (this.evQueue.length) {
      this.port.postMessage({ type: 'drops', events: this.evQueue });
      this.evQueue = [];
    }
    if (this.teleCount >= TELE_EVERY) {
      this.teleCount = 0;
      this.port.postMessage({
        type: 'tele',
        wash: clamp(Math.sqrt(this.D.washPower) * washGain * this.makeup * 5, 0, 1),
        gust: this.gust,
        riser: this.vent.on && this.gPerc > 1e-3 ? (this.riserPhase ?? 0) : 0,
        level: clamp(this.makeup * Math.sqrt(
          this.D.washPower * washGain * washGain + this.ratePluie * this.D.meanDropE) * 4, 0, 1),
      });
    }
    return true;
  }
}

registerProcessor('rain-processor', RainProcessor);
