// Pure DSP core for the rain -> hihat synth, shared by the AudioWorklet
// (real-time) and by Node (tests). No Web Audio / DOM dependencies here.
//
// This mirrors the Python engine: gamma-renewal timing, filtered-noise grains,
// click-free envelope, pink-noise rain bed. See ../rain_to_hihat/ for the
// reference implementation and the README for the model.

const TWO_PI = Math.PI * 2;
const DB60 = 6.9078; // exp(-6.9078) ~= 1e-3  -> decay_ms is the -60 dB time

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a, b, m) => a + (b - a) * m;
const loglerp = (a, b, m) => a * Math.pow(b / a, m);

// --- morph endpoint tables (rain @ m=0  ->  hi-hat @ m=1) ---
const RAIN = { center_hz: 2800, q: 0.7, attack_ms: 3.0, decay_ms: 90, rate_hz: 16 };
const HIHAT = { center_hz: 9000, q: 1.4, attack_ms: 0.5, decay_ms: 22, rate_hz: 4 };
const RAND_RAIN = { center_jitter_sigma: 0.35, q_jitter: 0.20, decay_jitter_sigma: 0.20, attack_jitter_sigma: 0.10, gain_jitter: 0.25, fat_drop_prob: 0.05 };
const RAND_HIHAT = { center_jitter_sigma: 0.08, q_jitter: 0.0, decay_jitter_sigma: 0.0, attack_jitter_sigma: 0.0, gain_jitter: 0.05, fat_drop_prob: 0.0 };
export const BED_FADE_END = 1.0; // bed now fades smoothly across the whole morph

// Map the macro knobs to a concrete parameter set. Overrides that are null/
// undefined "follow" the morph; pass a number to decouple. Matches morph.resolve.
export function resolve(o = {}) {
  const m = clamp(o.morph ?? 0, 0, 1);
  const has = (v) => v !== null && v !== undefined;

  let rate;
  if (has(o.bpm)) rate = (o.bpm / 60) * (o.subdiv ?? 4); // events per beat (subdiv: 1=1/4, 2=1/8, 4=1/16)
  else if (has(o.mean_rate_hz)) rate = o.mean_rate_hz;
  else rate = loglerp(RAIN.rate_hz, HIHAT.rate_hz, m);

  const bedFade = 0.5 * (1 + Math.cos(Math.PI * Math.min(m / BED_FADE_END, 1)));

  return {
    center_hz: has(o.brightness_hz) ? o.brightness_hz : loglerp(RAIN.center_hz, HIHAT.center_hz, m),
    q: has(o.resonance_q) ? o.resonance_q : lerp(RAIN.q, HIHAT.q, m),
    attack_ms: has(o.attack_ms) ? o.attack_ms : lerp(RAIN.attack_ms, HIHAT.attack_ms, m),
    decay_ms: loglerp(RAIN.decay_ms, HIHAT.decay_ms, m) * (o.decay_scale ?? 1),
    rate_hz: rate,
    regularity: has(o.regularity) ? o.regularity : m,
    center_jitter_sigma: lerp(RAND_RAIN.center_jitter_sigma, RAND_HIHAT.center_jitter_sigma, m),
    q_jitter: lerp(RAND_RAIN.q_jitter, RAND_HIHAT.q_jitter, m),
    decay_jitter_sigma: lerp(RAND_RAIN.decay_jitter_sigma, RAND_HIHAT.decay_jitter_sigma, m),
    attack_jitter_sigma: lerp(RAND_RAIN.attack_jitter_sigma, RAND_HIHAT.attack_jitter_sigma, m),
    gain_jitter: has(o.gain_jitter) ? o.gain_jitter : lerp(RAND_RAIN.gain_jitter, RAND_HIHAT.gain_jitter, m),
    fat_drop_prob: lerp(RAND_RAIN.fat_drop_prob, RAND_HIHAT.fat_drop_prob, m),
    bed_gain: bedFade * (o.bed_level ?? 0.5),
    stereo_spread: (o.stereo_spread ?? 0.4) * (1 - 0.7 * m),
    swing: o.swing ?? 0,
    metallic: o.metallic ?? 0,
  };
}

// gamma shape for regularity r in [0,1];  CV(IOI) = 1 - r exactly.
export function shapeFromRegularity(r) {
  r = clamp(r, 0, 0.999);
  return Math.pow(1 - r, -2);
}

// --- seedable RNG (mulberry32) + gaussian + gamma ---
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
  // Marsaglia-Tsang gamma, shape k >= 1, scale = 1 (caller scales).
  gamma(k) {
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

// --- RBJ bandpass biquad (constant 0 dB peak), cascaded x2 ~ 4-pole butter ---
function bandpassCoeffs(f0, Q, fs) {
  const w0 = (TWO_PI * f0) / fs, cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * Q);
  const a0 = 1 + alpha;
  return [alpha / a0, 0, -alpha / a0, (-2 * cw) / a0, (1 - alpha) / a0]; // b0,b1,b2,a1,a2
}
function biquadInPlace(buf, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    buf[i] = y;
  }
}

