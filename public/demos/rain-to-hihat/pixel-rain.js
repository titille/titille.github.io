// Animation pixel art plein écran pilotée par la physique : résolution
// interne adaptative (≈ 1 pixel-scène pour 5 px CSS), upscale nearest-neighbor
// à l'échelle ENTIÈRE en pixels machine, palette limitée qui morphe
// cyan (pluie) → ambre (métal hi-hat).
//
// Le pont son→image : chaque goutte AUDIBLE résolue par le worklet arrive ici
// (onDrops) et dessine SON splash — ondes concentriques sur l'eau, gerbe de
// spray sur surface dure, blink différé pour la bulle (le "bloop"). La nappe
// de Campbell (gouttes non résolues) devient la brume de fond (onTele).

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a, b, m) => a + (b - a) * m;

// --- palettes (8 crans chacune), mixées par BRILLANCE/MÉTAL ---
const RAMP_RAIN = ['#05080f', '#0a1422', '#12283c', '#1c4258', '#2f6f86', '#54aabf', '#9fe5f2', '#eaffff'];
const RAMP_METAL = ['#0b0704', '#1a120a', '#2e1f0e', '#4c3010', '#7a4f16', '#b97f24', '#eab63f', '#fff0c0'];
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const RAIN_RGB = RAMP_RAIN.map(hex2rgb);
const METAL_RGB = RAMP_METAL.map(hex2rgb);

const BAYER4 = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
];

export class PixelRain {
  // opts.bottomInset() : hauteur (px CSS) du dock HUD qui recouvre le bas —
  // la zone d'eau et les splashs restent au-dessus pour rester visibles.
  constructor(canvas, opts = {}) {
    this.display = canvas;
    this.dctx = canvas.getContext('2d');
    this.low = document.createElement('canvas');
    this.ctx = this.low.getContext('2d');
    this.bottomInset = opts.bottomInset || (() => 0);

    this.P = {
      morph: 0, intensity: 10, sizeBias: 0, regularity: 0, surface: 0,
      space: 0.5, wash: 0.8, wind: 0.3, brill: 0, playing: false,
      mods: { pluie: { on: true }, vague: { on: false, houle: 10, taille: 0.6 } },
    };
    this.tele = { wash: 0.3, gust: 0 };
    this.pal = [];
    this.palCss = [];
    this._mixPalette(0);

    this.streaksFar = [];            // {x, y, len, spd}
    this.streaksNear = [];           // {x, y, len, spd, fat, dieAt}
    this.rings = [];                 // {x, y, r, rMax, life, life0, bright}
    this.sprays = [];                // {x, y, vx, vy, life, bright}
    this.blotches = [];              // {x, y, w, life}
    this.blinks = [];                // {x, y, delay, life, bright, big}
    this.ticks = [];                 // {x, life, life0}
    this.swells = [];                // déferlantes localisées : {xc, w, t, dur, amp}
    this.foamDots = [];              // écume résiduelle : {x, vx, life}
    this.bolts = [];                 // éclairs : {pts, branches, life, life0}
    this.crashGlow = 0;              // lueur dorée après une crash (s)
    this.wisps = [];                 // volutes de vent : {trail, x, y0, vx, phase, amp}
    this.windAcc = 0;
    this.windVx = 0;                 // vitesse horizontale du vent (px scène/s)
    this.bumpFrames = 0;             // secousse d'écran du kick
    this.groundFlash = 0;            // flash de la ligne d'eau (kick)
    this.flashFrames = 0;            // flash global (éclair / crash)
    this.spawnAcc = 0;
    this.splashTokens = 8;           // budget de splashs visibles (anti-bouillie)

    this.W = 4; this.H = 4; this.horizon = 2; this.bottom = 3;
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this.resize = () => this._resize();   // re-mesure (le dock change de taille)

    this.t = 0;
    this._last = performance.now();
    requestAnimationFrame(() => this._frame());
  }

