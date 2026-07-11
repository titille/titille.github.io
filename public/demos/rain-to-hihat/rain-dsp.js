// Physique de la pluie en temps réel — port JS de rain_to_hihat/rainfall.py.
// Aucune dépendance DOM / Web Audio : partagé entre l'AudioWorklet et le
// thread principal (et testable sous Node).
//
// Le modèle offline (Python) est la référence ; ici tout ce qui était
// Monte-Carlo devient analytique pour tourner en temps réel :
//
//   1. COMBIEN de gouttes, QUELLE taille — Marshall-Palmer (1948) :
//      N(D) = N0·exp(-Λ·D), Λ = 4.1·R^-0.21 (R en mm/h). Le knob TAILLE
//      biaise Λ (pluie plus fine ou plus grosse à débit égal).
//   2. À QUELLE vitesse — vitesse terminale d'Atlas (1973) :
//      v(D) = 9.65 - 10.3·exp(-0.6·D). Le flux N(D)·v(D)·aire fixe le taux
//      de Poisson et le mélange de tailles.
//   3. LE SON d'une goutte — tap d'impact (bouffée de bruit ~ temps de
//      contact D/v) puis bulle d'air qui sonne à sa fréquence de Minnaert
//      f0 ≈ 3.29 kHz / a[mm], amortie selon van den Doel (2005), avec un
//      léger chirp montant. Sélectivité de taille : la bruine siffle
//      (D∈[0.8,1.1] mm → bulles 14-16 kHz), l'averse "ploppe" (D>2.2 mm →
//      grosses bulles 1-10 kHz + satellites de splash).
//   4. OÙ elles tombent — disque proche résolu goutte à goutte (1/r, pan),
//      tout le reste = la NAPPE de Campbell : au lieu d'estimer la PSD par
//      Monte-Carlo, on intègre analytiquement λ·E[énergie] par bande de
//      fréquence (sifflement / bloops / roulement), ce qui garde l'équilibre
//      gouttes-résolues / nappe dans les mêmes unités physiques.

const TWO_PI = Math.PI * 2;
const DB60 = 6.9078;                 // exp(-6.9078) ≈ 1e-3 → temps de -60 dB

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, m) => a + (b - a) * m;
export const loglerp = (a, b, m) => a * Math.pow(b / a, m);

// --- constantes physiques (SI), reprises de rainfall.py ---
export const MP_N0 = 8000;           // m^-3 mm^-1
export const D_MIN = 0.3, D_MAX = 6.0;
export const REG_BAND = [0.8, 1.1];  // entraînement régulier type I → ~15 kHz
export const LARGE_MIN = 2.2;        // entraînement irrégulier de grosses bulles
export const P_ENTRAIN_LARGE = 0.5;
export const SPLASH_MIN = 2.5;       // splash en couronne → satellites
export const TAP_GAIN = 0.05;        // niveau du tap vs la bulle (réglé à l'oreille)
const MINNAERT_K = 3288.6;           // sqrt(3·γ·P0/ρ)/(2π) en Hz·mm
const AIR_ABS_DB_M = 2.2e-3;         // dB/m à 1 kHz, ×(f/1k)^1.7

export const mpLambda = (R) => 4.1 * Math.pow(Math.max(R, 0.01), -0.21);
export const termVel = (d) => Math.max(0.1, 9.65 - 10.3 * Math.exp(-0.6 * d));
export const minnaertHz = (aMm) => MINNAERT_K / aMm;
export const vdDamp = (f) => 0.043 * f + 0.0014 * Math.pow(f, 1.5);  // 1/s
const airAbsAmp = (f, distM) =>
  Math.pow(10, -(AIR_ABS_DB_M * Math.pow(Math.max(f, 1) / 1e3, 1.7) * distM) / 20);

