// Main thread: audio graph (AudioWorklet + analyser), knob wiring, the
// "follow morph" link logic, the reactive visualizer, duration-based morph
// automations, the preset gallery, and the per-parameter info panel.
import { resolve } from './dsp-core.js';
import { Knob } from './knob.js';

const lerp = (a, b, m) => a + (b - a) * m;
const loglerp = (a, b, m) => (a > 0 && b > 0 ? a * Math.pow(b / a, m) : lerp(a, b, m));
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// --- secondary controls; `follows` knobs track morph until grabbed/unlinked ---
const CONTROLS = [
  { id: 'regularity', label: 'REG', min: 0, max: 0.999, def: 0, follows: 'regularity', fmt: (v) => v.toFixed(2),
    info: 'Régularité du rythme. 0 = aléatoire (Poisson — crépitement de pluie), 1 = métronomique (grille parfaite). Le coefficient de variation des intervalles vaut exactement 1 − valeur.' },
  { id: 'mean_rate_hz', label: 'RATE', min: 1, max: 30, def: 16, follows: 'rate_hz', fmt: (v) => v.toFixed(1) + '/s',
    info: 'Débit moyen d’évènements par seconde. Élevé = crépitement dense ; faible = ticks espacés.' },
  { id: 'brightness_hz', label: 'BRIGHT', min: 800, max: 12000, def: 2800, follows: 'center_hz', log: true,
    fmt: (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)) + 'Hz',
    info: 'Fréquence centrale du filtre de chaque grain. Bas = goutte sourde et large ; haut = tick métallique brillant.' },
  { id: 'resonance_q', label: 'RES', min: 0.4, max: 4, def: 0.7, follows: 'q', fmt: (v) => v.toFixed(2),
    info: 'Résonance (Q) du filtre. Bas = doux/large (goutte) ; haut = sonnerie étroite et métallique (hi-hat).' },
  { id: 'decay_scale', label: 'DECAY', min: 0.3, max: 3, def: 1, fmt: (v) => v.toFixed(2) + '×',
    info: 'Longueur de la queue de chaque grain. <1 = court et sec/métallique ; >1 = mouillé et éclaboussant.' },
  { id: 'bed_level', label: 'BED', min: 0, max: 1, def: 0.5, fmt: (v) => v.toFixed(2),
    info: 'Niveau du voile de pluie continu (bruit rose). Porte la masse sonore de la pluie ; s’efface vers le hi-hat.' },
  { id: 'swing', label: 'SWING', min: 0, max: 0.6, def: 0, fmt: (v) => v.toFixed(2),
    info: 'Décale un évènement sur deux pour donner un groove au bout hi-hat. 0 = droit.' },
  { id: 'stereo_spread', label: 'WIDTH', min: 0, max: 1, def: 0.4, fmt: (v) => v.toFixed(2),
    info: 'Largeur stéréo : dispersion gauche/droite des évènements (mono → large).' },
  { id: 'metallic', label: 'METAL', min: 0, max: 1, def: 0, fmt: (v) => v.toFixed(2),
    info: 'Ajoute des partiels inharmoniques (sommes de bandes) pour un caractère de cymbale plus métallique.' },
];

const MORPH_INFO = 'Bouton phare. 0 = pluie (gouttes aléatoires, large bande) · 1 = hi-hats réguliers (ticks métalliques sur une grille). Pilote d’un coup le timbre, le débit, la régularité et le voile de pluie.';
const EXTRA_INFO = [
  { label: 'AUTO', info: 'Automation : fait évoluer MORPH tout seul sur la durée choisie. ↑ pluie→hi-hat · ↓ hi-hat→pluie · ⇄ boucle aller-retour.' },
  { label: 'SEED', info: 'Graine du générateur aléatoire : même graine = rendu identique et reproductible.' },
  { label: 'MASTER', info: 'Volume de sortie (en haut à droite).' },
  { label: '◖ pastille', info: 'Une pastille allumée sous un knob = ce paramètre suit MORPH. Tourne le knob ou clique la pastille pour le décrocher.' },
];

const PRESETS = [
  { name: 'averse', o: { morph: 0, bed_level: 0.85, mean_rate_hz: 22, regularity: 0 } },
  { name: 'bruine', o: { morph: 0.3, bed_level: 0.4 } },
  { name: 'goutte-à-goutte', o: { morph: 0, mean_rate_hz: 2.5, bed_level: 0.12, decay_scale: 1.6 } },
  { name: 'toit métal', o: { morph: 0.2, brightness_hz: 7000, resonance_q: 2.2, metallic: 0.45, bed_level: 0.5 } },
  { name: 'glitch', o: { morph: 0.62, regularity: 0.18, gain_jitter: 0.5, metallic: 0.6, mean_rate_hz: 11 } },
  { name: 'feu', o: { morph: 0.72, regularity: 0.12, decay_scale: 0.5, mean_rate_hz: 8, brightness_hz: 6500, gain_jitter: 0.5, bed_level: 0.3 } },
  { name: 'shimmer', o: { morph: 0.8, stereo_spread: 1, metallic: 0.55, decay_scale: 1.4, brightness_hz: 9000 } },
  { name: 'hi-hats', o: { morph: 1, regularity: 1 } },
  { name: 'trap', o: { morph: 1, mean_rate_hz: 9.3, swing: 0.32, regularity: 1, metallic: 0.2 } },
  { name: 'métronome', o: { morph: 1, regularity: 1, mean_rate_hz: 4, metallic: 0, decay_scale: 0.7 } },
];

// transition presets: an animated A -> B journey over a duration (every macro
// in either endpoint is interpolated; unspecified ones follow the morph).
const TRANSITIONS = [
  { name: 'pluie → hihat', dur: 8, mode: 'once', from: { morph: 0 }, to: { morph: 1 } },
  { name: 'hihat → pluie', dur: 8, mode: 'once', from: { morph: 1 }, to: { morph: 0 } },
  { name: 'boucle ⇄', dur: 14, mode: 'loop', from: { morph: 0 }, to: { morph: 1 } },
  { name: 'averse qui se calme', dur: 12, mode: 'once', from: { morph: 0, bed_level: 0.9, mean_rate_hz: 24 }, to: { morph: 0.15, bed_level: 0.12, mean_rate_hz: 4, decay_scale: 1.5 } },
  { name: 'build-up', dur: 10, mode: 'once', from: { morph: 0.1, regularity: 0, mean_rate_hz: 6 }, to: { morph: 1, regularity: 1, mean_rate_hz: 12 } },
  { name: 'goutte → trap', dur: 11, mode: 'once', from: { morph: 0, mean_rate_hz: 3, bed_level: 0.2 }, to: { morph: 1, regularity: 1, mean_rate_hz: 9.3, swing: 0.32, metallic: 0.2 } },
  { name: 'orage qui passe', dur: 16, mode: 'loop', from: { morph: 0, bed_level: 0.18, mean_rate_hz: 6 }, to: { morph: 0, bed_level: 0.95, mean_rate_hz: 26 } },
  { name: 'métal montant', dur: 9, mode: 'once', from: { morph: 0.3, metallic: 0, brightness_hz: 2500 }, to: { morph: 0.9, metallic: 0.85, brightness_hz: 10000 } },
];

const state = { morph: 0, master: 0.8, seed: 1, accentHue: 190, sync: false, bpm: 120, subdiv: 4, mode: 'synth', synthScene: 'rain' };
let ctx = null, node = null, analyser = null, freqData, timeData, rafId = null;
let playing = false, autoRAF = null, autoActive = null;
let editA = null, editB = null, userTrans = [];
let masterGain = null, synthGain = null, beachGain = null, beachVoices = null;
let popBuf = null, fireTimer = null, stormTimer = null, rainTimer = null;
// beach mode: four mixable elements, each with a sound layer + a visual layer.
const beach = {
  waves: { on: true, level: 0.6 }, wind: { on: false, level: 0.5 },
  rain: { on: true, level: 0.55 }, fire: { on: false, level: 0.6 },
  storm: { on: false, level: 0.6 },
};
const knobs = [];
const knobMap = {};
let morphKnob, stage, garden;

// ---------- genome (Synplant-style explorer): a full sound INCLUDING its rhythm ----------
const hueFor = (m) => 190 + (32 - 190) * m;
const GENES = [
  { id: 'morph', min: 0, max: 1 },
  { id: 'brightness_hz', min: 800, max: 11000, log: true },
  { id: 'resonance_q', min: 0.4, max: 4 },
  { id: 'decay_scale', min: 0.3, max: 3, log: true },
  { id: 'mean_rate_hz', min: 1.5, max: 26, log: true },  // rhythm: how many sounds
  { id: 'regularity', min: 0, max: 0.999 },               // rhythm: random <-> regular
  { id: 'swing', min: 0, max: 0.6 },                       // rhythm: groove
  { id: 'bed_level', min: 0, max: 0.9 },
  { id: 'stereo_spread', min: 0, max: 1 },
  { id: 'metallic', min: 0, max: 1 },
];
const _gnorm = (g, v) => (g.log ? Math.log(v / g.min) / Math.log(g.max / g.min) : (v - g.min) / (g.max - g.min));
const _gden = (g, t) => { t = clamp(t, 0, 1); return g.log ? g.min * Math.pow(g.max / g.min, t) : g.min + t * (g.max - g.min); };
function randomGenome() { const o = {}; for (const g of GENES) o[g.id] = _gden(g, Math.random()); return o; }
function mutateGenome(parent, amt) {
  const o = {};
  for (const g of GENES) {
    const t = _gnorm(g, parent[g.id]);
    const step = (Math.random() * 2 - 1) * (Math.random() < 0.7 ? amt : amt * 0.35);
    o[g.id] = _gden(g, clamp(t + step, 0, 1));
  }
  return o;
}
function pushGenome(gen) {
  state.morph = clamp(gen.morph, 0, 1);
  setAccent(state.morph);
  if (node) node.port.postMessage({ type: 'params', params: resolve(gen), morph: state.morph, master: state.master });
}