  // résolution interne : échelle entière en PIXELS MACHINE, ~1 cellule pour
  // 5-6 px CSS — la scène couvre tout l'écran sans bande noire.
  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(64, Math.round(window.innerWidth * dpr));
    const bh = Math.max(64, Math.round(window.innerHeight * dpr));
    this.scale = Math.max(3, Math.round(bh / 150));
    this.W = Math.ceil(bw / this.scale);
    this.H = Math.ceil(bh / this.scale);
    this.low.width = this.W;
    this.low.height = this.H;
    this.display.width = bw;
    this.display.height = bh;
    const insetScene = Math.ceil((this.bottomInset() * dpr) / this.scale);
    this.bottom = Math.max(20, this.H - insetScene - 2);
    this.horizon = Math.round(this.bottom * 0.74);

    this.shimmer = new Float32Array(this.W);
    for (let i = 0; i < this.W; i++) this.shimmer[i] = Math.random() * Math.PI * 2;
    this.asphalt = [];
    const arng = mulberry(0x51133);
    const nSpeck = Math.round(this.W * (this.H - this.horizon) * 0.03);
    for (let i = 0; i < nSpeck; i++) {
      this.asphalt.push([Math.floor(arng() * this.W), this.horizon + Math.floor(arng() * (this.H - this.horizon)), arng()]);
    }
  }

  setParams(p) {
    Object.assign(this.P, p);
    this._mixPalette(clamp(this.P.brill ?? this.P.morph, 0, 1));
  }
  onTele(t) { this.tele = t; }

  // une goutte audible = un splash — synchronisation forte son↔image.
  // L'inverse n'est pas exigé : au-delà du budget visuel (~40 splashs/s),
  // les petites gouttes sont sautées pour que l'eau reste lisible — les gros
  // plops passent toujours.
  onDrops(events) {
    for (const ev of events) {
      if (ev.kind === 'tick') {
        this.ticks.push({ x: this._panX(ev.pan, 0.2), life: 0.16, life0: 0.16 });
        continue;
      }
      if (ev.kind === 'wave') {
        // déferlante localisée : la houle gonfle, casse en écume, puis s'étale
        const depthScale = clamp((this.bottom - this.horizon) / 30, 0.35, 1);
        this.swells.push({
          xc: this.W * (0.15 + 0.7 * Math.random()),
          w: 26 + 36 * ev.energy,
          t: 0, dur: 2.0,
          amp: (3.5 + 5 * ev.energy) * depthScale,
        });
        continue;
      }
      if (ev.kind === 'kick') {
        this.bumpFrames = 2;
        this.groundFlash = 2;
        continue;
      }
      if (ev.kind === 'strike') {
        // l'éclair flashe MAINTENANT — le tonnerre arrivera d/343 s après
        this.bolts.push(this._makeBolt(this._panX(ev.pan, 0), ev.energy));
        this.flashFrames = Math.min(4, 2 + Math.round(ev.energy * 2));
        continue;
      }
      if (ev.kind === 'crash') {
        this.flashFrames = 3;
        this.crashGlow = 0.35;
        continue;
      }
      // budget strict : pas de bypass — quand le plafond de résolution mord,
      // toutes les gouttes résolues sont "grosses", un bypass laisserait tout passer
      if (this.splashTokens < 1) continue;
      this.splashTokens -= 1;
      const y = this._waterY(ev.dist);
      const x = this._panX(ev.pan, ev.dist);
      // parallaxe (proche = gros) × adaptation à la profondeur d'eau visible
      const depthScale = clamp((this.bottom - this.horizon) / 30, 0.35, 1);
      const scale = (1.45 - 0.85 * ev.dist) * depthScale;
      if (ev.kind === 'hard') {
        const n = Math.round(4 + ev.d * 2.5);
        for (let i = 0; i < n; i++) {
          this.sprays.push({
            x, y, vx: (Math.random() * 2 - 1) * (14 + ev.d * 8) * scale,
            vy: -(18 + Math.random() * 30 + ev.d * 10) * scale,
            life: 0.28 + Math.random() * 0.15, bright: ev.energy,
          });
        }
        this.blotches.push({ x, y, w: Math.round((2 + ev.d) * scale), life: 1.6 });
      } else {
        const life = 0.26 + 0.07 * ev.d;
        this.rings.push({
          x, y, r: 0.6,
          rMax: Math.min(11, (1.6 + ev.d * 1.5) * scale),
          life, life0: life,
          bright: ev.energy,
        });
        if (ev.d >= 3.5) {                            // couronne des très gros impacts
          for (let i = 0; i < 3; i++) {
            this.sprays.push({
              x, y, vx: (Math.random() * 2 - 1) * 10 * scale,
              vy: -(22 + Math.random() * 18) * scale,
              life: 0.22, bright: ev.energy * 0.8,
            });
          }
        }
        if (ev.bloopF > 0) {
          // la bulle sonne quelques ms après l'impact → blink différé,
          // gros bloop grave = blink plus gros et plus long
          const big = ev.bloopF < 6000;
          this.blinks.push({ x, y, delay: big ? 0.04 : 0.012, life: big ? 0.22 : 0.1, bright: ev.energy, big });
        }
      }
      // l'éclair de chute : une traînée courte juste au-dessus de l'impact
      this.streaksNear.push({
        x, y: y - 14 - Math.random() * 8,
        len: (5 + ev.d * 1.6) * clamp(depthScale + 0.3, 0.5, 1),
        spd: 320 * (this.H / 135), fat: ev.d > 3.5, dieAt: y,
      });
    }
  }

  _panX(pan, dist) {
    // le pan physique reste concentré (gouttes surtout au-dessus de la tête) :
    // on l'étire pour occuper la largeur de la scène
    const p = clamp(pan * 1.9, -1, 1);
    const halfW = (this.W / 2 - 6) * (1 - 0.25 * dist);
    return Math.round(this.W / 2 + p * halfW);
  }
  _waterY(dist) { return Math.round(this.bottom - 2 - dist * (this.bottom - this.horizon - 4)); }

  _mixPalette(t) {
    this.pal = RAIN_RGB.map((c, i) => [
      Math.round(lerp(c[0], METAL_RGB[i][0], t)),
      Math.round(lerp(c[1], METAL_RGB[i][1], t)),
      Math.round(lerp(c[2], METAL_RGB[i][2], t)),
    ]);
    this.palCss = this.pal.map((c) => `rgb(${c[0]},${c[1]},${c[2]})`);
  }

  // ---------- boucle ----------
  _frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this.t += dt;
    this._step(dt);
    this._draw();
    this._blit();
    requestAnimationFrame(() => this._frame());
  }

  _step(dt) {
    const P = this.P, tele = this.tele;
    const m = clamp(P.morph, 0, 1);
    const vScale = this.H / 135;     // vitesses calées sur la hauteur de scène
    // budget de splashs ∝ surface d'eau visible (une scène étroite ou un dock
    // haut laissent moins de place : moins de splashs simultanés)
    const splashRate = clamp((this.W * Math.max(8, this.bottom - this.horizon)) / 260, 6, 34);
    this.splashTokens = Math.min(6, this.splashTokens + splashRate * dt);

    // vent : vitesse horizontale partagée (traînées, embruns, dérive) — bien
    // marquée quand le module VENT est actif, légère respiration sinon
    const vt = P.mods?.vent;
    const ventOn = !!(vt && vt.on);
    this.windVx = (ventOn
      ? (20 + 150 * (vt.force ?? 0.6)) * (0.55 + 0.45 * tele.gust)
      : 16 * tele.gust) * (this.W / 240);

    // pluie ambiante (les gouttes NON résolues — la brume qui tombe) :
    // densité ∝ intensité × largeur de scène, s'efface vers le hi-hat.
    // Module PLUIE décoché = plus une goutte à l'écran.
    if (P.playing && m < 0.97 && P.mods?.pluie?.on !== false) {
      const rate = (16 + P.intensity * 5.2) * (1 - m) * (this.W / 240);
      this.spawnAcc += rate * dt;
      while (this.spawnAcc >= 1) {
        this.spawnAcc -= 1;
        const far = Math.random() < lerp(0.45, 0.75, P.space);
        const x = this._spawnX();
        if (far) this.streaksFar.push({ x, y: -4 - Math.random() * 20, len: 3 + Math.random() * 2, spd: (150 + Math.random() * 40) * vScale });
        else this.streaksNear.push({ x, y: -6 - Math.random() * 24, len: 5 + Math.random() * 3 + P.sizeBias * 2, spd: (260 + Math.random() * 70) * vScale, fat: Math.random() < 0.2 + 0.3 * Math.max(0, P.sizeBias), dieAt: 0 });
      }
    }

    // la chute dérive avec le vent (les gouttes rapides portent plus loin)
    const fall = (s) => { s.y += s.spd * dt; s.x += this.windVx * dt * (s.spd / (300 * vScale)); };
    for (const s of this.streaksFar) fall(s);
    for (const s of this.streaksNear) fall(s);
    this.streaksFar = this.streaksFar.filter((s) => s.y < this.horizon + 4);
    // une traînée ambiante qui touche l'eau fait une mini-onde (pas de son :
    // c'est la pluie non résolue, son énergie est déjà dans la nappe)
    this.streaksNear = this.streaksNear.filter((s) => {
      const ground = s.dieAt || this.bottom - 1 - Math.random() * (this.bottom - this.horizon) * 0.7;
      if (s.y >= ground) {
        if (!s.dieAt && Math.random() < 0.35 && m < 0.8) {
          this.rings.push({ x: Math.round(s.x), y: Math.round(ground), r: 0.5, rMax: 1.8, life: 0.2, life0: 0.2, bright: 0.25 });
        }
        return false;
      }
      return true;
    });

    for (const r of this.rings) { r.life -= dt; r.r = Math.min(r.rMax, r.r + (r.rMax / r.life0) * dt * 1.15); }
    this.rings = this.rings.filter((r) => r.life > 0);

    for (const s of this.sprays) { s.life -= dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 230 * vScale * dt; }
    this.sprays = this.sprays.filter((s) => s.life > 0 && s.y < this.H);

    for (const b of this.blotches) b.life -= dt;
    this.blotches = this.blotches.filter((b) => b.life > 0);

    for (const b of this.blinks) { if (b.delay > 0) b.delay -= dt; else b.life -= dt; }
    this.blinks = this.blinks.filter((b) => b.life > 0);

    for (const tk of this.ticks) tk.life -= dt;
    this.ticks = this.ticks.filter((tk) => tk.life > 0);

    // déferlantes : la bosse gonfle puis casse — pendant la casse, l'écume
    // gicle au sommet ; pendant l'étalement, elle s'élargit le long de l'eau
    for (const sw of this.swells) {
      sw.t += dt;
      const p = sw.t / sw.dur;
      if (p > 0.38 && p < 0.85) {
        for (let i = 0; i < 2; i++) {
          this.foamDots.push({
            x: sw.xc + (Math.random() - 0.5) * sw.w * (p < 0.62 ? 0.6 : 1.3),
            vx: (Math.random() - 0.5) * 16,
            life: 0.45 + Math.random() * 0.4,
          });
        }
      }
    }
    this.swells = this.swells.filter((sw) => sw.t < sw.dur);
    for (const d2 of this.foamDots) { d2.life -= dt; d2.x += d2.vx * dt; }
    this.foamDots = this.foamDots.filter((d2) => d2.life > 0);

    for (const b of this.bolts) b.life -= dt;
    this.bolts = this.bolts.filter((b) => b.life > 0);
    if (this.crashGlow > 0) this.crashGlow -= dt;

    // volutes de VENT : quelques filets sinueux qui serpentent à travers la
    // scène en laissant une traînée courbe (pas des traits de pluie couchée)
    if (ventOn && P.playing && m < 0.9 && this.wisps.length < 10) {
      this.windAcc += (0.7 + 2.2 * (vt.force ?? 0.6)) * dt;
      const dir = this.windVx >= 0 ? 1 : -1;
      while (this.windAcc >= 1) {
        this.windAcc -= 1;
        this.wisps.push({
          x: dir > 0 ? -4 : this.W + 4,
          y0: 5 + Math.random() * Math.max(10, this.horizon * 0.9),
          vx: dir * (45 + 130 * (vt.force ?? 0.6)) * (0.7 + Math.random() * 0.6) * (this.W / 240),
          phase: Math.random() * Math.PI * 2,
          amp: 1.5 + 2.5 * Math.random(),
          trail: [],
        });
      }
    }
    for (const wsp of this.wisps) {
      wsp.x += wsp.vx * dt;
      wsp.phase += dt * (3.5 + 3 * (vt?.force ?? 0));
      const y = wsp.y0 + Math.sin(wsp.phase) * wsp.amp + Math.sin(wsp.phase * 0.37) * wsp.amp * 0.6;
      wsp.trail.push([Math.round(wsp.x), Math.round(y)]);
      if (wsp.trail.length > 16) wsp.trail.shift();
    }
    this.wisps = this.wisps.filter((wsp) =>
      (wsp.vx > 0 ? wsp.x < this.W + 20 : wsp.x > -20));
  }

  // éclair : marche aléatoire descendante du ciel à l'eau + 1-2 branches
  _makeBolt(x0, energy) {
    const pts = [];
    let x = x0, y = 1;
    while (y < this.horizon - 1) {
      pts.push([Math.round(x), Math.round(y)]);
      y += 2 + Math.random() * 3;
      x += (Math.random() * 2 - 1) * 3;
    }
    const branches = [];
    for (let b = 0; b < 2; b++) {
      const i0 = Math.floor(pts.length * (0.25 + 0.4 * Math.random()));
      if (!pts[i0]) continue;
      let [bx, by] = pts[i0];
      const dir = Math.random() < 0.5 ? -1 : 1;
      const bpts = [];
      for (let s = 0; s < 4 + Math.random() * 3; s++) {
        bx += dir * (1 + Math.random() * 2);
        by += 1 + Math.random() * 2.5;
        bpts.push([Math.round(bx), Math.round(by)]);
      }
      branches.push(bpts);
    }
    const life = 0.3 + 0.15 * energy;
    return { pts, branches, life, life0: life };
  }

  // enveloppe d'une déferlante : gonfle → tient (la lèvre) → s'effondre
  _swellEnv(p) {
    if (p < 0.45) { const u = p / 0.45; return u * u * (3 - 2 * u); }
    if (p < 0.62) return 1;
    return Math.max(0, 1 - (p - 0.62) / 0.22);
  }

  // ligne d'eau : plate, ou houle organique (2 sinusoïdes superposées qui se
  // croisent) + les bosses locales des déferlantes en cours
  _waterlineY(x) {
    const v = this.P.mods?.vague;
    if (!v || !v.on) { this.wlA = 0; return this.horizon; }
    const m = clamp(this.P.morph, 0, 1);
    const depthScale = clamp((this.bottom - this.horizon) / 30, 0.35, 1);
    const A = (v.taille ?? 0.6) * 2.4 * (1 - m) * depthScale * (1 - this.P.surface);
    this.wlA = A;
    if (A < 0.4) return this.horizon;
    const om = (Math.PI * 2 / Math.max(4, v.houle ?? 10)) * 2.2;
    let y = Math.sin((x * Math.PI * 2) / 52 + this.t * om) * A
      + Math.sin((x * Math.PI * 2) / 23 - this.t * om * 1.7) * A * 0.45;
    for (const sw of this.swells) {
      const dx = x - sw.xc;
      if (Math.abs(dx) < sw.w / 2) {
        const prof = Math.cos((Math.PI * dx) / sw.w);
        y -= sw.amp * this._swellEnv(sw.t / sw.dur) * prof * prof;
      }
    }
    return this.horizon + Math.round(y);
  }

  // position x de spawn : aléatoire → colonnes alignées quand RÉGULARITÉ → 1
  _spawnX() {
    const xr = Math.random() * this.W;
    const r = this.P.regularity ?? this.P.morph;
    if (r <= 0.02) return xr;
    const colW = Math.max(10, this.W / Math.round(this.W / 18));
    const col = Math.round(xr / colW) * colW;
    return lerp(xr, col, r * r);
  }

  // ---------- dessin (tout sur le canvas basse résolution, entiers) ----------
  _draw() {
    const ctx = this.ctx, P = this.P, pal = this.palCss;
    const W = this.W, H = this.H, HOR = this.horizon;
    const m = clamp(P.morph, 0, 1);
    const mist = clamp(this.tele.wash * P.wash * (1 - m), 0, 1);

    // ciel : 3 bandes ditherées (Bayer 4×4) qui s'éclaircissent vers l'horizon
    ctx.fillStyle = pal[0];
    ctx.fillRect(0, 0, W, H);
    this._ditherBand(0, Math.round(HOR * 0.34), 1, 0.35);
    this._ditherBand(Math.round(HOR * 0.34), Math.round(HOR * 0.7), 1, 0.5 + mist * 0.3);
    this._ditherBand(Math.round(HOR * 0.7), HOR, 2, 0.4 + mist * 0.45);

    // brume de Campbell : bancs horizontaux dérivants en pointillés (pas de
    // ligne pleine — ça lisait comme un glitch), densité ∝ niveau de nappe
    if (mist > 0.02) {
      ctx.fillStyle = pal[2];
      const nBank = Math.max(4, Math.round(H / 26));
      for (let i = 0; i < nBank; i++) {
        const yy = Math.round(HOR * 0.45) + i * Math.round(HOR * 0.55 / nBank);
        const drift = Math.round((this.t * (6 + i * 3) + i * 53 + this.tele.gust * 18) % (W + 80)) - 40;
        const ww = 50 + ((i * 37) % 60);
        if (((i * 17 + Math.floor(this.t * 2)) % 16) / 16 < mist) this._dashes(drift, yy, ww, i);
        if (((i * 29 + Math.floor(this.t * 2.7)) % 16) / 16 < mist * 0.8) this._dashes(W - drift - ww, yy + 5, Math.round(ww * 0.7), i + 5);
      }
    }

    // nuages d'orage : le haut du ciel s'assombrit avec l'activité
    const og = P.mods?.orage;
    if (og && og.on) {
      this._ditherBandColor(0, Math.round(HOR * 0.22), 0, 0.35 + 0.4 * Math.min(1, (og.activite ?? 4) / 8));
    }

    // éclairs : 2 premières frames pleines + decay (dessinés avant le sol
    // pour que la houle/l'eau les masque proprement)
    for (const b of this.bolts) {
      const a = b.life / b.life0;
      const fresh = a > 0.65;
      ctx.fillStyle = pal[fresh ? 7 : a > 0.3 ? 5 : 3];
      for (const [px, py] of b.pts) ctx.fillRect(px, py, fresh ? 2 : 1, 3);
      if (fresh || a > 0.45) {
        for (const br of b.branches) for (const [px, py] of br) ctx.fillRect(px, py, 1, 2);
      }
    }

    // surface : eau scintillante ↔ sol dur, crossfade par SURFACE
    this._drawGround(P.surface);

    // volutes de vent : traînées courbes qui serpentent, tête plus claire
    for (const wsp of this.wisps) {
      const tr = wsp.trail;
      for (let i = 0; i < tr.length; i++) {
        ctx.fillStyle = pal[i > tr.length - 4 ? 4 : i > tr.length - 9 ? 3 : 2];
        ctx.fillRect(tr[i][0], tr[i][1], 1, 1);
      }
    }

    // traînées de pluie, DESSINÉES inclinées : l'angle = vent / vitesse de chute
    if (m < 0.97) {
      const drawStreak = (s, w) => {
        const slant = clamp(this.windVx / s.spd, -0.9, 0.9);
        const len = Math.round(s.len);
        for (let k = 0; k < len; k++) {
          ctx.fillRect(Math.round(s.x + slant * k), Math.round(s.y) + k, w, 1);
        }
      };
      ctx.fillStyle = pal[3];
      for (const s of this.streaksFar) drawStreak(s, 1);
      for (const s of this.streaksNear) {
        ctx.fillStyle = s.fat ? pal[6] : pal[5];
        drawStreak(s, s.fat ? 2 : 1);
      }
    }

    // splashs synchronisés : ondes concentriques (ellipses écrasées ×3 en y)
    for (const r of this.rings) {
      const a = r.life / r.life0;
      const ci = a > 0.6 ? 5 : a > 0.3 ? 4 : 3;
      ctx.fillStyle = pal[Math.min(7, ci + (r.bright > 0.7 ? 1 : 0))];
      this._ellipse(r.x, r.y, r.r, Math.max(1, r.r / 3));
    }

    // sprays (surface dure) + gouttelettes de couronne
    for (const s of this.sprays) {
      ctx.fillStyle = pal[s.bright > 0.5 ? 7 : 6];
      ctx.fillRect(Math.round(s.x), Math.round(s.y), 1, 1);
    }

    // taches humides sur sol dur
    ctx.fillStyle = pal[1];
    for (const b of this.blotches) {
      if (b.life > 0.2) ctx.fillRect(b.x - (b.w >> 1), b.y, b.w, 1);
    }

    // blink de la bulle (le bloop entendu = vu)
    ctx.fillStyle = pal[7];
    for (const b of this.blinks) {
      if (b.delay > 0) continue;
      const s = b.big ? 2 : 1;
      ctx.fillRect(b.x - (s >> 1), b.y - (s >> 1), s, s);
    }

    // lèvre d'écume des déferlantes : le sommet de la bosse blanchit pendant
    // la casse, puis l'écume résiduelle s'étale le long de l'eau
    for (const sw of this.swells) {
      const p = sw.t / sw.dur;
      const e = this._swellEnv(p);
      if (e < 0.45 || p < 0.28) continue;
      const half = Math.round(sw.w / 2);
      for (let dx = -half; dx <= half; dx++) {
        const x = Math.round(sw.xc + dx);
        if (x < 0 || x >= W) continue;
        const c = Math.cos((Math.PI * dx) / sw.w);
        const prof = c * c;
        if (prof > 0.5) {
          const yw = this._waterlineY(x);
          ctx.fillStyle = pal[prof > 0.82 && p > 0.4 && p < 0.7 ? 7 : 6];
          ctx.fillRect(x, yw - 1, 1, 1);
        }
      }
    }
    ctx.fillStyle = pal[5];
    for (const d2 of this.foamDots) {
      if (d2.life > 0.12) {
        const xx = Math.round(((d2.x % W) + W) % W);
        ctx.fillRect(xx, this._waterlineY(xx) + 1, 1, 1);
      }
    }

    // flashs de tick hi-hat : colonne de lumière ambre sur la voie du pan
    if (m > 0.05) {
      for (const tk of this.ticks) {
        const a = tk.life / tk.life0;
        ctx.fillStyle = pal[a > 0.6 ? 7 : a > 0.3 ? 6 : 4];
        ctx.globalAlpha = m;
        ctx.fillRect(tk.x, 4, a > 0.6 ? 2 : 1, this.bottom - 8);
        ctx.fillRect(tk.x - 2, HOR - 2, 5, 1);
        ctx.globalAlpha = 1;
      }
    }

    // neige TV du riser : la scène se charge de statique avec la rampe
    const riser = this.tele.riser ?? 0;
    if (riser > 0.05 && m > 0.4) {
      const n = Math.round(riser * riser * ((W * this.bottom) / 420) * m);
      ctx.fillStyle = pal[6];
      for (let i = 0; i < n; i++) {
        ctx.fillRect((Math.random() * W) | 0, (Math.random() * this.bottom) | 0, 1, 1);
      }
    }

    // lueur dorée de crash : shimmer en pointillés en haut de l'écran
    if (this.crashGlow > 0) {
      ctx.fillStyle = pal[6];
      const aG = this.crashGlow / 0.35;
      for (let x = 0; x < W; x += 6) {
        if (((x * 13 + Math.floor(this.t * 30)) % 11) / 11 < aG) ctx.fillRect(x, 3 + (x % 3), 3, 1);
      }
    }

    // flash global (éclair d'orage / crash) : voile clair 1-2 frames
    if (this.flashFrames > 0) {
      ctx.globalAlpha = 0.16 * this.flashFrames;
      ctx.fillStyle = pal[7];
      ctx.fillRect(0, 0, W, this.bottom);
      ctx.globalAlpha = 1;
      this.flashFrames--;
    }
    if (this.groundFlash > 0) this.groundFlash--;
  }

  // segment pointillé (5 px allumés / 3 éteints, phase variée par banc)
  _dashes(x0, y, w, phase) {
    const ctx = this.ctx;
    for (let x = 0; x < w; x += 8) {
      ctx.fillRect(Math.round(x0 + x + (phase % 4)), y, 5, 1);
    }
  }

  _ditherBand(y0, y1, ci, blend) {
    const ctx = this.ctx;
    ctx.fillStyle = this.palCss[ci];
    for (let y = y0; y < y1; y++) {
      const t = blend * ((y - y0) / Math.max(1, y1 - y0));
      for (let x = 0; x < this.W; x += 4) {
        // motif Bayer : on pose des pixels du cran supérieur selon le seuil
        for (let i = 0; i < 4; i++) {
          if (t * 16 > BAYER4[y & 3][(x + i) & 3]) ctx.fillRect(x + i, y, 1, 1);
        }
      }
    }
  }

  // bande ditherée à densité constante (nuages d'orage : assombrir le haut)
  _ditherBandColor(y0, y1, ci, density) {
    const ctx = this.ctx;
    ctx.fillStyle = this.palCss[ci];
    for (let y = y0; y < y1; y++) {
      const t = density * (1 - (y - y0) / Math.max(1, y1 - y0));
      for (let x = 0; x < this.W; x += 4) {
        for (let i = 0; i < 4; i++) {
          if (t * 16 > BAYER4[y & 3][(x + i) & 3]) ctx.fillRect(x + i, y, 1, 1);
        }
      }
    }
  }

  _drawGround(surf) {
    const ctx = this.ctx, pal = this.palCss, HOR = this.horizon;
    const houle = this.P.mods?.vague?.on && surf < 0.6;
    ctx.fillStyle = pal[1];
    ctx.fillRect(0, houle ? HOR + 6 : HOR, this.W, this.H - HOR);
    if (surf < 0.99) {
      ctx.globalAlpha = 1 - surf;
      // ligne d'eau : plate, ou houle qui ondule (remplie colonne par colonne)
      ctx.fillStyle = pal[4];
      if (houle) {
        // corps de l'eau rempli colonne par colonne (les creux laissent voir
        // le ciel), crête éclairée + bande sous-crête plus claire
        const lineC = this.groundFlash > 0 ? pal[6] : pal[4];
        for (let x = 0; x < this.W; x++) {
          const yw = this._waterlineY(x);
          ctx.fillStyle = pal[1];
          ctx.fillRect(x, yw, 1, this.H - yw);
          ctx.fillStyle = lineC;
          ctx.fillRect(x, yw, 1, 1);
          if ((x & 1) === 0) { ctx.fillStyle = pal[2]; ctx.fillRect(x, yw + 1, 1, 1); }
        }
        // moutons : étincelles sur les crêtes hautes de la houle de fond
        if (this.wlA > 0.8) {
          ctx.fillStyle = pal[5];
          for (let k = 0; k < this.W / 12; k++) {
            const x = ((k * 53 + Math.floor(this.t * 9)) * 7) % this.W;
            const yw = this._waterlineY(x);
            if (HOR - yw > 0.65 * this.wlA && Math.random() < 0.5) ctx.fillRect(x, yw - 1, 1, 1);
          }
        }
      } else {
        ctx.fillStyle = this.groundFlash > 0 ? pal[6] : pal[4];
        ctx.fillRect(0, HOR, this.W, 1);
      }
      ctx.fillStyle = pal[3];
      const depth = this.H - HOR - 4;
      for (let x = 0; x < this.W; x += 2) {
        const ph = this.shimmer[x] + this.t * (1.3 + this.tele.gust * 0.6);
        const v = Math.sin(ph) * Math.sin(ph * 0.37 + x);
        if (v > 0.55) ctx.fillRect(x, HOR + 2 + ((x * 7) % Math.max(1, depth)), 2, 1);
      }
      ctx.globalAlpha = 1;
    }
    if (surf > 0.01) {
      // sol dur : moucheture statique, plus sombre, reflet mouillé discret
      ctx.globalAlpha = surf;
      ctx.fillStyle = pal[0];
      ctx.fillRect(0, HOR, this.W, this.H - HOR);
      ctx.fillStyle = pal[2];
      for (const [x, y, v] of this.asphalt) if (v > 0.4) ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = pal[3];
      ctx.fillRect(0, HOR, this.W, 1);
      ctx.globalAlpha = 1;
    }
  }

  _ellipse(cx, cy, rx, ry) {
    // ellipse pixel : segments quantifiés (pas d'anti-aliasing)
    const ctx = this.ctx;
    const n = Math.max(8, Math.round(rx * 2));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ctx.fillRect(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), 1, 1);
    }
  }

  // upscale nearest-neighbor : échelle entière en pixels machine, plein cadre.
  // Le kick secoue l'écran d'un pixel-scène (bumpFrames).
  _blit() {
    const dctx = this.dctx;
    dctx.imageSmoothingEnabled = false;
    const dy = this.bumpFrames > 0 ? this.scale : 0;
    if (dy) { dctx.fillStyle = '#05080f'; dctx.fillRect(0, 0, this.W * this.scale, dy); }
    dctx.drawImage(this.low, 0, 0, this.W, this.H,
      0, dy, this.W * this.scale, this.H * this.scale);
    if (this.bumpFrames > 0) this.bumpFrames--;
  }
}

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