// --- RNG seedable (mulberry32) + gaussienne + gamma de Marsaglia-Tsang ---
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export class RNG {
  constructor(seed) { this._u = mulberry32((seed >>> 0) || 1); this._spare = null; }
  uniform() { return this._u(); }
  gauss() {
    if (this._spare !== null) { const s = this._spare; this._spare = null; return s; }
    let u1 = 0; do { u1 = this._u(); } while (u1 <= 1e-12);
    const u2 = this._u();
    const r = Math.sqrt(-2 * Math.log(u1)), th = TWO_PI * u2;
    this._spare = r * Math.sin(th);
    return r * Math.cos(th);
  }
  gamma(k) {                          // forme k >= 1, échelle 1
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = this.gauss(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = this._u();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
}

// forme gamma pour la régularité r ∈ [0,1] ; CV(IOI) = 1 - r exactement.
export function shapeFromRegularity(r) {
  r = clamp(r, 0, 0.999);
  return Math.pow(1 - r, -2);
}

// --- biquad passe-bande RBJ (pic 0 dB), version streaming ---
export function bandpassCoeffs(f0, Q, fs) {
  f0 = clamp(f0, 20, 0.45 * fs);
  const w0 = (TWO_PI * f0) / fs, cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * Q);
  const a0 = 1 + al;
  return [al / a0, 0, -al / a0, (-2 * cw) / a0, (1 - al) / a0];
}
export class Biquad {
  constructor(c) { this.set(c); this.reset(); }
  set(c) { this.b0 = c[0]; this.b1 = c[1]; this.b2 = c[2]; this.a1 = c[3]; this.a2 = c[4]; }
  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  tick(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// enveloppe sans clic : attaque cosinus levé → décroissance expo → queue forcée à 0.
export function grainEnv(attackMs, decayMs, fs) {
  const na = Math.max(2, Math.round((attackMs * fs) / 1000));
  const nd = Math.max(2, Math.round((decayMs * fs) / 1000));
  const e = new Float32Array(na + nd);
  for (let i = 0; i < na; i++) e[i] = 0.5 * (1 - Math.cos((Math.PI * i) / na));
  const tau = nd / DB60;
  for (let i = 0; i < nd; i++) e[na + i] = Math.exp(-i / tau);
  const nf = Math.min(48, nd);
  for (let i = 0; i < nf; i++) e[na + nd - nf + i] *= 0.5 * (1 + Math.cos((Math.PI * (i + 1)) / nf));
  return e;
}

// ---------------------------------------------------------------------------
// Étapes 1+2 : statistiques de gouttes (grille de flux + tables dérivées)
// ---------------------------------------------------------------------------

const N_GRID = 160;

// Grille diamètre + densité de flux N(D)·v(D) en gouttes/(m²·s·mm).
// `bias` (knob TAILLE, -1..1) déforme Λ : >0 = queue plus grasse (grosses gouttes).
export function buildFlux(R, bias) {
  const lam = mpLambda(R) * Math.exp(-0.55 * clamp(bias, -1, 1));
  const d = new Float64Array(N_GRID), phi = new Float64Array(N_GRID);
  for (let i = 0; i < N_GRID; i++) {
    d[i] = D_MIN + ((D_MAX - D_MIN) * i) / (N_GRID - 1);
    phi[i] = MP_N0 * Math.exp(-lam * d[i]) * termVel(d[i]);
  }
  return { d, phi };
}

// intégrale trapèze de φ·w(D) sur [lo, hi]
function fluxInt(grid, lo, hi, w) {
  const { d, phi } = grid;
  let s = 0;
  for (let i = 1; i < N_GRID; i++) {
    const a = d[i - 1], b = d[i];
    if (b < lo || a > hi) continue;
    const fa = a >= lo && a <= hi ? phi[i - 1] * (w ? w(a) : 1) : 0;
    const fb = b >= lo && b <= hi ? phi[i] * (w ? w(b) : 1) : 0;
    s += 0.5 * (fa + fb) * (b - a);
  }
  return s;
}

// énergie (amp²·s, à 1 m) de la bulle d'une goutte D — espérance sur l'entraînement
function ringEnergy(dMm) {
  if (dMm >= REG_BAND[0] && dMm <= REG_BAND[1]) {
    const a = 0.22;
    return Math.pow(a, 3) / (4 * vdDamp(minnaertHz(a)));
  }
  if (dMm >= LARGE_MIN) {
    const a = 0.25 + 0.25 * Math.pow(dMm - LARGE_MIN, 1.1);
    return (P_ENTRAIN_LARGE * Math.pow(a, 3)) / (4 * vdDamp(minnaertHz(a)));
  }
  return 0;
}
// énergie (amp²·s, à 1 m) du tap d'impact d'une goutte D
function tapEnergy(dMm, hard) {
  const v = termVel(dMm);
  const tc = (hard ? 2.5 : 1) * (dMm * 1e-3) / v;
  let amp = TAP_GAIN * Math.pow(dMm, 1.5) * Math.pow(v / 9.65, 2.5);
  if (hard) amp *= 3;
  return amp * amp * Math.max(2.5e-4, tc) * 0.35;   // 0.35 ≈ facteur d'enveloppe
}

// ---------------------------------------------------------------------------
// buildDerived : macros → tables temps-réel (taux, CDF inverse, bandes de nappe)
// ---------------------------------------------------------------------------
// macros = { intensity (mm/h), sizeBias (-1..1), space (0..1), surface (0..1),
//            rateMul, ... } — voir app.js pour la liste complète.

export const MAX_EVENT_RATE = 220;   // gouttes résolues max /s (CPU + visuel)
const FAR_R = 50, LISTENER_H = 1.5;

export function buildDerived(M, fs) {
  const grid = buildFlux(M.intensity, M.sizeBias);
  const { d, phi } = grid;
  const nearR = 0.7 + 2.5 * M.space;
  const h = LISTENER_H;
  const aNear = Math.PI * nearR * nearR;

  // --- seuil de résolution : le plus petit D rendu goutte à goutte, choisi
  // pour que le taux résolu reste sous MAX_EVENT_RATE (le reste → nappe).
  let dRes = D_MIN;
  if (fluxInt(grid, D_MIN, D_MAX) * aNear > MAX_EVENT_RATE) {
    let lo = D_MIN, hi = D_MAX;
    for (let it = 0; it < 28; it++) {
      const mid = 0.5 * (lo + hi);
      if (fluxInt(grid, mid, D_MAX) * aNear > MAX_EVENT_RATE) lo = mid; else hi = mid;
    }
    dRes = hi;
  }
  dRes = Math.max(dRes, 0.5);        // seuil d'origine (la pluie sur eau, douce)
                                     // (mesuré : la vraie pluie a ~13 impacts/s, pas 3)
  const lamRes = fluxInt(grid, dRes, D_MAX) * aNear;   // gouttes résolues /s

  // --- CDF inverse des diamètres résolus (tirage à coût constant)
  const NC = 64;
  const invCdf = new Float32Array(NC + 1);
  {
    const cum = new Float64Array(N_GRID);
    for (let i = 1; i < N_GRID; i++) {
      const w0 = d[i - 1] >= dRes ? phi[i - 1] : 0;
      const w1 = d[i] >= dRes ? phi[i] : 0;
      cum[i] = cum[i - 1] + 0.5 * (w0 + w1) * (d[i] - d[i - 1]);
    }
    const tot = cum[N_GRID - 1] || 1;
    let j = 1;
    for (let k = 0; k <= NC; k++) {
      const target = (tot * k) / NC;
      while (j < N_GRID - 1 && cum[j] < target) j++;
      const c0 = cum[j - 1], c1 = cum[j];
      const t = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
      invCdf[k] = d[j - 1] + t * (d[j] - d[j - 1]);
    }
    invCdf[0] = Math.max(invCdf[0], dRes);
  }

  // --- géométrie : ∫ dA/(r²+h²) en forme close, par strate
  const gNear = Math.PI * Math.log((nearR * nearR + h * h) / (h * h));
  const gFar = Math.PI * Math.log((FAR_R * FAR_R + h * h) / (nearR * nearR + h * h));
  const rEffFar = Math.sqrt(nearR * FAR_R);     // distance effective (pondérée 1/r²)
  const meanInvR2 = gNear / aNear;              // E[1/(r²+h²)] sur le disque proche

  // --- puissances de bande de la NAPPE (théorème de Campbell, par bande) ---
  // P_bande = Σ_strates [∫ φ·E(D) dD sur la gamme permise] · G_strate · airAbs².
  // Strates : champ lointain (tous D) + disque proche (D < dRes non résolus).
  const surf = M.surface;
  const strata = [
    { lo: D_MIN, hi: D_MAX, G: gFar, dist: rEffFar },
    { lo: D_MIN, hi: dRes, G: gNear, dist: Math.sqrt(h * (nearR + h)) },
  ];
  // a moyen des grosses bulles, pondéré par le flux (→ fréquence du bloop)
  let aSum = 0, wSum = 0;
  for (let i = 0; i < N_GRID; i++) if (d[i] >= LARGE_MIN) {
    const a = 0.25 + 0.25 * Math.pow(d[i] - LARGE_MIN, 1.1);
    aSum += phi[i] * a; wSum += phi[i];
  }
  const aBloop = wSum > 0 ? clamp(aSum / wSum, 0.3, 2.5) : 0.8;
  const fHiss = minnaertHz(0.22);                       // ≈ 14.9 kHz
  const fBloop = clamp(minnaertHz(aBloop), 600, 5000);

  let pHiss = 0, pBloop = 0, pTap = 0, pSplat = 0;
  for (const s of strata) {
    pHiss += fluxInt(grid, Math.max(s.lo, REG_BAND[0]), Math.min(s.hi, REG_BAND[1]),
      () => Math.pow(0.22, 3) / (4 * vdDamp(fHiss))) * s.G * airAbsAmp(fHiss, s.dist) ** 2;
    pBloop += fluxInt(grid, Math.max(s.lo, LARGE_MIN), s.hi,
      (x) => ringEnergy(x)) * s.G * airAbsAmp(fBloop, s.dist) ** 2;
    pTap += fluxInt(grid, s.lo, s.hi, (x) => tapEnergy(x, false)) * s.G * airAbsAmp(1400, s.dist) ** 2;
    pSplat += fluxInt(grid, s.lo, s.hi, (x) => tapEnergy(x, true) + 3.24 * tapEnergy(x, false))
      * s.G * airAbsAmp(3000, s.dist) ** 2;
  }
  // surface dure : pas de bulles, des taps/éclaboussures plus forts.
  // NB : le « voicing médium » (hiss×0.3, tap×1.8) calé sur la réf TERRASSE a
  // été retiré — à l'oreille (Tristan) il dénaturait la pluie sur eau, plus
  // douce, qu'on préfère. La réf terrasse était une mauvaise cible. Bandes
  // physiques d'origine restaurées.
  const washBands = [
    { f: fHiss, q: 2.2, rms: Math.sqrt(pHiss * (1 - surf)) },
    { f: fBloop, q: 1.1, rms: Math.sqrt(pBloop * (1 - surf)) },
    { f: 1400, q: 0.55, rms: Math.sqrt(pTap * (1 - surf) + pSplat * surf * 0.45) },
    { f: 3000, q: 0.7, rms: Math.sqrt(pSplat * surf * 0.55) },
  ];
  const washPower = washBands.reduce((s, b) => s + b.rms * b.rms, 0);

  // --- énergie moyenne d'une goutte résolue, au point d'écoute (pour la
  // normalisation de loudness : équivalent analytique du _normalize offline)
  let eSum = 0;
  for (let k = 0; k <= NC; k++) {
    const D = invCdf[k];
    eSum += (1 - surf) * (tapEnergy(D, false) + ringEnergy(D))
      + surf * tapEnergy(D, true);
  }
  const meanDropE = (eSum / (NC + 1)) * meanInvR2;

  return {
    nearR, dRes, lamRes, invCdf,
    rateRain: Math.max(0.05, lamRes * M.rateMul),
    washBands, washPower, meanDropE,
    washLP: lerp(17000, 8000, M.space),   // absorption de l'air : champ ouvert = plus feutré
    panWidth: 0.5 + 0.5 * M.space,
  };
}

// ---------------------------------------------------------------------------
// Étape 3 : le son d'UNE goutte, écrit directement dans le ring buffer
// ---------------------------------------------------------------------------

// rt = { bufL, bufR, mask, fs, rng } ; gL/gR = gains de pan équi-puissance.

function addBurst(rt, start, fc, q, decayMs, amp, gL, gR) {
  const env = grainEnv(Math.max(0.3, 0.3 * decayMs), decayMs, rt.fs);
  const N = env.length;
  const coeffs = bandpassCoeffs(clamp(fc, 200, 16000), q, rt.fs);
  const bq1 = new Biquad(coeffs);
  const bq2 = new Biquad(coeffs);
  let ss = 0;
  const tmp = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const y = bq2.tick(bq1.tick(rt.rng.gauss())) * env[i];
    tmp[i] = y; ss += y * y;
  }
  const g = ss > 0 ? amp / Math.sqrt(ss / N) : 0;
  const { bufL, bufR, mask } = rt;
  for (let i = 0; i < N; i++) {
    const idx = (start + i) & mask;
    bufL[idx] += tmp[i] * g * gL;
    bufR[idx] += tmp[i] * g * gR;
  }
}

// sinus de Minnaert amorti (van den Doel) avec chirp de pincement montant
function addRing(rt, start, aMm, amp, gL, gR) {
  const fs = rt.fs;
  const f0 = Math.min(minnaertHz(aMm), 0.44 * fs);
  const damp = vdDamp(f0);
  const N = Math.max(8, Math.round(Math.min(DB60 / damp, 0.25) * fs));
  const na = Math.max(2, Math.round(2e-4 * fs));
  const nf = Math.min(48, N >> 2 || 2);
  const { bufL, bufR, mask } = rt;
  let phase = 0;
  for (let i = 0; i < N; i++) {
    const t = i / fs;
    const fInst = Math.min(f0 * (1 + 0.1 * damp * t), 0.45 * fs);
    phase += (TWO_PI * fInst) / fs;
    let y = Math.sin(phase) * Math.exp(-damp * t) * amp;
    if (i < na) y *= 0.5 * (1 - Math.cos((Math.PI * i) / na));
    if (i >= N - nf) y *= 0.5 * (1 + Math.cos((Math.PI * (i - (N - nf) + 1)) / nf));
    const idx = (start + i) & mask;
    bufL[idx] += y * gL;
    bufR[idx] += y * gR;
  }
}

// rayon de bulle (mm) entraîné par une goutte D, ou null — port direct
export function entrainedRadius(dMm, rng) {
  if (dMm >= REG_BAND[0] && dMm <= REG_BAND[1])
    return clamp(0.22 + 0.015 * rng.gauss(), 0.18, 0.27);
  if (dMm >= LARGE_MIN && rng.uniform() < P_ENTRAIN_LARGE) {
    const med = 0.25 + 0.25 * Math.pow(dMm - LARGE_MIN, 1.1);
    return clamp(med * Math.exp(0.25 * rng.gauss()), 0.1, 2.5);
  }
  return null;
}

// Rend une goutte (D en mm) dans le ring buffer à partir de `start`.
// Retourne les métadonnées pour le splash pixel-art synchronisé.
export function renderDrop(rt, start, dMm, gain, gL, gR, hard) {
  const rng = rt.rng, fs = rt.fs;
  const v = termVel(dMm);
  let tc = (dMm * 1e-3) / v;
  const ampTap = TAP_GAIN * Math.pow(dMm, 1.5) * Math.pow(v / 9.65, 2.5) * gain;
  let bloopF = 0, energy = ampTap;

  if (hard) {
    tc *= 2.5;                                       // la goutte s'écrase
    addBurst(rt, start, 0.25 / tc, 0.6, Math.max(0.25, 1e3 * tc), 3 * ampTap, gL, gR);
    const dly = Math.round((5e-4 + 1e-3 * rng.uniform()) * fs);
    addBurst(rt, start + dly, 3000, 0.4, 3 + 3 * rng.uniform(), 1.8 * ampTap, gL, gR);
    energy = 3 * ampTap;
  } else {
    addBurst(rt, start, 0.45 / tc, 0.5, Math.max(0.25, 1e3 * tc), ampTap, gL, gR);
    const a = entrainedRadius(dMm, rng);
    if (a !== null) {                                // la bulle du pincement
      const delay = dMm <= REG_BAND[1]
        ? 1e-3 + 2e-3 * rng.uniform()
        : (0.012 + 0.033 * rng.uniform()) * (dMm / LARGE_MIN);
      const ampRing = Math.pow(a, 1.5) * gain;
      addRing(rt, start + Math.round(delay * fs), a, ampRing, gL, gR);
      bloopF = minnaertHz(a);
      energy = Math.max(energy, ampRing);
    }
    if (dMm >= SPLASH_MIN) {                         // satellites de la couronne
      const n = poisson(rng, 1.5);
      for (let i = 0; i < n; i++) {
        const as = 0.15 + 0.13 * rng.uniform();
        addRing(rt, start + Math.round((0.02 + 0.07 * rng.uniform()) * fs),
          as, 0.25 * Math.pow(as, 1.5) * gain, gL, gR);
      }
    }
  }
  return { energy, bloopF };
}

function poisson(rng, lam) {
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= rng.uniform(); } while (p > L);
  return k - 1;
}

// ---------------------------------------------------------------------------
// Le tick hi-hat (bout m=1) — grain de bruit filtré, RMS-normalisé
// ---------------------------------------------------------------------------

const METAL_RATIOS = [1.34, 1.78];
const METAL_WEIGHTS = [0.6, 0.4];

export function synthTick(brill, fs, rng) {
  const fc = clamp((8000 + 3500 * brill) * Math.exp(0.08 * clamp(rng.gauss(), -2, 2)), 20, Math.min(17000, fs / 2 - 100));
  const Q = 1.4 + 1.2 * brill;
  const metallic = 0.85 * brill;
  const env = grainEnv(0.5, 22, fs);
  const N = env.length;
  const noise = new Float32Array(N);
  for (let i = 0; i < N; i++) noise[i] = rng.gauss();

  const run = (f, q) => {
    const c = bandpassCoeffs(f, q, fs);
    const b1 = new Biquad(c), b2 = new Biquad(c);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = b2.tick(b1.tick(noise[i]));
    return out;
  };
  const base = run(fc, Q);
  let sig = base;
  if (metallic > 0.01) {
    sig = new Float32Array(N);
    const parts = METAL_RATIOS.map((r) => run(fc * r, Q * 1.2));
    for (let i = 0; i < N; i++) {
      let multi = base[i];
      for (let r = 0; r < parts.length; r++) multi += METAL_WEIGHTS[r] * parts[r][i];
      sig[i] = (1 - metallic) * base[i] + metallic * multi;
    }
  }
  let ss = 0;
  for (let i = 0; i < N; i++) { sig[i] *= env[i]; ss += sig[i] * sig[i]; }
  const amp = 1 + 0.05 * (rng.uniform() * 2 - 1);
  const g = ss > 0 ? amp / Math.sqrt(ss / N) : 0;
  for (let i = 0; i < N; i++) sig[i] *= g;
  return sig;
}
export const TICK_ENERGY = 0.0225;   // énergie ≈ amp²·durée (22.5 ms, rms = 1)

// ---------------------------------------------------------------------------
// Module VAGUE : déferlement (m=0) ↔ kick 808 (m=1)
// ---------------------------------------------------------------------------
// Le déferlement = transitoire grave (le "boum" sourd de la masse d'eau) +
// wash d'écume qui monte puis retombe avec un filtre qui se referme. Le kick
// 808 = la même essence réduite à l'os : sub-sinus avec chute de pitch + click.

// Constantes de TIMBRE de la voix vague, exposées pour l'auto-tuning (cf le
// patron CRACKLE_DEFAULTS du feu). Le moteur (processor) construit un objet
// `vagueP = { ...VAGUE_DEFAULTS, ...params }` ; passer ces défauts reproduit le
// comportement actuel À L'IDENTIQUE (rendu byte-pour-byte), et l'ordre des
// tirages RNG n'en dépend JAMAIS (déterminisme préservé : les params ne
// changent que des Hz / Q / décroissances, pas le nombre de tirages).
//   - ressac* : le RESSAC CONTINU (lit dominant, vit dans le processor) — c'est
//     lui qui pèse sur la texture/modulation. `ressacHiss` ajoute une 2e bande
//     HF (« l'air » d'écume manquant, mesuré : 8-16 kHz trop bas) ; à 0 = inerte.
//   - break* : le DÉFERLEMENT (transitoire épars, ici dans synthWaveBreak).
export const VAGUE_DEFAULTS = {
  ressacF: 1000,       // centre du bandpass d'écume continue (Hz)
  ressacQ: 0.5,        // largeur (bas Q = lavé/lisse ; haut Q = sifflant/piqué)
  ressacHiss: 0.0,     // gain d'une bande HF d'écume (0 = comportement actuel)
  ressacHissF: 9000,   // centre de la bande HF
  ressacHissQ: 0.7,    // largeur de la bande HF
  swellHz: 0.39,       // fréquence de houle (le pic de modulation, ~0.39 Hz réel)
  swellFloor: 0.72,    // plancher du swell (la vague ne se retire jamais à 0)
  swellDepth: 0.28,    // profondeur de respiration (0 = constant ; + = pompe)
  breakF: 1200,        // centre du bandpass d'écume du déferlement (Hz)
  breakQ: 0.5,         // largeur de cette écume
  breakDecay: 4.3,     // décroissance de l'écume du déferlement (1/s)
};

// Écrit un déferlement dans le ring à partir de `start`. ~2.2 s max. `P` =
// override partiel de VAGUE_DEFAULTS (le moteur passe `vagueP` ; un appel sans
// P garde les défauts → rendu inchangé). N'altère AUCUN tirage RNG.
export function synthWaveBreak(rt, start, taille, amp, gL, gR, P) {
  const fs = rt.fs, rng = rt.rng;
  const { bufL, bufR, mask } = rt;
  const p = P ? { ...VAGUE_DEFAULTS, ...P } : VAGUE_DEFAULTS;

  // 1) le thump grave : sinus 50-70 Hz légèrement descendant + grondement LP,
  //    décalé de ~0.25 s (l'écume commence à lécher avant que la masse frappe).
  //    DISCRET sur les petites vagues (mesuré : grave 15 dB SOUS le médium) —
  //    il ne grossit qu'avec la taille (côté kick, synthKick fournit le punch)
  const tOff = Math.round(0.22 * fs);
  const f0 = 52 + 18 * rng.uniform();
  const dampT = 7;                                   // -60 dB ≈ 1 s
  const nT = Math.round(0.85 * fs);
  const aT = (0.24 + 0.85 * taille * taille) * amp;
  const na = Math.max(2, Math.round(0.008 * fs));
  const aSub = 1 - Math.exp((-TWO_PI * 110) / fs);
  let phase = 0, sub = 0;
  for (let i = 0; i < nT; i++) {
    const t = i / fs;
    phase += (TWO_PI * f0 * (1 - 0.22 * Math.min(t / 0.3, 1))) / fs;
    let y = Math.sin(phase) * Math.exp(-dampT * t);
    sub += aSub * (rng.gauss() - sub);
    y += 0.55 * sub * Math.exp(-5 * t);
    if (i < na) y *= 0.5 * (1 - Math.cos((Math.PI * i) / na));
    const idx = (start + tOff + i) & mask;
    bufL[idx] += aT * y * gL;
    bufR[idx] += aT * y * gR;
  }

  // 2) l'écume : LE cœur d'une petite vague — bruit passe-bande MÉDIUM (le
  //    grésillement de l'écume vit ~1 kHz, mesuré dominant), montée ~0.45 s
  //    puis décroissance, passe-bas qui se referme vers le grave
  const nE = Math.round(2.1 * fs);
  const nAtt = Math.round(0.45 * fs);
  const nRel = Math.min(nE, Math.round(0.012 * fs));  // fade de release anti-clic
  const c = bandpassCoeffs(p.breakF, p.breakQ, fs);
  const b1 = new Biquad(c), b2 = new Biquad(c);
  const aE = (0.6 + 0.5 * taille) * amp * 0.8;
  let lpE = 0, ss = 0;
  const tmp = new Float32Array(nE);
  for (let i = 0; i < nE; i++) {
    const t = i / fs;
    const fc = 900 + 2600 * Math.exp(-1.8 * t);
    const aLP = 1 - Math.exp((-TWO_PI * fc) / fs);
    lpE += aLP * (b2.tick(b1.tick(rng.gauss())) - lpE);
    let env = i < nAtt
      ? 0.5 * (1 - Math.cos((Math.PI * i) / nAtt))
      : Math.exp(-p.breakDecay * ((i - nAtt) / fs));
    // l'écume est coupée net à nE=2.1 s : à breakDecay bas l'enveloppe y vaut
    // encore ~0.04 → clic de troncature. Fade cosinus sur les dernières ms (revue #6).
    if (i >= nE - nRel) env *= 0.5 * (1 + Math.cos((Math.PI * (i - (nE - nRel))) / nRel));
    tmp[i] = lpE * env;
    ss += tmp[i] * tmp[i];
  }
  const g = ss > 0 ? aE / Math.sqrt(ss / nE) : 0;
  for (let i = 0; i < nE; i++) {
    const idx = (start + i) & mask;
    bufL[idx] += tmp[i] * g * gL;
    bufR[idx] += tmp[i] * g * gR;
  }
}
// énergie ≈ amp²·s pour le makeup. Le déferlement est un accent (×0.3 dans
// _trigVague → ×0.09 en énergie) ; le gros du son vient du ressac respirant.
export const waveEnergy = (taille) => (0.4 + 1.2 * taille) * 0.015;

// Kick 808 : sub-sinus 90→44 Hz, decay 260 ms, click d'attaque. Sample-exact.
export function synthKick(rt, start, amp, gL, gR) {
  const fs = rt.fs, rng = rt.rng;
  const { bufL, bufR, mask } = rt;
  const n = Math.round(0.32 * fs);
  const damp = DB60 / 0.26;
  const na = Math.max(2, Math.round(0.001 * fs));
  const nClick = Math.round(0.0025 * fs);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const f = 44 + 46 * Math.exp(-t / 0.045);
    phase += (TWO_PI * f) / fs;
    let y = Math.sin(phase) * Math.exp(-damp * t);
    if (i < nClick) y += 0.35 * rng.gauss() * (1 - i / nClick);
    if (i < na) y *= 0.5 * (1 - Math.cos((Math.PI * i) / na));
    const idx = (start + i) & mask;
    bufL[idx] += amp * y * gL;
    bufR[idx] += amp * y * gR;
  }
}
export const KICK_ENERGY = 0.011;    // ≈ amp²·s à amp = 1