// ---------- accent (morph-driven hue: cyan rain -> amber hi-hat) ----------
function setAccent(m) {
  const hue = hueFor(m);
  state.accentHue = hue;
  const root = document.documentElement.style;
  root.setProperty('--accent', `hsl(${hue} 88% 62%)`);
  root.setProperty('--accent-dim', `hsl(${hue} 60% 40% / 0.35)`);
}

// ---------- param plumbing ----------
function buildMacros() {
  const o = { morph: state.morph, seed: state.seed };
  for (const k of knobs) o[k.id] = k.follows ? (k.linked ? null : k.value) : k.value;
  if (state.sync) { o.bpm = state.bpm; o.subdiv = state.subdiv; } // tempo overrides rate
  return o;
}
function reassertSync() {
  const rk = knobMap.mean_rate_hz;
  if (!rk) return;
  rk.el.classList.toggle('locked', state.sync);
  if (state.sync) { rk.setLinked(false); rk.setValue(clamp((state.bpm / 60) * state.subdiv, 1, 30), true); }
}
const currentResolved = () => resolve(buildMacros());
function pushParams() {
  setAccent(state.morph);
  if (node) node.port.postMessage({ type: 'params', params: currentResolved(), morph: state.morph, master: state.master });
}
function updateFollowers() {
  const base = resolve({ morph: state.morph });
  for (const k of knobs) if (k.follows && k.linked) k.setValue(base[k.follows], true);
}
function setMorph(v, keepPreset) {
  state.morph = clamp(v, 0, 1);
  morphKnob.setValue(state.morph, true);
  updateFollowers();
  pushParams();
  if (!keepPreset) clearPresetHighlight();
}

// ---------- audio ----------
async function initAudio() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.audioWorklet.addModule('rainhihat-processor.js');
  masterGain = ctx.createGain();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.82;
  masterGain.connect(analyser); analyser.connect(ctx.destination);
  freqData = new Uint8Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.fftSize);
  // synth voice (the morph instrument)
  synthGain = ctx.createGain();
  node = new AudioWorkletNode(ctx, 'rainhihat-processor', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { params: currentResolved(), morph: state.morph, master: state.master, seed: state.seed },
  });
  node.port.onmessage = (e) => { if (e.data.type === 'onset' && stage && state.mode === 'synth') stage.onset(e.data.pan); };
  node.connect(synthGain); synthGain.connect(masterGain);
  pushParams();
  _route();
}
function _noiseSrc() {
  const len = Math.floor(ctx.sampleRate * 3);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start();
  return s;
}
function buildBeach() {
  if (beachVoices) return;
  beachGain = ctx.createGain(); beachGain.connect(masterGain);
  const v = {};
  // WAVES: band-limited noise that swells and ebbs on slow LFOs — a wave wash
  { const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 720; bp.Q.value = 0.55;
    const g = ctx.createGain(); g.gain.value = 0; _noiseSrc().connect(bp); bp.connect(g); g.connect(beachGain);
    const l1 = ctx.createOscillator(); l1.frequency.value = 0.18; const d1 = ctx.createGain(); d1.gain.value = 0; l1.connect(d1); d1.connect(g.gain); l1.start();
    const l2 = ctx.createOscillator(); l2.frequency.value = 0.27; const d2 = ctx.createGain(); d2.gain.value = 0; l2.connect(d2); d2.connect(g.gain); l2.start();
    v.waves = { g, d1, d2 }; }
  // WIND: near-continuous broadband white-noise hiss with gentle breathing
  { const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 280;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
    const g = ctx.createGain(); g.gain.value = 0; _noiseSrc().connect(hp); hp.connect(lp); lp.connect(g); g.connect(beachGain);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.15; const ld = ctx.createGain(); ld.gain.value = 0; lfo.connect(ld); ld.connect(g.gain); lfo.start();
    v.wind = { g, ld }; }
  // FIRE roar: a quiet, dark warm rumble (kept low so crackles lead, not hiss)
  { const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 400; bp.Q.value = 0.7;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120;
    const g = ctx.createGain(); g.gain.value = 0;
    _noiseSrc().connect(bp); bp.connect(hp); hp.connect(g); g.connect(beachGain);
    const fl = _noiseSrc(); const flp = ctx.createBiquadFilter(); flp.type = 'lowpass'; flp.frequency.value = 7;
    const fd = ctx.createGain(); fd.gain.value = 0; fl.connect(flp); flp.connect(fd); fd.connect(g.gain);
    v.fireRoar = { g, fd }; }
  // FIRE crackle bus (short "pops" scheduled on the main thread -> see fireSchedule)
  { const g = ctx.createGain(); g.gain.value = 1; g.connect(beachGain); v.fireCrackle = { g }; }
  popBuf = (() => { const bb = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate); const d = bb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return bb; })();
  // STORM thunder bus (physical N-wave strikes rendered offline by thunder())
  { const g = ctx.createGain(); g.gain.value = 0; g.connect(beachGain); v.thunder = { g }; }
  // RAIN: Minnaert bubble resonances (a damped sine per drop) + a faint far wash
  { const g = ctx.createGain(); g.gain.value = 0; g.connect(beachGain);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2500; bp.Q.value = 0.6;
    const bg = ctx.createGain(); bg.gain.value = 0; _noiseSrc().connect(bp); bp.connect(bg); bg.connect(g);
    v.rain = { g, bg }; }
  beachVoices = v;
  updateBeach();
  fireSchedule();
  stormSchedule();
  rainSchedule();
}
// thunder: PHYSICAL model. Synthesize one strike offline by summing N-waves from
// every segment of a tortuous lightning channel, each delayed by its range/343 and
// low-passed by distance-dependent air absorption. The rolling rumble and the claps
// EMERGE from the channel geometry (near = sharp crack, far = dark rumble).
function thunder(amp, near) {
  if (!beachVoices || !ctx) return;
  const fs = ctx.sampleRate;
  // 1) channel: a random walk of segments; nearest range set by `near`
  const M = 50 + (Math.random() * 30 | 0), Rmin = 250 + (1 - near) * 1600;
  let x = (Math.random() * 2 - 1) * Rmin * 0.3, y = 4, z = Rmin;
  let hx = (Math.random() * 2 - 1) * 0.6, hy = 1, hz = (Math.random() * 2 - 1) * 0.6;
  const segs = [];
  for (let i = 0; i < M; i++) {
    const L = 20 + Math.random() * 40;
    hx += (Math.random() * 2 - 1) * 0.6; hy += (Math.random() * 2 - 1) * 0.25 + 0.15; hz += (Math.random() * 2 - 1) * 0.6;
    const hn = Math.hypot(hx, hy, hz) || 1; x += hx / hn * L; y += hy / hn * L; z += hz / hn * L;
    const R = Math.max(60, Math.hypot(x, y, z));
    segs.push({ R, a: (0.4 + Math.random() * 0.6) * (1 - (i / M) * 0.55), d: R / 343, dr: Math.sqrt(R * R + 16) / 343, tau: 0.0006 * (1 + R / 2000), fc: Math.min(9000, Math.max(120, 9000 * (400 / R) * (400 / R))) });
  }
  let dmin = Infinity, drmax = 0, tauMax = 0;
  for (const s of segs) { if (s.d < dmin) dmin = s.d; if (s.dr > drmax) drmax = s.dr; if (s.tau > tauMax) tauMax = s.tau; }
  const N = Math.ceil((drmax - dmin + 2 * tauMax + 0.35) * fs), buf = new Float32Array(N);
  // 2) write each segment's air-absorption-filtered N-wave (+ ground reflection)
  const writeN = (off, A, tau, fc) => {
    const n = Math.max(2, Math.round(2 * tau * fs)), gg = Math.exp(-2 * Math.PI * fc / fs), span = tau * fs; let yv = 0;
    for (let i = 0; i < n; i++) { yv += (1 - gg) * (A * (1 - i / span) - yv); const idx = off + i; if (idx >= 0 && idx < N) buf[idx] += yv; }
  };
  for (const s of segs) {
    const sp = Math.min(1, 300 / s.R);
    writeN(Math.round((s.d - dmin) * fs), 0.8 * sp * s.a, s.tau, s.fc);
    writeN(Math.round((s.dr - dmin) * fs), 0.8 * sp * s.a * 0.7, s.tau, s.fc * 0.7); // ground reflection
  }
  // 3) sub boom (integrated low end of the nearest shock)
  const subN = Math.min(N, Math.round(0.6 * fs));
  for (let i = 0; i < subN; i++) { const tt = i / fs; buf[i] += near * 0.9 * Math.sin(2 * Math.PI * 46 * tt) * Math.exp(-tt / 0.25); }
  // 4) normalize + soft clip, then play the rendered strike
  let pk = 0; for (let i = 0; i < N; i++) { const av = buf[i] < 0 ? -buf[i] : buf[i]; if (av > pk) pk = av; }
  const norm = pk > 0 ? 1.0 / pk : 1; for (let i = 0; i < N; i++) buf[i] = Math.tanh(buf[i] * norm * 1.1);
  const ab = ctx.createBuffer(1, N, fs); ab.copyToChannel(buf, 0);
  const src = ctx.createBufferSource(); src.buffer = ab;
  const g = ctx.createGain(); g.gain.value = Math.min(1.2, amp);
  src.connect(g); g.connect(beachVoices.thunder.g); src.start();
}
// schedule strikes: flash now, thunder after the light->sound gap (closer = sooner).
function stormSchedule() {
  clearTimeout(stormTimer);
  const tick = () => {
    if (beachVoices && beach.storm.on && playing && state.mode === 'beach' && ctx && ctx.state === 'running') {
      const near = Math.random();
      if (stage) stage.lightning((0.5 + 0.5 * near) * (0.7 + 0.3 * beach.storm.level));
      const gap = 0.12 + (1 - near) * 1.7;
      setTimeout(() => { if (beach.storm.on && playing) thunder((0.6 + 0.6 * near) * beach.storm.level, near); }, gap * 1000);
    }
    stormTimer = setTimeout(tick, (11000 - 6500 * beach.storm.level) * (0.5 + Math.random()));
  };
  stormTimer = setTimeout(tick, 1800);
}
// one raindrop on water: the Minnaert resonance of the entrained bubble = a damped
// sine at f0 = 3260/d_bub(mm) Hz (with a few-percent up-chirp), preceded by a faint
// broadband impact click.
function dropEvent() {
  if (!beachVoices || !popBuf || !ctx) return;
  const t = ctx.currentTime, bus = beachVoices.rain.g, lvl = beach.rain.level;
  const d = Math.min(3, Math.max(0.35, 0.35 + (-Math.log(Math.random())) * (0.5 + lvl * 0.5))); // bubble dia (mm)
  const f0 = Math.min(9000, Math.max(700, 3260 / d));
  const Q = 12 + ((f0 - 1000) / 5500) * 18;        // ~12..30, rises with f0
  const tau = Q / (Math.PI * f0), amp = (0.25 + Math.random() * 0.5) * lvl * 0.5;
  // damped sine with a short up-chirp (bubble shrinks as it detaches)
  const osc = ctx.createOscillator(); osc.type = 'sine';
  osc.frequency.setValueAtTime(f0 * 1.03, t + 0.002);
  osc.frequency.exponentialRampToValueAtTime(f0, t + 0.004);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, t + 0.002);
  og.gain.exponentialRampToValueAtTime(Math.max(0.002, amp), t + 0.0026);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.002 + Math.max(0.012, tau * 6.9));
  osc.connect(og); og.connect(bus); osc.start(t); osc.stop(t + 0.05 + tau * 8);
  // impact click (the splash crown)
  const s = ctx.createBufferSource(); s.buffer = popBuf;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.0001, t); cg.gain.exponentialRampToValueAtTime(Math.max(0.002, amp * 0.4), t + 0.0004); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.004);
  s.connect(hp); hp.connect(cg); cg.connect(bus); s.start(t); s.stop(t + 0.02);
  if (stage) stage.beachOnset('rain');
}
// Poisson rain: heavier rain (level) -> more drops + bigger/lower-pitched ones.
function rainSchedule() {
  clearTimeout(rainTimer);
  const tick = () => {
    if (beachVoices && beach.rain.on && playing && state.mode === 'beach' && ctx && ctx.state === 'running') dropEvent();
    const rate = 5 + beach.rain.level * 25; // drops/sec
    rainTimer = setTimeout(tick, (-Math.log(Math.random()) / rate) * 1000); // exponential inter-arrival
  };
  rainTimer = setTimeout(tick, 200);
}
// one short crackle "pop": a brief band-passed noise burst with a fast decay.
function firePop(amp) {
  if (!beachVoices || !popBuf || !ctx) return;
  const t = ctx.currentTime, len = 0.003 + Math.random() * 0.016;
  const src = ctx.createBufferSource(); src.buffer = popBuf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = 500 + Math.random() * 3500; bp.Q.value = 0.8 + Math.random() * 2.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.002, amp), t + 0.0012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(bp); bp.connect(g); g.connect(beachVoices.fireCrackle.g);
  src.start(t); src.stop(t + len + 0.02);
}
// a bigger, rarer wood CRACK: a woody low "knock" + a sharp high "snap".
function fireCrack(amp) {
  if (!beachVoices || !popBuf || !ctx) return;
  const t = ctx.currentTime, bus = beachVoices.fireCrackle.g;
  // low woody knock (the body of the snapping log)
  const len = 0.04 + Math.random() * 0.07;
  const s1 = ctx.createBufferSource(); s1.buffer = popBuf;
  const bp1 = ctx.createBiquadFilter(); bp1.type = 'bandpass'; bp1.frequency.value = 170 + Math.random() * 320; bp1.Q.value = 2 + Math.random() * 3;
  const g1 = ctx.createGain();
  g1.gain.setValueAtTime(0.0001, t);
  g1.gain.exponentialRampToValueAtTime(Math.max(0.003, amp), t + 0.001);
  g1.gain.exponentialRampToValueAtTime(0.0001, t + len);
  s1.connect(bp1); bp1.connect(g1); g1.connect(bus); s1.start(t); s1.stop(t + len + 0.02);
  // sharp high snap on top
  const s2 = ctx.createBufferSource(); s2.buffer = popBuf;
  const bp2 = ctx.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = 3000 + Math.random() * 3200; bp2.Q.value = 1.2;
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.0001, t);
  g2.gain.exponentialRampToValueAtTime(Math.max(0.003, amp * 0.8), t + 0.0006);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
  s2.connect(bp2); bp2.connect(g2); g2.connect(bus); s2.start(t); s2.stop(t + 0.03);
}
// schedule crackles: sparse, irregular, in occasional bursts (like real wood),
// punctuated by the occasional bigger crack.
function fireSchedule() {
  clearTimeout(fireTimer);
  const tick = () => {
    if (beachVoices && beach.fire.on && playing && state.mode === 'beach' && ctx && ctx.state === 'running') {
      if (Math.random() < 0.16) {
        fireCrack((0.5 + Math.random() * 0.5) * beach.fire.level); // big wood crack
        if (stage) stage.fireFlare();
      } else {
        const reps = Math.random() < 0.18 ? 2 + (Math.random() * 2 | 0) : 1;
        for (let i = 0; i < reps; i++) setTimeout(() => {
          if (beach.fire.on && playing) { firePop((0.2 + Math.random() * 0.8) * beach.fire.level); if (stage) stage.beachOnset('fire'); }
        }, i * (25 + Math.random() * 55));
      }
    }
    fireTimer = setTimeout(tick, 150 + Math.random() * 500);
  };
  fireTimer = setTimeout(tick, 300);
}
function updateBeach() {
  if (!beachVoices || !ctx) return;
  const t = ctx.currentTime, T = 0.15, set = (g, v) => g.gain.setTargetAtTime(v, t, T);
  const W = beach.waves, Wi = beach.wind, R = beach.rain, F = beach.fire;
  set(beachVoices.waves.g, W.on ? W.level * 0.34 : 0);    // swelling wave wash
  beachVoices.waves.d1.gain.setTargetAtTime(W.on ? W.level * 0.22 : 0, t, T);
  beachVoices.waves.d2.gain.setTargetAtTime(W.on ? W.level * 0.14 : 0, t, T);
  set(beachVoices.wind.g, Wi.on ? Wi.level * 0.42 : 0);   // near-continuous hiss
  beachVoices.wind.ld.gain.setTargetAtTime(Wi.on ? Wi.level * 0.07 : 0, t, T);
  set(beachVoices.rain.g, R.on ? 1 : 0); // per-drop amplitude scales with level (dropEvent)
  beachVoices.rain.bg.gain.setTargetAtTime(R.on ? R.level * 0.06 : 0, t, T);
  set(beachVoices.fireRoar.g, F.on ? F.level * 0.06 : 0);
  beachVoices.fireRoar.fd.gain.setTargetAtTime(F.on ? F.level * 0.04 : 0, t, T);
  set(beachVoices.thunder.g, beach.storm.on ? 1 : 0); // per-strike amplitude scales with level
}
function _route() {
  if (!masterGain || !ctx) return;
  const t = ctx.currentTime;
  const synthOn = (state.mode === 'synth' || state.mode === 'grow') && playing; // grow auditions the synth voice
  if (synthGain) synthGain.gain.setTargetAtTime(synthOn ? 1 : 0, t, 0.08);
  if (beachGain) beachGain.gain.setTargetAtTime(state.mode === 'beach' && playing ? 1 : 0, t, 0.08);
}
async function ensurePlaying() {
  if (!ctx) await initAudio();
  if (ctx.state === 'suspended') await ctx.resume();
  if (state.mode === 'beach' && !beachVoices) buildBeach();
  if (!playing) {
    if (state.mode === 'synth') { node.port.postMessage({ type: 'play', seed: state.seed }); pushParams(); }
    playing = true; setTransport();
  }
  _route();
}
function stop() {
  if (state.mode === 'synth' && node) node.port.postMessage({ type: 'stop' });
  playing = false; _route(); setTransport();
}
function setMode(m) {
  state.mode = m;
  document.querySelectorAll('.mode-btn').forEach((btn) => btn.classList.toggle('on', btn.dataset.mode === m));
  document.getElementById('synth-controls').hidden = m !== 'synth';
  document.getElementById('beach-controls').hidden = m !== 'beach';
  document.getElementById('grow-controls').hidden = m !== 'grow';
  if (m === 'beach') { if (ctx && !beachVoices) buildBeach(); stage.setScene('beach'); }
  else stage.setScene(state.synthScene);
  if (m === 'grow' && garden) { garden.fit(); ensurePlaying(); garden.audition(); } // hover-to-listen needs audio running
  _route();
}