// click-free envelope: raised-cosine attack -> exp decay -> forced tail to 0.
export function grainEnv(attackMs, decayMs, fs) {
  const na = Math.max(2, Math.round((attackMs * fs) / 1000));
  const nd = Math.max(2, Math.round((decayMs * fs) / 1000));
  const e = new Float32Array(na + nd);
  for (let i = 0; i < na; i++) e[i] = 0.5 * (1 - Math.cos((Math.PI * i) / na));
  const tau = nd / DB60;
  for (let i = 0; i < nd; i++) e[na + i] = Math.exp(-i / tau);
  const nf = Math.min(48, nd);
  for (let i = 0; i < nf; i++) e[na + nd - nf + i] *= 0.5 * (1 + Math.cos((Math.PI * (i + 1)) / nf));
  return e; // peak is 1.0 at e[na]
}

const METAL_RATIOS = [1.34, 1.78];
const METAL_WEIGHTS = [0.6, 0.4];

// Synthesize one grain (mono Float32Array), RMS-normalized then * gain jitter.
export function synthGrain(p, fs, rng) {
  const fcMax = Math.min(17000, fs / 2 - 100);
  let fc = p.center_hz * Math.exp(p.center_jitter_sigma * clamp(rng.gauss(), -2, 2));
  fc = clamp(fc, 20, fcMax);
  const Q = clamp(p.q * (1 + p.q_jitter * (rng.uniform() * 2 - 1)), 0.4, 8);
  const decay = p.decay_ms * Math.exp(p.decay_jitter_sigma * clamp(rng.gauss(), -2, 2));
  const attack = Math.max(0.3, p.attack_ms * Math.exp(p.attack_jitter_sigma * clamp(rng.gauss(), -2, 2)));
  let amp = 1 + p.gain_jitter * (rng.uniform() * 2 - 1);
  if (rng.uniform() < p.fat_drop_prob) amp *= 1.5 + 0.5 * rng.uniform();

  const env = grainEnv(attack, decay, fs);
  const N = env.length;
  const noise = new Float32Array(N);
  for (let i = 0; i < N; i++) noise[i] = rng.gauss();

  const c = bandpassCoeffs(fc, Q, fs);
  const base = noise.slice();
  biquadInPlace(base, c); biquadInPlace(base, c);

  let sig = base;
  if (p.metallic > 0) {
    const multi = base.slice();
    for (let r = 0; r < METAL_RATIOS.length; r++) {
      const cc = bandpassCoeffs(clamp(fc * METAL_RATIOS[r], 20, fcMax), Q * 1.2, fs);
      const part = noise.slice();
      biquadInPlace(part, cc); biquadInPlace(part, cc);
      for (let i = 0; i < N; i++) multi[i] += METAL_WEIGHTS[r] * part[i];
    }
    sig = new Float32Array(N);
    for (let i = 0; i < N; i++) sig[i] = (1 - p.metallic) * base[i] + p.metallic * multi[i];
  }

  let ss = 0;
  for (let i = 0; i < N; i++) { sig[i] *= env[i]; ss += sig[i] * sig[i]; }
  const rms = Math.sqrt(ss / N);
  const g = rms > 0 ? amp / rms : 0;
  for (let i = 0; i < N; i++) sig[i] *= g;
  return sig;
}

// Continuous rain "sheet": pink noise -> HP 300 -> LP 6000 -> slow AM.
export class BedGenerator {
  constructor(seed, fs) {
    this.rng = new RNG((seed ^ 0x9e3779b9) >>> 0);
    this.fs = fs;
    this.pb = [0, 0, 0, 0, 0, 0, 0];
    this.lpHP = 0; this.lpLP = 0; this.amPhase = 0;
    this.aHP = 1 - Math.exp((-TWO_PI * 300) / fs);
    this.aLP = 1 - Math.exp((-TWO_PI * 6000) / fs);
  }
  // morph 0 = wavy pink "rain sheet"; morph 1 = steady, brighter white noise.
  sample(morph = 0) {
    const m = morph < 0 ? 0 : morph > 1 ? 1 : morph;
    const w = this.rng.gauss() * 0.5;
    const pb = this.pb;
    pb[0] = 0.99886 * pb[0] + w * 0.0555179;
    pb[1] = 0.99332 * pb[1] + w * 0.0750759;
    pb[2] = 0.969 * pb[2] + w * 0.153852;
    pb[3] = 0.8665 * pb[3] + w * 0.3104856;
    pb[4] = 0.55 * pb[4] + w * 0.5329522;
    pb[5] = -0.7616 * pb[5] - w * 0.016898;
    let pink = pb[0] + pb[1] + pb[2] + pb[3] + pb[4] + pb[5] + pb[6] + w * 0.5362;
    pb[6] = w * 0.115926;
    pink *= 0.5;
    // blend toward raw white as the morph rises (flatter, "hyper-regular")
    const whiten = m * 0.7;
    const src = pink * (1 - whiten) + w * whiten;
    this.lpHP += this.aHP * (src - this.lpHP);
    const hp = src - this.lpHP;
    const aLP = 1 - Math.exp((-TWO_PI * (6000 + 6000 * m)) / this.fs); // open the low-pass
    this.lpLP += aLP * (hp - this.lpLP);
    // AM depth shrinks from +/-3 dB (waves) to 0 (steady hiss)
    this.amPhase += (TWO_PI * 0.3) / this.fs;
    if (this.amPhase > TWO_PI) this.amPhase -= TWO_PI;
    const am = Math.pow(10, (3 * (1 - m) * Math.sin(this.amPhase)) / 20);
    return this.lpLP * am * 2.2;
  }
}