// ---------------------------------------------------------------------------
// Module ORAGE : coup de foudre (m=0) ↔ cymbale crash (m=1)
// ---------------------------------------------------------------------------
// Les deux sont du large-bande à décroissance longue. Le tonnerre : crack
// initial (tué par l'absorption de l'air avec la distance) + roulement grave
// à plusieurs vagues (échos multi-trajets). La crash : la même essence en
// métallique brillant. L'éclair visuel flashe immédiatement ; le son arrive
// distance/343 m/s plus tard (géré côté processeur).

// Écrit un coup de tonnerre dans le ring. distKm ∈ [0.15, 3], traine = s.
export function synthThunder(rt, start, distKm, traine, amp, gL, gR) {
  const fs = rt.fs, rng = rt.rng;
  const { bufL, bufR, mask } = rt;
  const hfK = Math.exp(-1.2 * distKm);               // les aigus meurent avec la distance
  const aBase = (2.2 / (0.5 + distKm)) * amp;

  // de près : le "déchirement" — un train de micro-craquements irréguliers
  // qui se raréfient (le canal de foudre claque segment par segment)
  if (hfK > 0.12) {
    let tc = 0;
    const nCr = 5 + Math.round(8 * hfK * rng.uniform());
    for (let i = 0; i < nCr; i++) {
      const f = 1100 + 2800 * rng.uniform();
      addBurst(rt, start + Math.round(tc * fs), f, 0.9, 6 + 22 * rng.uniform(),
        (1.7 - 1.2 * (i / nCr)) * hfK * hfK * aBase, gL, gR);
      tc += 0.006 + 0.05 * rng.uniform() * (0.3 + i / nCr);
    }
    // le claquement médium principal qui suit le déchirement (mesuré : le
    // tonnerre réel a beaucoup de médium — on l'étoffe avec une 2e bande)
    addBurst(rt, start + Math.round(0.025 * fs), 620, 0.6, 150, 1.3 * hfK * aBase, gL, gR);
    addBurst(rt, start + Math.round(0.04 * fs), 320, 0.7, 220, 0.9 * hfK * aBase, gL, gR);
    // sub-boom de l'onde de pression (N-wave) : une bouffée 36 Hz très courte
    const nB = Math.round(0.16 * fs);
    let ph = 0;
    for (let i = 0; i < nB; i++) {
      const t = i / fs;
      ph += (TWO_PI * 36) / fs;
      let y = Math.sin(ph) * Math.exp(-20 * t) * 1.5 * hfK * aBase;
      if (i < 32) y *= i / 32;
      const idx = (start + i) & mask;
      bufL[idx] += y * gL;
      bufR[idx] += y * gR;
    }
  }

  // roulement : bruit très grave (2 one-pole LP), enveloppe à 3 vagues
  // (onde directe + échos sol/nuages) × modulation lente aléatoire (le
  // "roulé" qui tourne), spectre brillant à l'attaque puis qui s'assombrit
  const L = Math.min(4.4, traine + 1.2);
  const n = Math.round(L * fs);
  // fcBase remonté avec mesure : assez de médium (réel −5.7 dB) mais le
  // tonnerre reste SOMBRE (réel quasi rien >2 kHz) → pas trop haut non plus
  const fcBase = 58 + 165 * hfK;
  const d = DB60 / Math.max(0.8, traine);
  const waves = [
    { o: 0, a: 1 },
    { o: 0.25 + 0.5 * rng.uniform(), a: 0.55 },
    { o: 0.9 + 1.1 * rng.uniform(), a: 0.4 },
  ];
  const aRoll = 1 - Math.exp((-TWO_PI * 2.2) / fs);
  // grain du roulement : le tonnerre réel GRÉSILLE (multi-trajets, mesuré
  // ~23 grains/s) — modulation d'amplitude rapide bruitée par-dessus le
  // roulé lent, sinon le grondement est trop lisse
  const aGrain = 1 - Math.exp((-TWO_PI * 95) / fs);
  let lp1 = 0, lp2 = 0, roll = 0, grain = 0, ss = 0;
  const tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const fc = fcBase * (1 + 2.2 * Math.exp(-t / 0.35));
    const aLP = 1 - Math.exp((-TWO_PI * fc) / fs);
    lp1 += aLP * (rng.gauss() - lp1);
    lp2 += aLP * (lp1 - lp2);
    roll += aRoll * (rng.gauss() * 18 - roll);
    grain += aGrain * (rng.gauss() - grain);
    let env = 0;
    for (const w of waves) {
      const tt = t - w.o;
      if (tt > 0) env += w.a * Math.exp(-d * tt) * (1 - Math.exp(-tt / 0.06));
    }
    env *= (0.62 + 0.38 * clamp(roll, -1, 1)) * (0.58 + 0.5 * clamp(grain * 2.4, -1, 1));
    tmp[i] = lp2 * env;
    ss += tmp[i] * tmp[i];
  }
  const g = ss > 0 ? (1.3 * aBase) / Math.sqrt(ss / n) : 0;
  for (let i = 0; i < n; i++) tmp[i] *= g;

  // RÉVERBÉRATION (Schroeder : 4 combs parallèles + 2 allpass série) — c'est
  // ce qui fait « rouler » le tonnerre dans le paysage : les échos multi-trajets
  // sur le sol, le relief, les nuages. Plus la traîne est longue, plus la queue
  // diffuse est longue. Délais en nombres premiers (ms) pour éviter le métallique.
  const combMs = [43.7, 52.3, 61.1, 71.3], apMs = [9.7, 3.1];
  const fb = clamp(0.55 + 0.12 * Math.min(traine, 4), 0.5, 0.86);
  const wet = new Float32Array(n);
  for (const dm of combMs) {                            // combs : queue + densité
    const dl = Math.max(1, Math.round((dm / 1000) * fs));
    const buf = new Float32Array(dl);
    let p = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const y = buf[p];
      lp += 0.5 * (y - lp);                             // amortit les aigus dans la queue
      buf[p] = tmp[i] + lp * fb;
      wet[i] += y * 0.25;
      if (++p >= dl) p = 0;
    }
  }
  for (const dm of apMs) {                              // allpass : diffusion
    const dl = Math.max(1, Math.round((dm / 1000) * fs));
    const buf = new Float32Array(dl);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const bufd = buf[p];
      const inp = wet[i];
      const y = -0.7 * inp + bufd;
      buf[p] = inp + 0.7 * y;
      wet[i] = y;
      if (++p >= dl) p = 0;
    }
  }
  const wmix = 0.55;                                    // dose de réverb (le grondement)
  for (let i = 0; i < n; i++) {
    const idx = (start + i) & mask;
    const y = tmp[i] + wet[i] * wmix;
    bufL[idx] += y * gL;
    bufR[idx] += y * gR;
  }
}
export const thunderEnergy = (distKm, traine) => {
  const a = 2.2 / (0.5 + distKm);
  return a * a * 1.69 * Math.min(4.4, traine + 1.2) * 0.5;
};