// ---------- reactive visualizer (pixel art) ----------
// Everything is drawn onto a small low-res buffer (~160x33 cells) then blitted
// nearest-neighbor, so it reads as chunky pixels. Limited 5-tone palette derived
// from the morph hue; shading/haze use ordered (Bayer) dithering.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
class Stage {
  constructor(cv) {
    this.cv = cv; this.g = cv.getContext('2d');
    this.buf = document.createElement('canvas'); this.bg = this.buf.getContext('2d');
    this.scene = 'rain';
    this.parts = []; this.splashes = []; this.flashes = []; this.sparks = [];
    this.foam = []; this.ripples = []; this.windParts = []; this.bRain = []; this.embers = []; this.wavePhase = 0; this.windPhase = 0; this.waveScroll = 0; this.flash = 0; this.bolt = null;
    this.col = 0; this.GRID = 8; this.glow = 0; this.beatPhase = 0; this.beatGlow = 0; this.lastTs = 0;
    this.snap = { morph: 0, hue: 190, bedGain: 0.5, regularity: 0, metallic: 0, level: 0, bpm: 0 };
    this.motes = Array.from({ length: 14 }, () => ({ x: Math.random(), y: Math.random(), vx: (Math.random() * 2 - 1) * 0.03, vy: 0.02 + Math.random() * 0.05 }));
    this.fireRamp = Array.from({ length: 32 }, (_, i) => { const t = i / 31; return `hsl(${Math.min(52, t * 70)} 100% ${Math.min(98, t * 125)}%)`; });
    this.fit();
  }
  setScene(s) { this.scene = s; this._resetScene(); }
  _resetScene() {
    this.parts.length = 0; this.splashes.length = 0; this.flashes.length = 0; this.sparks.length = 0;
    this.foam.length = 0; this.ripples.length = 0; this.windParts.length = 0; this.bRain.length = 0; this.embers.length = 0;
    if (this.heat) this.heat.fill(0);
    if (this.fHeat) this.fHeat.fill(0);
    this.flash = 0; this.bolt = null;
  }
  fit() {
    this.dpr = window.devicePixelRatio || 1;
    const r = this.cv.getBoundingClientRect();
    this.W = Math.round(r.width * this.dpr); this.H = Math.round(r.height * this.dpr);
    this.cv.width = this.W; this.cv.height = this.H;
    this.g.imageSmoothingEnabled = false;
    const CELL = 6 * this.dpr;
    this.cols = Math.max(48, Math.round(this.W / CELL));
    this.rows = Math.max(18, Math.round(this.H / CELL));
    this.buf.width = this.cols; this.buf.height = this.rows;
    this.bg.imageSmoothingEnabled = false;
    this.impactRow = Math.floor(this.rows * 0.78);
    this.heat = new Float32Array(this.cols * this.rows); // fire scene
    // beach layout + campfire heat region
    this.seaRow = Math.floor(this.rows * 0.44);
    this.sandRow = Math.floor(this.rows * 0.72);
    this.fW = Math.max(9, Math.round(this.cols * 0.11));
    this.fH = Math.max(8, Math.round(this.rows * 0.42));
    this.fireX0 = Math.floor(this.cols * 0.5 - this.fW / 2);
    this.fHeat = new Float32Array(this.fW * this.fH);
  }
  onset() {
    const m = this.snap.morph;
    if (this.scene === 'waves') this._wavesOnset(m);
    else if (this.scene === 'wind') this._windOnset(m);
    else if (this.scene === 'fire') this._fireOnset(m);
    else this._rainOnset(m);
  }
  _rainOnset(m) {
    if (this.parts.length > 130) return;
    const C = this.cols;
    const gx = ((this.col++ % this.GRID) + 0.5) / this.GRID * C;
    const rx = Math.random() * C;
    const x = Math.round(rx + (gx - rx) * Math.pow(m, 1.4));
    const tail = Math.round(1 + 4 * (1 - m));
    const spawnY = m < 0.98 ? -tail - Math.random() * 3 : this.impactRow - 1;
    this.parts.push({ x, y: spawnY, vy: 14 + 28 * (1 - m), tail, m });
  }
  _wavesOnset(m) {
    const C = this.cols, gx = Math.round(((this.col++ % this.GRID) + 0.5) / this.GRID * C);
    const x = m > 0.5 ? gx : Math.floor(Math.random() * C);
    this.ripples.push({ x, r: 0, life: 1 });
    if (m > 0.3 || Math.random() < 0.5) this.foam.push({ x, life: 1 });
    this.glow = Math.min(1.3, this.glow + 0.3);
  }
  _windOnset(m) {
    if (this.windParts.length > 220) return;
    const y = Math.floor(Math.random() * this.rows), n = 2 + Math.round(m * 3);
    for (let i = 0; i < n; i++) this.windParts.push({ x: -i * 2, y: y + (Math.random() * 4 - 2), vx: 30 + 60 * (0.4 + m) + 40 * this.snap.level, life: 1, len: Math.round(2 + 4 * (1 - m)) });
    this.glow = Math.min(1.3, this.glow + 0.25);
  }
  _fireOnset(m) {
    const C = this.cols, R = this.rows, gx = Math.round(((this.col++ % this.GRID) + 0.5) / this.GRID * C);
    const x = m > 0.5 ? gx : Math.floor(Math.random() * C), w = 1 + Math.round(m * 2);
    for (let dx = -w; dx <= w; dx++) { const xx = (x + dx + C) % C; for (let y = R - 3; y < R; y++) this.heat[y * C + xx] = Math.min(1.7, this.heat[y * C + xx] + 0.9 + 0.5 * m); }
    this.glow = Math.min(1.3, this.glow + 0.3);
  }
  _impact(p) {
    const m = p.m, x = p.x;
    if (1 - m > 0.04) this.splashes.push({ x, r: 0, max: Math.round(1.5 + 3.5 * (1 - m)), life: 1 });
    if (m > 0.04) {
      this.flashes.push({ x, life: 1, h: Math.round(1 + 3 * m) });
      const ns = Math.round(m * 3);
      for (let i = 0; i < ns; i++) this.sparks.push({ x, y: this.impactRow, vx: (Math.random() * 2 - 1) * 11, vy: -(6 + Math.random() * 16), life: 1 });
    }
    this.glow = Math.min(1.3, this.glow + 0.35 * (0.4 + m));
  }
  _pal(h) {
    return [`hsl(${h} 45% 6%)`, `hsl(${h} 55% 24%)`, `hsl(${h} 78% 44%)`, `hsl(${h} 88% 63%)`, `hsl(${h} 95% 84%)`];
  }
  // a drifting wind "swirl": a flattened spiral of pixels (bright leading curl).
  _swirl(p, cBright, cDim) {
    const b = this.bg, C = this.cols, R = this.rows;
    const steps = Math.max(8, Math.round(p.size * 7));
    for (let s = 0; s < steps; s++) {
      const f = s / steps, a = f * 2.2 * 6.2832 + p.rot, r = f * p.size;
      const xx = Math.round(p.x + r * Math.cos(a)), yy = Math.round(p.y + r * Math.sin(a) * 0.6);
      if (xx >= 0 && xx < C && yy >= 0 && yy < R) { b.fillStyle = f > 0.6 ? cBright : cDim; b.fillRect(xx, yy, 1, 1); }
    }
  }
  frame(snap, ts) {
    const dt = this.lastTs ? Math.min(0.05, (ts - this.lastTs) / 1000) : 0.016;
    this.lastTs = ts; this.snap = snap;
    if (snap.bpm > 0) { this.beatPhase += (dt * snap.bpm) / 60; if (this.beatPhase >= 1) { this.beatPhase -= 1; this.beatGlow = 1; } }
    this.beatGlow *= Math.pow(0.0006, dt); this.glow *= Math.pow(0.0015, dt);
    if (this.scene === 'beach') this._drawBeach(dt);
    else if (this.scene === 'waves') this._drawWaves(dt);
    else if (this.scene === 'wind') this._drawWind(dt);
    else if (this.scene === 'fire') this._drawFire(dt);
    else this._drawRain(dt);
    this.g.imageSmoothingEnabled = false;
    this.g.clearRect(0, 0, this.W, this.H);
    this.g.drawImage(this.buf, 0, 0, this.cols, this.rows, 0, 0, this.W, this.H);
  }

  // --- scene: rain (droplets) -> hi-hat (grid ticks) ---
  _drawRain(dt) {
    const b = this.bg, C = this.cols, R = this.rows, IR = this.impactRow, snap = this.snap, P = this._pal(snap.hue);
    const px = (x, y, c) => { b.fillStyle = c; b.fillRect(x, y, 1, 1); };
    b.fillStyle = P[0]; b.fillRect(0, 0, C, R);
    if (snap.bedGain > 0.01) for (let y = 0; y < IR; y++) {
      const inten = snap.bedGain * (1 - y / IR) * 0.55;
      for (let x = 0; x < C; x++) if (BAYER[(y & 3) * 4 + (x & 3)] / 16 < inten) px(x, y, P[1]);
    }
    for (const mt of this.motes) {
      mt.x += mt.vx * dt; mt.y += mt.vy * dt;
      if (mt.y > 1) mt.y -= 1; if (mt.x < 0) mt.x += 1; if (mt.x > 1) mt.x -= 1;
      px(Math.floor(mt.x * C), Math.floor(mt.y * IR), P[1]);
    }
    const gOn = snap.regularity * (0.5 + 0.5 * this.beatGlow);
    if (gOn > 0.05) for (let i = 0; i < this.GRID; i++) {
      const x = Math.floor(((i + 0.5) / this.GRID) * C);
      for (let y = (IR / 5) | 0; y < IR; y += 2) if (BAYER[(y & 3) * 4 + (x & 3)] / 16 < gOn) px(x, y, P[2]);
    }
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]; p.y += p.vy * dt;
      const hy = Math.min(Math.round(p.y), IR);
      for (let t = 0; t < p.tail; t++) { const yy = hy - t; if (yy >= 0 && yy < R) px(p.x, yy, t === 0 ? P[4] : t === 1 ? P[3] : P[2]); }
      if (p.y >= IR) { this._impact(p); this.parts.splice(i, 1); }
    }
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const s = this.splashes[i]; s.r += dt * 16; s.life -= dt * 2.4;
      if (s.life <= 0) { this.splashes.splice(i, 1); continue; }
      const rr = Math.round(s.r), c = s.life > 0.5 ? P[3] : P[2];
      if (rr <= s.max) { if (s.x - rr >= 0) px(s.x - rr, IR, c); if (s.x + rr < C) px(s.x + rr, IR, c); px(s.x, IR - Math.min(1, rr), c); }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i]; f.life -= dt * 5;
      if (f.life <= 0) { this.flashes.splice(i, 1); continue; }
      const c = f.life > 0.5 ? P[4] : P[3], h = Math.max(1, Math.round(f.h * f.life));
      for (let y = 0; y < h; y++) px(f.x, IR - y, c);
      if (f.life > 0.6) { if (f.x - 1 >= 0) px(f.x - 1, IR, P[2]); if (f.x + 1 < C) px(f.x + 1, IR, P[2]); }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i]; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 42 * dt; s.life -= dt * 1.8;
      if (s.life <= 0) { this.sparks.splice(i, 1); continue; }
      const xx = Math.round(s.x), yy = Math.round(s.y);
      if (xx >= 0 && xx < C && yy >= 0 && yy < R) px(xx, yy, s.life > 0.5 ? P[3] : P[2]);
    }
    const lvl = Math.min(1, Math.max(this.glow, snap.level * 0.8, this.beatGlow * (0.4 + snap.regularity)));
    for (let x = 0; x < C; x++) px(x, IR, BAYER[x & 3] / 16 < 0.4 + 0.6 * lvl ? (lvl > 0.5 ? P[3] : P[2]) : P[1]);
  }

  // --- scene: waves (pixel sea; level/bed = swell, regularity = smoother) ---
  _drawWaves(dt) {
    const b = this.bg, C = this.cols, R = this.rows, snap = this.snap, P = this._pal(snap.hue);
    const px = (x, y, c) => { b.fillStyle = c; b.fillRect(x, y, 1, 1); };
    this.wavePhase += dt * (0.5 + 1.4 * (0.25 + snap.level));
    const baseY = R * 0.42, amp = R * 0.12 * (0.5 + snap.bedGain * 0.8 + snap.level * 0.7), chop = 1 - 0.6 * snap.regularity;
    b.fillStyle = P[0]; b.fillRect(0, 0, C, R);
    const surf = this._surf && this._surf.length === C ? this._surf : (this._surf = new Int16Array(C));
    for (let x = 0; x < C; x++) {
      const w = Math.sin(x * 0.18 + this.wavePhase) + 0.5 * chop * Math.sin(x * 0.07 - this.wavePhase * 1.3) + 0.3 * chop * Math.sin(x * 0.33 + this.wavePhase * 0.7);
      surf[x] = Math.max(1, Math.round(baseY - amp * w));
    }
    for (let x = 0; x < C; x++) {
      const sy = surf[x];
      for (let y = sy; y < R; y++) {
        const depth = (y - sy) / (R - sy + 1), th = BAYER[(y & 3) * 4 + (x & 3)] / 16;
        let c; if (depth < 0.12) c = P[4]; else if (depth < 0.4) c = th < 0.6 ? P[3] : P[2]; else if (depth < 0.7) c = th < 0.5 ? P[2] : P[1]; else c = th < 0.4 ? P[1] : P[0];
        px(x, y, c);
      }
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i]; rp.r += dt * 20; rp.life -= dt * 1.6;
      if (rp.life <= 0) { this.ripples.splice(i, 1); continue; }
      const rr = Math.round(rp.r), xl = rp.x - rr, xr = rp.x + rr;
      if (xl >= 0) px(xl, surf[xl] - 1, P[4]); if (xr < C) px(xr, surf[xr] - 1, P[4]);
    }
    for (let i = this.foam.length - 1; i >= 0; i--) {
      const f = this.foam[i]; f.life -= dt * 1.1;
      if (f.life <= 0) { this.foam.splice(i, 1); continue; }
      px(f.x, surf[f.x] - 1, P[4]); if (f.x + 1 < C) px(f.x + 1, surf[f.x + 1], P[3]);
    }
  }

  // --- scene: wind (horizontal gust streaks swaying on a flow field) ---
  _drawWind(dt) {
    const b = this.bg, C = this.cols, R = this.rows, snap = this.snap, P = this._pal(snap.hue);
    this.windPhase += dt;
    b.fillStyle = P[0]; b.fillRect(0, 0, C, R);
    const lw = 0.3 + 0.7 * snap.level;
    if (Math.random() < 0.05 + 0.14 * lw && this.windParts.length < 16)
      this.windParts.push({ x: -6, y: 2 + Math.random() * (R - 4), vx: 12 + 34 * lw + 12 * snap.morph, rot: Math.random() * 6.28, spin: (Math.random() * 2 - 1) * (2 + 4 * lw), size: 2 + Math.random() * (4 + 5 * lw) });
    for (let i = this.windParts.length - 1; i >= 0; i--) {
      const p = this.windParts[i]; p.x += p.vx * dt; p.rot += p.spin * dt; p.y += Math.sin(this.windPhase + p.x * 0.05) * dt * 2.5;
      if (p.x - p.size > C + 2) { this.windParts.splice(i, 1); continue; }
      this._swirl(p, P[4], P[2]);
    }
  }

  // --- scene: fire (classic propagating heat buffer; onsets/level = flames) ---
  _drawFire(dt) {
    const b = this.bg, C = this.cols, R = this.rows, snap = this.snap, heat = this.heat, ramp = this.fireRamp;
    const base = 0.5 + 0.55 * snap.level + 0.15 * snap.bedGain + 0.35 * this.beatGlow;
    for (let x = 0; x < C; x++) { const i = (R - 1) * C + x; heat[i] = Math.max(heat[i] * 0.55, base * (0.55 + Math.random() * 0.9)); }
    const cool = 0.035 + 0.03 * (1 - snap.level);
    for (let y = 0; y < R - 1; y++) for (let x = 0; x < C; x++) {
      const bm = heat[(y + 1) * C + x], bl = heat[(y + 1) * C + ((x - 1 + C) % C)], br = heat[(y + 1) * C + ((x + 1) % C)], b2 = heat[Math.min(R - 1, y + 2) * C + x];
      const v = (bm * 2 + bl + br + b2) / 5 - cool; heat[y * C + x] = v < 0 ? 0 : v;
    }
    b.fillStyle = '#050505'; b.fillRect(0, 0, C, R);
    for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
      const h = heat[y * C + x];
      if (h > 0.06) { b.fillStyle = ramp[Math.min(31, (h * 32) | 0)]; b.fillRect(x, y, 1, 1); }
    }
  }

  // --- beach: composite of element layers (sky/sea/sand + rain/wind/fire) ---
  beachOnset(kind) {
    if (kind === 'rain') {
      if (this.bRain.length > 200) return;
      this.bRain.push({ x: Math.random() * this.cols, y: -Math.random() * 4, vy: 34 + Math.random() * 12, tail: 2 + (Math.random() * 2 | 0) });
    } else if (kind === 'fire') {
      const fW = this.fW, cx = fW >> 1, w = 1 + (Math.random() * 2 | 0);
      for (let dx = -w; dx <= w; dx++) { const x = cx + dx; if (x < 0 || x >= fW) continue; for (let y = this.fH - 2; y < this.fH; y++) this.fHeat[y * fW + x] = Math.min(1.7, this.fHeat[y * fW + x] + 0.8 + Math.random() * 0.5); }
    }
  }
  // a bigger flare-up on a wood crack: strong heat pulse + a burst of embers
  fireFlare() {
    const fW = this.fW, cx = fW >> 1, half = fW >> 1;
    for (let dx = -half; dx <= half; dx++) { const x = cx + dx; if (x < 0 || x >= fW) continue; for (let y = this.fH - 3; y < this.fH; y++) this.fHeat[y * fW + x] = Math.min(1.9, this.fHeat[y * fW + x] + 1.1); }
    const cxAbs = this.fireX0 + cx, oy = this.sandRow - this.fH + 3;
    for (let i = 0; i < 6; i++) this.embers.push({ x: cxAbs + (Math.random() - 0.5) * fW, y: oy, vx: (Math.random() * 2 - 1) * 5, vy: -(8 + Math.random() * 14), life: 1 });
    this.glow = 1.4;
  }
  // a lightning strike: a screen flash + a jagged bolt from the top of the sky
  lightning(strength) {
    this.flash = Math.max(this.flash, strength);
    const C = this.cols, R = this.rows, start = (this.seaRow || (R * 0.42)) | 0;
    let x = (0.25 + Math.random() * 0.5) * C, y = start; const pts = [];
    while (y > 0) { pts.push([Math.round(x), y]); y -= 1 + (Math.random() * 2 | 0); x += (Math.random() * 2 - 1) * 2.4; } // bottom -> top
    let branch = null;
    if (pts.length > 8) {
      const bi = (pts.length * 0.45) | 0, dir = Math.random() < 0.5 ? -1 : 1, n = 4 + (Math.random() * 5 | 0);
      let bx = pts[bi][0], by = pts[bi][1]; branch = [];
      for (let k = 0; k < n; k++) { branch.push([Math.round(bx), Math.round(by)]); by -= 1 + (Math.random() * 2 | 0); bx += dir * (1 + Math.random() * 2); }
    }
    this.bolt = { pts, branch, life: 1 };
  }
  _drawBeach(dt) {
    const b = this.bg, C = this.cols, R = this.rows, snap = this.snap;
    const bz = snap.beach || { waves: {}, wind: {}, rain: {}, fire: {} };
    const seaY = this.seaRow, sandY = this.sandRow, lvl = snap.level || 0;
    this.wavePhase += dt * (0.5 + 1.0 * (0.3 + lvl)); this.windPhase += dt;
    const px = (x, y, c) => { b.fillStyle = c; b.fillRect(x, y, 1, 1); };

    // sky (dithered dusk gradient) + moon
    for (let y = 0; y < seaY; y++) { const t = y / seaY; for (let x = 0; x < C; x++) px(x, y, BAYER[(y & 3) * 4 + (x & 3)] / 16 < t ? '#16203a' : '#0b1020'); }
    const mx = (C * 0.8) | 0, my = (seaY * 0.4) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dy * dy <= 4) px(mx + dx, my + dy, '#e8eccf');

    // sea: looking down the beach — deep water at the horizon (top) fading to the
    // shore (bottom); foam fronts roll DOWN and break on the sand.
    {
      const seaH = Math.max(1, sandY - seaY);
      for (let y = seaY; y < sandY; y++) {
        const d = (y - seaY) / seaH;
        for (let x = 0; x < C; x++) {
          const th = BAYER[(y & 3) * 4 + (x & 3)] / 16;
          px(x, y, d < 0.34 ? (th < 0.5 ? '#163a4a' : '#11303d') : d < 0.7 ? (th < 0.5 ? '#1f5a6e' : '#164150') : (th < 0.5 ? '#2f8398' : '#236d80'));
        }
      }
      if (bz.waves && bz.waves.on) {
        this.waveScroll += dt * (2 + 7 * ((bz.waves.level || 0) * 0.6 + lvl * 0.5));
        const N = 4, sp = seaH / N;
        for (let i = 0; i < N; i++) {
          const fy = seaY + ((this.waveScroll + i * sp) % seaH), d = (fy - seaY) / seaH;
          for (let x = 0; x < C; x++) {
            const yy = Math.round(fy + 1.4 * Math.sin(x * 0.12 + this.wavePhase + i));
            if (yy < seaY || yy >= sandY) continue;
            px(x, yy, d > 0.72 ? '#e6f6f8' : d > 0.42 ? '#a8dbe2' : '#5fa9b8');
            if (d > 0.6 && yy + 1 < sandY) px(x, yy + 1, '#cdeef2');
          }
        }
        // wash onto the wet sand as a foam front reaches the shore
        const near = (this.waveScroll % sp) / sp;
        if (near > 0.7) { const ww = (near - 0.7) / 0.3; for (let x = 0; x < C; x++) { const w = 1 + Math.round(2 * ww * (0.6 + 0.4 * Math.sin(x * 0.22 + this.wavePhase))); for (let y = sandY; y < Math.min(R, sandY + w); y++) if (BAYER[(y & 3) * 4 + (x & 3)] / 16 < 0.4 + 0.4 * ww) px(x, y, '#9fd0da'); } }
      }
    }

    // sand
    for (let y = sandY; y < R; y++) for (let x = 0; x < C; x++) { const th = BAYER[(y & 3) * 4 + (x & 3)] / 16; px(x, y, th < 0.4 ? '#5a4d34' : th < 0.78 ? '#4a4029' : '#766338'); }

    // wind: big-ish swirls drifting left -> right across the sky
    if (bz.wind && bz.wind.on) {
      const lw = bz.wind.level || 0;
      if (Math.random() < 0.04 + 0.12 * lw && this.windParts.length < 14)
        this.windParts.push({ x: -6, y: 2 + Math.random() * (seaY * 0.92), vx: 10 + 26 * lw, rot: Math.random() * 6.28, spin: (Math.random() * 2 - 1) * (2 + 3 * lw), size: 2 + Math.random() * (3 + 4 * lw) });
      for (let i = this.windParts.length - 1; i >= 0; i--) {
        const p = this.windParts[i]; p.x += p.vx * dt; p.rot += p.spin * dt; p.y += Math.sin(this.windPhase + p.x * 0.05) * dt * 2;
        if (p.x - p.size > C + 2) { this.windParts.splice(i, 1); continue; }
        this._swirl(p, '#dfe6f0', '#8a97ad');
      }
    } else this.windParts.length = 0;

    // campfire on the sand: log pile + contained tapering flames + glow + embers
    if (bz.fire && bz.fire.on) {
      const fW = this.fW, fH = this.fH, heat = this.fHeat, lv = bz.fire.level || 0;
      const base = 0.45 + 0.6 * lv + 0.25 * lvl, cool = 0.07 + 0.06 * (1 - lv);
      const ox = this.fireX0, cx = ox + (fW >> 1), oy = sandY - fH + 2, half = fW >> 1;
      // seed at the logs, brightest at centre
      for (let x = 0; x < fW; x++) { const i = (fH - 1) * fW + x, edge = Math.max(0, 1 - Math.abs(x - half) / (half + 0.5)); heat[i] = Math.max(heat[i] * 0.5, base * edge * (0.5 + Math.random() * 0.8)); }
      for (let y = 0; y < fH - 1; y++) for (let x = 0; x < fW; x++) { const bm = heat[(y + 1) * fW + x], bl = heat[(y + 1) * fW + ((x - 1 + fW) % fW)], br = heat[(y + 1) * fW + ((x + 1) % fW)], b2 = heat[Math.min(fH - 1, y + 2) * fW + x]; const v = (bm * 2 + bl + br + b2) / 5 - cool; heat[y * fW + x] = v < 0 ? 0 : v; }
      // warm glow on the surrounding sand
      const glow = Math.min(1, 0.4 + heat[(fH - 2) * fW + half] + lvl * 0.4);
      for (let dx = -fW; dx <= fW; dx++) { const x = cx + dx; if (x < 0 || x >= C) continue; const fall = 1 - Math.abs(dx) / (fW + 1); if (fall > 0.12) for (let yy = sandY; yy < Math.min(R, sandY + 3); yy++) if (BAYER[(yy & 3) * 4 + (x & 3)] / 16 < fall * glow * 0.7) px(x, yy, '#6e3b1e'); }
      // flames (skip the bottom two rows where the logs sit)
      for (let y = 0; y < fH - 2; y++) for (let x = 0; x < fW; x++) { const h = heat[y * fW + x]; if (h > 0.1) px(ox + x, oy + y, this.fireRamp[Math.min(31, (h * 32) | 0)]); }
      // crossed log pile in front
      for (let i = -(half - 1); i <= half - 1; i++) {
        const lx = cx + i; if (lx < 0 || lx >= C) continue;
        px(lx, sandY, '#4a3520'); if (sandY + 1 < R) px(lx, sandY + 1, '#3a2a18');
        const y1 = sandY - 1 + Math.round(i * 0.4), y2 = sandY - 1 - Math.round(i * 0.4);
        if (y1 >= seaY && y1 < R) px(lx, y1, '#5a4026');
        if (y2 >= seaY && y2 < R) px(lx, y2, '#33240f');
      }
      // spawn rising embers
      if (this.embers.length < 30 && Math.random() < 0.25 + 0.5 * lv) this.embers.push({ x: cx + (Math.random() - 0.5) * fW * 0.6, y: oy + 2, vx: (Math.random() * 2 - 1) * 3, vy: -(6 + Math.random() * 10), life: 1 });
    } else this.embers.length = 0;
    // embers drift up and fade
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i]; e.x += e.vx * dt; e.y += e.vy * dt; e.vy += 4 * dt; e.life -= dt * 0.7;
      if (e.life <= 0) { this.embers.splice(i, 1); continue; }
      const x = e.x | 0, y = e.y | 0; if (x >= 0 && x < C && y >= 0 && y < R) px(x, y, e.life > 0.5 ? '#ffd27a' : '#d8632a');
    }

    // rain in front, bends with wind
    if (bz.rain && bz.rain.on) {
      const wdx = (bz.wind && bz.wind.on) ? (8 + 26 * (bz.wind.level || 0)) : 0;
      for (let i = this.bRain.length - 1; i >= 0; i--) {
        const p = this.bRain[i]; p.y += p.vy * dt; p.x += wdx * dt;
        const x = (((p.x | 0) % C) + C) % C, gy = Math.round(p.y);
        if (gy >= sandY) { px(x, sandY, '#9fb0c6'); if (x + 1 < C) px(x + 1, sandY, '#7d93b3'); this.bRain.splice(i, 1); continue; }
        for (let t = 0; t < p.tail; t++) { const yy = gy - t; if (yy >= 0 && yy < R) px(x, yy, t === 0 ? '#cfe0f2' : '#7d93b3'); }
      }
    } else this.bRain.length = 0;

    // storm: a subtle sky-only flash, then a bright YELLOW bolt (halo + flicker)
    if (this.flash > 0.02) {
      this.flash *= Math.pow(0.0012, dt);
      const f = this.flash, sky = this.seaRow || ((R * 0.42) | 0);
      for (let y = 0; y < sky; y++) for (let x = 0; x < C; x++) if (BAYER[(y & 3) * 4 + (x & 3)] / 16 < f * 0.5) px(x, y, '#9a946a');
    }
    if (this.bolt && this.bolt.life > 0) {
      this.bolt.life -= dt * 2.6;
      const L = this.bolt.life;
      if (L > 0.6 || (L > 0.18 && L < 0.42)) { // flicker in two pulses
        const seg = (pts, core, halo) => { for (const pt of pts) { const bx = pt[0], by = pt[1]; for (let oy = -1; oy <= 1; oy++) { const yy = by + oy; if (yy < 0 || yy >= R) continue; if (bx - 1 >= 0) px(bx - 1, yy, halo); if (bx + 1 < C) px(bx + 1, yy, halo); } if (by >= 0 && by < R) { px(bx, by, core); if (by + 1 < R) px(bx, by + 1, core); } } };
        seg(this.bolt.pts, '#fff7b0', '#ffd23a');
        if (this.bolt.branch) seg(this.bolt.branch, '#ffe14d', '#caa028');
      }
      if (this.bolt.life <= 0) this.bolt = null;
    }
  }
}