// Cymbale crash : bruit multi-bandes inharmonique, queue longue, shimmer lent.
export function synthCrash(rt, start, traine, brill, amp, gL, gR) {
  const fs = rt.fs, rng = rt.rng;
  const { bufL, bufR, mask } = rt;
  const dur = clamp(traine * 0.6, 0.8, 2.4);
  const n = Math.round(dur * fs);
  const fcBase = 6800 + 2800 * brill;
  const ratios = [1.0, 1.34, 1.78, 2.41, 3.07];
  const weights = [1.0, 0.62, 0.5, 0.36, 0.25];
  const fils = ratios.map((r) => {
    const c = bandpassCoeffs(Math.min(fcBase * r, 0.45 * fs), 1.1, fs);
    return [new Biquad(c), new Biquad(c)];
  });
  const damp = DB60 / dur;
  const na = Math.max(2, Math.round(0.0012 * fs));
  let ss = 0;
  const tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const w = rng.gauss();
    let y = 0;
    for (let k = 0; k < fils.length; k++) y += weights[k] * fils[k][1].tick(fils[k][0].tick(w));
    let env = Math.exp(-damp * t) * (1 + 0.13 * Math.sin(TWO_PI * 5.3 * t));
    if (i < na) env *= 0.5 * (1 - Math.cos((Math.PI * i) / na));
    tmp[i] = y * env;
    ss += tmp[i] * tmp[i];
  }
  const g = ss > 0 ? amp / Math.sqrt(ss / n) : 0;
  for (let i = 0; i < n; i++) {
    const idx = (start + i) & mask;
    bufL[idx] += tmp[i] * g * gL;
    bufR[idx] += tmp[i] * g * gR;
  }
}
export const crashEnergy = (traine) => clamp(traine * 0.6, 0.8, 2.4) * 0.5;