// ---------- GROW: a Synplant-style genetic explorer (each branch = a mutated genome) ----------
class Garden {
  constructor(cv, onAudition, onGesture) {
    this.cv = cv; this.g = cv.getContext('2d');
    this.onAudition = onAudition; this.onGesture = onGesture;
    this.amount = 0.34; this.history = []; this.hovered = null; this.growT = 0;
    this.center = randomGenome();
    this.fit(); this.regen();
    cv.addEventListener('pointermove', (e) => this._move(e));
    cv.addEventListener('pointerleave', () => { if (this.hovered) { this.hovered = null; this.onAudition(this.center); } });
    cv.addEventListener('pointerdown', (e) => this._down(e));
  }
  fit() {
    this.dpr = window.devicePixelRatio || 1;
    const r = this.cv.getBoundingClientRect();
    this.W = Math.round(r.width * this.dpr); this.H = Math.round(r.height * this.dpr);
    this.cv.width = this.W; this.cv.height = this.H;
    this.cx = this.W / 2; this.cy = this.H * 0.5; this.R = Math.min(this.W, this.H) * 0.36;
  }
  regen() {
    const N = 12;
    this.children = Array.from({ length: N }, (_, i) => ({
      genome: mutateGenome(this.center, this.amount),
      angle: (i / N) * Math.PI * 2 - Math.PI / 2 + (Math.random() - 0.5) * 0.12,
      seed: Math.random() * 1000, beat: Math.random(), x: 0, y: 0,
    }));
    this.growT = 0;
  }
  reseed() { this.center = randomGenome(); this.amount = 0.34; this.history = []; this.regen(); this.onAudition(this.center); }
  back() { if (this.history.length) { this.center = this.history.pop(); this.amount = Math.min(0.34, this.amount / 0.78); this.regen(); this.onAudition(this.center); } }
  dig(child) { this.history.push(this.center); this.center = child.genome; this.amount = Math.max(0.06, this.amount * 0.78); this.regen(); this.onAudition(this.center); }
  audition() { this.onAudition(this.center); }
  _pt(e) { const r = this.cv.getBoundingClientRect(); return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr]; }
  _pick(e) { const [px, py] = this._pt(e); let best = null, bd = 18 * this.dpr; for (const c of this.children) { const d = Math.hypot(c.x - px, c.y - py); if (d < bd) { bd = d; best = c; } } return best; }
  _move(e) { const c = this._pick(e); if (c !== this.hovered) { this.hovered = c; this.onAudition(c ? c.genome : this.center); } }
  _down(e) { if (this.onGesture) this.onGesture(); const c = this._pick(e); if (c) this.dig(c); }
  _rnd(c, k) { const x = Math.sin(c.seed * 12.9 + k * 78.2) * 43758.5; return x - Math.floor(x); }
  frame(dt) {
    const g = this.g, dpr = this.dpr, cx = this.cx, cy = this.cy, R = this.R;
    this.growT = Math.min(1, this.growT + dt * 2.6);
    g.clearRect(0, 0, this.W, this.H);
    for (const c of this.children) {
      const bx = cx + Math.cos(c.angle) * R * this.growT, by = cy + Math.sin(c.angle) * R * this.growT;
      c.x = bx; c.y = by;
      const hue = hueFor(c.genome.morph), reg = c.genome.regularity, rate = c.genome.mean_rate_hz;
      g.strokeStyle = `hsl(${hue} 55% 26%)`; g.lineWidth = dpr;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(bx, by); g.stroke();
      // rhythm, drawn as dots along the branch: evenly spaced (regular) vs jittered (random)
      const nd = Math.round(4 + rate * 0.45);
      g.fillStyle = `hsl(${hue} 80% 58%)`;
      for (let k = 1; k <= nd; k++) {
        const f = clamp(k / (nd + 1) + (1 - reg) * (this._rnd(c, k) - 0.5) * 0.16, 0.05, 0.97);
        g.beginPath(); g.arc(cx + (bx - cx) * f, cy + (by - cy) * f, 1.4 * dpr, 0, 7); g.fill();
      }
      // bud pulses at its event rate
      c.beat += dt * rate; const pulse = Math.exp(-(c.beat % 1) * 4), hov = c === this.hovered;
      g.save(); g.shadowColor = `hsl(${hue} 90% 60%)`; g.shadowBlur = (hov ? 16 : 7) * dpr;
      g.fillStyle = `hsl(${hue} 85% ${hov ? 72 : 58}%)`;
      g.beginPath(); g.arc(bx, by, (hov ? 9 : 6) * dpr * (1 + 0.45 * pulse), 0, 7); g.fill(); g.restore();
    }
    const ch = hueFor(this.center.morph);
    g.save(); g.shadowColor = `hsl(${ch} 90% 60%)`; g.shadowBlur = 22 * dpr;
    g.fillStyle = `hsl(${ch} 85% 62%)`; g.beginPath(); g.arc(cx, cy, 13 * dpr, 0, 7); g.fill(); g.restore();
    const lab = this.hovered ? this.hovered.genome : this.center;
    g.fillStyle = 'rgba(233,236,241,0.8)'; g.font = `${11 * dpr}px "Martian Mono", monospace`; g.textAlign = 'center';
    g.fillText(`${lab.mean_rate_hz.toFixed(1)}/s · reg ${lab.regularity.toFixed(2)} · ${(lab.brightness_hz / 1000).toFixed(1)}k · ${lab.morph < 0.5 ? 'rain-ish' : 'hat-ish'}`, this.W / 2, this.H - 8 * dpr);
  }
}