// ---------------------------------------------------------------------------
// Module VENT : turbulence + sifflement éolien (m=0) ↔ riser de bruit blanc (m=1)
// ---------------------------------------------------------------------------
// Le vent EST du bruit filtré : un corps large bande qui respire avec les
// rafales + une résonance étroite (le sifflement autour des obstacles) dont
// la hauteur dérive avec le gust. Côté m=1 : bruit blanc plein spectre dont
// l'enveloppe et le passe-haut montent sur 2 mesures et retombent sur le 1.

export class WindVoice {
  constructor(fs, seed) {
    this.fs = fs;
    this.rngL = new RNG((seed ^ 0xabc123) >>> 0);
    this.rngR = new RNG((seed ^ 0x55aa77) >>> 0);
    this.rngM = new RNG((seed ^ 0x3c6ef3) >>> 0);   // respiration commune (un seul vent)
    // corps grave-médium : un vrai vent de plaine est SOMBRE (mesuré sur réel :
    // médium dominant à ~1 kHz, mais quasi RIEN au-dessus de 2 kHz, -36 dB).
    const cBody = bandpassCoeffs(300, 0.5, fs);
    this.bodyL = [new Biquad(cBody), new Biquad(cBody)];
    this.bodyR = [new Biquad(cBody), new Biquad(cBody)];
    // sifflement éolien : DEUX résonances tonales étroites (Q élevé) à des
    // hauteurs indépendantes qui dérivent et ÉMERGENT sur les rafales (le vent
    // qui force autour d'une arête). Tonal = localisé en fréquence, donc pas le
    // souffle HF large bande qu'on avait banni. Plage large (jusqu'à ~2.8 kHz).
    const cWh = bandpassCoeffs(800, 12, fs);
    this.whL = [new Biquad(cWh), new Biquad(cWh)];
    this.whR = [new Biquad(cWh), new Biquad(cWh)];
    const cWh2 = bandpassCoeffs(1700, 14, fs);
    this.wh2L = [new Biquad(cWh2), new Biquad(cWh2)];
    this.wh2R = [new Biquad(cWh2), new Biquad(cWh2)];
    // passe-bas franc (4 one-pole) qui tue le souffle HF parasite du corps
    this.lpL = [0, 0, 0, 0]; this.lpR = [0, 0, 0, 0];
    this.aLP = 1 - Math.exp((-TWO_PI * 2600) / fs);
    this.hpL = 0; this.hpR = 0;
    this.whCount = 0;
    // respiration quasi-périodique du vent : le vrai vent POUSSE par bouffées
    // de ~2 s (pic de modulation mesuré à 0.44 Hz). Un random-walk filtré ne
    // donne qu'un plateau DC ; il faut un oscillateur jitteré pour un vrai pic.
    this.breathPhase = 0;
    this.breathF = 0.45;
    this.cfg = { force: 0.6, rafales: 0.5, sifflement: 0.35, gNat: 1, gPerc: 0 };
  }