// ---------- spectrum + meter + stage loop ----------
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  return dpr;
}
function startDraw() {
  const cv = document.getElementById('spectrum');
  const g = cv.getContext('2d');
  const meterCv = document.getElementById('meter');
  const mg = meterCv.getContext('2d');
  let dpr = fitCanvas(cv); fitCanvas(meterCv);
  window.addEventListener('resize', () => { dpr = fitCanvas(cv); fitCanvas(meterCv); stage.fit(); if (garden) garden.fit(); });

  const FMIN = 80, NBARS = 76;
  const loop = (ts) => {
    rafId = requestAnimationFrame(loop);
    const gdt = loop._t ? Math.min(0.05, ((ts || 0) - loop._t) / 1000) : 0.016; loop._t = ts || 0;
    if (garden && state.mode === 'grow') garden.frame(gdt);
    const hue = state.accentHue;
    let level = 0;
    if (analyser) {
      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);
      for (let i = 0; i < timeData.length; i++) { const a = Math.abs(timeData[i] - 128) / 128; if (a > level) level = a; }
    }
    const rp = currentResolved();
    stage.frame({ morph: state.morph, hue, bedGain: rp.bed_gain, regularity: rp.regularity, metallic: rp.metallic, level, bpm: state.sync ? state.bpm : 0, beach: state.mode === 'beach' ? beach : null }, ts || 0);

    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    if (!analyser) return;
    const fmax = ctx.sampleRate / 2, bw = W / NBARS;
    for (let i = 0; i < NBARS; i++) {
      const f0 = FMIN * Math.pow(fmax / FMIN, i / NBARS);
      const f1 = FMIN * Math.pow(fmax / FMIN, (i + 1) / NBARS);
      const b0 = Math.floor((f0 / fmax) * freqData.length);
      const b1 = Math.max(b0 + 1, Math.floor((f1 / fmax) * freqData.length));
      let v = 0; for (let b = b0; b < b1 && b < freqData.length; b++) v = Math.max(v, freqData[b]);
      const bh = Math.pow(v / 255, 1.35) * (H - 4);
      const grad = g.createLinearGradient(0, H, 0, H - bh);
      grad.addColorStop(0, `hsl(${hue} 70% 22%)`);
      grad.addColorStop(1, `hsl(${hue + i * 0.25} 90% 62%)`);
      g.fillStyle = grad;
      g.fillRect(i * bw + dpr, H - bh, Math.max(1, bw - 2 * dpr), bh);
    }
    const MW = meterCv.width, MH = meterCv.height;
    mg.clearRect(0, 0, MW, MH);
    mg.fillStyle = 'rgba(255,255,255,0.06)'; mg.fillRect(0, 0, MW, MH);
    mg.fillStyle = level > 0.96 ? '#ff5b5b' : `hsl(${hue} 88% 60%)`;
    mg.fillRect(0, 0, MW * Math.min(1, level), MH);
  };
  loop();
}

// ---------- transport ----------
function setTransport() {
  document.querySelectorAll('.btn.play').forEach((btn) => {
    btn.classList.toggle('on', playing);
    btn.querySelector('.lbl').textContent = playing ? 'STOP' : 'PLAY';
  });
}

// ---------- macro snapshots (used by transitions) ----------
function macroDefault(key) { if (key === 'morph') return 0; const k = knobMap[key]; return k ? k.def : 0; }
function applyMacros(m) {
  if ('morph' in m) { state.morph = clamp(m.morph, 0, 1); morphKnob.setValue(state.morph, true); }
  for (const k of knobs) {
    if (k.id in m) { k.setValue(m[k.id], true); if (k.follows) k.setLinked(false); }
    else if (k.follows) k.setLinked(true);
  }
  updateFollowers();
  reassertSync();
  pushParams();
  clearPresetHighlight();
}
function interpMacros(a, b, t) {
  const cur = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'name' || key === 'dur' || key === 'mode') continue;
    const va = a[key] ?? macroDefault(key), vb = b[key] ?? macroDefault(key);
    cur[key] = (key === 'brightness_hz' || key === 'mean_rate_hz') ? loglerp(va, vb, t) : lerp(va, vb, t);
  }
  return cur;
}

// ---------- automation / transitions ----------
function stopAuto() { cancelAnimationFrame(autoRAF); autoRAF = null; autoActive = null; updateAutoUI(); }
function updateAutoUI() {
  const manual = autoRAF && autoActive === '__manual';
  const run = document.getElementById('run');
  run.classList.toggle('on', !!manual);
  run.querySelector('.lbl').textContent = manual ? 'STOP' : 'RUN';
  const ab = document.getElementById('runAB');
  if (ab) ab.classList.toggle('on', !!autoRAF && autoActive === '__custom');
  document.querySelectorAll('.trans').forEach((c) => c.classList.toggle('on', !!autoRAF && c.dataset.trans === autoActive));
}