  set(force, rafales, sifflement, gNat, gPerc) {
    this.cfg = { force, rafales, sifflement, gNat, gPerc };
  }

  // une paire d'échantillons [L, R] ; gust ∈ [-1,1], riserPhase ∈ [0,1)
  tick(gust, riserPhase) {
    const c = this.cfg;
    // respiration rapide propre (commune G/D) combinée à la rafale lente externe
    // oscillateur de respiration : période rejitterée à chaque cycle (étale le
    // pic autour de 0.45 Hz au lieu d'un sinus pur) + part de rafale lente externe
    this.breathPhase += (TWO_PI * this.breathF) / this.fs;
    if (this.breathPhase >= TWO_PI) {
      this.breathPhase -= TWO_PI;
      this.breathF = clamp(0.45 * Math.exp(0.4 * this.rngM.gauss()), 0.22, 0.95);
    }
    const breath = clamp(0.72 * Math.sin(this.breathPhase) + 0.22 * gust, -1, 1);
    // sifflements : deux hauteurs qui dérivent avec la rafale (recalcul par bloc),
    // l'une médium (500-1500), l'autre aiguë (1200-2800) → un sifflet à deux voix
    if (++this.whCount >= 256) {
      this.whCount = 0;
      const f1 = clamp(700 * (1 + 0.7 * c.sifflement) * (1 + 0.45 * breath), 450, 1500);
      const f2 = clamp(1700 * (1 + 0.5 * c.sifflement) * (1 + 0.5 * breath), 1100, 2800);
      const cw1 = bandpassCoeffs(f1, 12, this.fs);
      const cw2 = bandpassCoeffs(f2, 14, this.fs);
      for (const b of [...this.whL, ...this.whR]) b.set(cw1);
      for (const b of [...this.wh2L, ...this.wh2R]) b.set(cw2);
    }
    // profondeur de respiration ~0.3 (mesuré sur réel), creusée par RAFALES
    const breathe = 0.68 + (0.15 + 0.34 * c.rafales) * breath;
    // le sifflement ÉMERGE sur les pics de rafale (puissance ∝ breath²) et est
    // bien plus présent qu'avant — c'est une signature du vent que Tristan
    // entendait manquer. La 2e voix (aiguë) est un peu plus discrète.
    const emerge = Math.max(0, 0.25 + 0.75 * breath);
    const whG = c.sifflement * emerge * emerge * 1.1;
    const out = [0, 0];
    const chans = [
      [this.rngL, this.bodyL, this.whL, this.wh2L, this.lpL, 0],
      [this.rngR, this.bodyR, this.whR, this.wh2R, this.lpR, 1],
    ];
    for (const [rng, body, wh, wh2, lp, i] of chans) {
      const w = rng.gauss();
      let corps = body[1].tick(body[0].tick(w));
      // passe-bas 2e ordre, coupure ~2.6 kHz : le vrai vent N'EST PAS un mur
      // sombre — il a du feuillage en HF (mesuré : -28 dB en 4-8k, pas -78).
      // Pente douce 2 pôles, pas un 4-pôle qui écrase tout au-dessus de 1.5k.
      lp[0] += this.aLP * (corps - lp[0]);
      lp[1] += this.aLP * (lp[0] - lp[1]);
      const siff = wh[1].tick(wh[0].tick(w)) * whG + wh2[1].tick(wh2[0].tick(w)) * whG * 0.6;
      let nat = lp[1] * 2.0 * breathe + siff;
      nat *= c.force * 0.7;
      // riser : bruit blanc, enveloppe phase² + passe-haut qui s'ouvre
      let ris = 0;
      if (c.gPerc > 1e-3) {
        const aHP = 1 - Math.exp((-TWO_PI * (150 + 6000 * riserPhase * riserPhase * riserPhase)) / this.fs);
        if (i === 0) { this.hpL += aHP * (w - this.hpL); ris = (w - this.hpL); }
        else { this.hpR += aHP * (w - this.hpR); ris = (w - this.hpR); }
        ris *= riserPhase * riserPhase * c.force * 0.35;
      }
      out[i] = c.gNat * nat + c.gPerc * ris;
    }
    return out;
  }
}
// puissance approx. de la voix (pour le makeup), amp²
export const windPower = (force, gNat, gPerc) =>
  gNat * gNat * Math.pow(0.133 * force, 2) + gPerc * gPerc * Math.pow(0.18 * force, 2);