// ---------- transition editor (capture current state as A / B) ----------
function snapshot() {
  const s = { morph: state.morph };
  for (const k of knobs) s[k.id] = k.value;
  return s;
}
function setSlot(which) {
  const snap = snapshot();
  if (which === 'A') editA = snap; else editB = snap;
  const ind = document.getElementById('ind' + which);
  ind.textContent = which + ' ' + snap.morph.toFixed(2);
  ind.classList.add('set');
  const ready = !!(editA && editB);
  document.getElementById('runAB').disabled = !ready;
  document.getElementById('saveAB').disabled = !ready;
}
function runAB() {
  if (!editA || !editB) return;
  if (autoRAF && autoActive === '__custom') { stopAuto(); return; }
  const dur = parseFloat(document.getElementById('dur').value) || 8;
  const mode = document.getElementById('automode').value === 'loop' ? 'loop' : 'once';
  runTransition(editA, editB, dur, mode, 'inOut', '__custom');
}
function saveAB() {
  if (!editA || !editB) return;
  const name = (prompt('nom de la transition ?', 'custom') || '').trim();
  if (!name) return;
  const mode = document.getElementById('automode').value === 'loop' ? 'loop' : 'once';
  const t = { name, dur: parseFloat(document.getElementById('dur').value) || 8, mode, from: editA, to: editB, user: true };
  userTrans.push(t);
  try { localStorage.setItem('rh_transitions', JSON.stringify(userTrans)); } catch (e) {}
  addTransChip(t);
}
function deleteTrans(t, chip) {
  userTrans = userTrans.filter((x) => x !== t);
  try { localStorage.setItem('rh_transitions', JSON.stringify(userTrans)); } catch (e) {}
  if (autoActive === t.name) stopAuto();
  chip.remove();
}
function addTransChip(t) {
  const chip = document.createElement('button');
  chip.className = 'preset trans' + (t.user ? ' user' : '');
  chip.dataset.trans = t.name;
  chip.append('▸ ' + t.name);
  if (t.user) {
    const x = document.createElement('span');
    x.className = 'del'; x.textContent = '×'; x.title = 'supprimer';
    chip.appendChild(x);
  }
  chip.addEventListener('click', (e) => {
    if (e.target.classList.contains('del')) { deleteTrans(t, chip); return; }
    if (autoRAF && autoActive === t.name) { stopAuto(); return; }
    document.getElementById('dur').value = t.dur;
    document.getElementById('automode').value = t.mode === 'loop' ? 'loop' : 'up';
    runTransition(t.from, t.to, t.dur, t.mode, 'inOut', t.name);
  });
  document.getElementById('transitions').appendChild(chip);
}
async function runTransition(from, to, durSec, mode, ease, tag) {
  await ensurePlaying();
  cancelAnimationFrame(autoRAF);
  autoActive = tag;
  const dur = clamp(durSec, 0.3, 300) * 1000;
  const easeFn = ease === 'linear' ? (x) => x : (x) => x * x * (3 - 2 * x);
  let a = from, b = to, start = null;
  applyMacros(interpMacros(a, b, 0));
  const step = (ts) => {
    if (start === null) start = ts;
    let x = (ts - start) / dur;
    if (x >= 1) {
      if (mode === 'loop') { start = ts; const t = a; a = b; b = t; x = 0; }
      else { applyMacros(interpMacros(a, b, 1)); stopAuto(); return; }
    }
    applyMacros(interpMacros(a, b, easeFn(x)));
    autoRAF = requestAnimationFrame(step);
  };
  autoRAF = requestAnimationFrame(step);
  updateAutoUI();
}
function runManual() {
  if (autoRAF) { stopAuto(); return; }
  const mode = document.getElementById('automode').value;
  const dur = parseFloat(document.getElementById('dur').value) || 8;
  let from, to;
  if (mode === 'down') { from = { morph: 1 }; to = { morph: 0 }; }
  else if (mode === 'loop') { from = { morph: state.morph }; to = { morph: state.morph < 0.5 ? 1 : 0 }; }
  else { from = { morph: 0 }; to = { morph: 1 }; }
  runTransition(from, to, dur, mode === 'loop' ? 'loop' : 'once', 'linear', '__manual');
}

// ---------- presets ----------
function clearPresetHighlight() { document.querySelectorAll('#presets .preset').forEach((p) => p.classList.remove('on')); }
function applyPreset(p, chip) {
  stopAuto();
  state.morph = p.o.morph ?? 0;
  morphKnob.setValue(state.morph, true);
  for (const k of knobs) { k.setValue(k.def, true); if (k.follows) k.setLinked(true); }
  for (const [id, val] of Object.entries(p.o)) {
    if (id === 'morph') continue;
    const k = knobMap[id];
    if (k) { k.setValue(val, true); if (k.follows) k.setLinked(false); }
  }
  updateFollowers();
  reassertSync();
  pushParams();
  clearPresetHighlight();
  chip.classList.add('on');
}

// ---------- user presets (saved genomes from GROW, persisted) ----------
let userPresets = [];
function savePresetsLS() { try { localStorage.setItem('rh_presets', JSON.stringify(userPresets)); } catch (e) {} }
function makePresetChip(p, user) {
  const chip = document.createElement('button');
  chip.className = 'preset' + (user ? ' user' : '');
  chip.append(p.name);
  if (user) { const x = document.createElement('span'); x.className = 'del'; x.textContent = '×'; x.title = 'supprimer'; chip.appendChild(x); }
  chip.addEventListener('click', (e) => {
    if (user && e.target.classList.contains('del')) { userPresets = userPresets.filter((q) => q !== p); savePresetsLS(); chip.remove(); return; }
    applyPreset(p, chip);
  });
  document.getElementById('presets').appendChild(chip);
}
function savePreset(genome) {
  const name = (prompt('nom du preset ?', 'seed') || '').trim();
  if (!name) return;
  const o = {}; for (const g of GENES) o[g.id] = genome[g.id];
  const p = { name, o, user: true };
  userPresets.push(p); savePresetsLS(); makePresetChip(p, true);
}

// ---------- tempo ----------
let tapTimes = [];
function applyTempo() {
  if (state.sync) knobMap.mean_rate_hz.setValue(clamp((state.bpm / 60) * state.subdiv, 1, 30), true);
  pushParams();
}
function setSync(on) {
  state.sync = on;
  document.getElementById('sync').classList.toggle('on', on);
  const rk = knobMap.mean_rate_hz;
  rk.el.classList.toggle('locked', on);
  if (on) rk.setLinked(false); else { rk.setLinked(true); updateFollowers(); }
  applyTempo();
}
function tapTempo() {
  const now = performance.now();
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes = [];
  tapTimes.push(now);
  if (tapTimes.length >= 2) {
    let sum = 0; for (let i = 1; i < tapTimes.length; i++) sum += tapTimes[i] - tapTimes[i - 1];
    state.bpm = clamp(Math.round(60000 / (sum / (tapTimes.length - 1))), 40, 220);
    document.getElementById('bpm').value = state.bpm;
    if (!state.sync) setSync(true); else applyTempo();
  }
  if (tapTimes.length > 6) tapTimes.shift();
}

// ---------- info overlay ----------
function buildInfo() {
  const list = document.getElementById('info-list');
  const row = (label, info) => `<div class="info-row"><span class="info-k">${label}</span><span class="info-d">${info}</span></div>`;
  let html = row('MORPH', MORPH_INFO);
  for (const c of CONTROLS) html += row(c.label, c.info);
  for (const e of EXTRA_INFO) html += row(e.label, e.info);
  list.innerHTML = html;
  const overlay = document.getElementById('info');
  document.getElementById('info-btn').addEventListener('click', () => overlay.hidden = false);
  document.getElementById('info-close').addEventListener('click', () => overlay.hidden = true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });
}

// ---------- build ----------
function build() {
  setAccent(0);
  stage = new Stage(document.getElementById('stage'));
  garden = new Garden(document.getElementById('garden'), pushGenome, () => ensurePlaying());

  morphKnob = new Knob({
    id: 'morph', label: 'MORPH', min: 0, max: 1, def: 0, big: true, fmt: (v) => v.toFixed(2),
    onChange: (v) => { stopAuto(); setMorph(v); },
  });
  document.getElementById('morph-slot').appendChild(morphKnob.el);

  const grid = document.getElementById('knobs');
  for (const c of CONTROLS) {
    const k = new Knob({ ...c, onChange: onSecondary });
    k.follows = c.follows || null;
    knobs.push(k); knobMap[c.id] = k;
    if (k.follows) k.setLinked(true);
    grid.appendChild(k.el);
  }
  updateFollowers();

  // built-in + saved-genome presets
  for (const p of PRESETS) makePresetChip(p, false);
  try { userPresets = JSON.parse(localStorage.getItem('rh_presets') || '[]'); } catch (e) { userPresets = []; }
  for (const p of userPresets) makePresetChip(p, true);

  // transition presets (built-in + saved user transitions)
  try { userTrans = JSON.parse(localStorage.getItem('rh_transitions') || '[]'); } catch (e) { userTrans = []; }
  for (const t of TRANSITIONS) addTransChip(t);
  for (const t of userTrans) addTransChip(t);

  document.querySelectorAll('.btn.play').forEach((btn) => btn.addEventListener('click', () => (playing ? stop() : ensurePlaying())));
  document.getElementById('run').addEventListener('click', runManual);
  document.getElementById('setA').addEventListener('click', () => setSlot('A'));
  document.getElementById('setB').addEventListener('click', () => setSlot('B'));
  document.getElementById('runAB').addEventListener('click', runAB);
  document.getElementById('saveAB').addEventListener('click', saveAB);
  document.getElementById('sync').addEventListener('click', () => setSync(!state.sync));
  const bpmInput = document.getElementById('bpm');
  bpmInput.addEventListener('change', () => { state.bpm = clamp(parseFloat(bpmInput.value) || 120, 40, 220); bpmInput.value = state.bpm; applyTempo(); });
  const divSel = document.getElementById('div');
  divSel.addEventListener('change', () => { state.subdiv = parseInt(divSel.value, 10) || 4; applyTempo(); });
  document.getElementById('tap').addEventListener('click', tapTempo);
  document.getElementById('scene').addEventListener('change', (e) => { state.synthScene = e.target.value; if (state.mode === 'synth') stage.setScene(e.target.value); });

  // mode switch + beach element strips
  document.querySelectorAll('.mode-btn').forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
  document.getElementById('grow-seed').addEventListener('click', () => garden.reseed());
  document.getElementById('grow-back').addEventListener('click', () => garden.back());
  document.getElementById('grow-save').addEventListener('click', () => savePreset(garden.center));
  for (const el of ['waves', 'wind', 'rain', 'fire', 'storm']) {
    const tog = document.getElementById('be-' + el), sl = document.getElementById('bl-' + el);
    tog.classList.toggle('on', beach[el].on);
    sl.value = beach[el].level;
    tog.addEventListener('click', () => { beach[el].on = !beach[el].on; tog.classList.toggle('on', beach[el].on); updateBeach(); });
    sl.addEventListener('input', () => { beach[el].level = parseFloat(sl.value); updateBeach(); });
  }
  const master = document.getElementById('master');
  master.addEventListener('input', () => { state.master = parseFloat(master.value); pushParams(); });
  const seed = document.getElementById('seed');
  seed.addEventListener('change', () => {
    state.seed = (parseInt(seed.value, 10) || 0) >>> 0;
    if (node) node.port.postMessage({ type: 'seed', seed: state.seed });
  });

  buildInfo();
  startDraw();
}
function onSecondary(v, knob, why) {
  if (knob.follows) {
    if (why === 'link') {
      if (knob.linked) { const b = resolve({ morph: state.morph }); knob.setValue(b[knob.follows], true); }
    } else if (knob.linked) {
      knob.setLinked(false);
    }
  }
  clearPresetHighlight();
  pushParams();
}

build();
