// Real-time AudioWorklet: schedules gamma-renewal onsets, synthesizes a grain
// per onset into an overlap-add ring buffer, mixes the rain bed, soft-limits.
import { RNG, BedGenerator, synthGrain, resolve, shapeFromRegularity } from './dsp-core.js';

const OUT_TRIM = 0.16;          // base output level before the soft limiter
const BUF = 1 << 16;            // ring buffer (> longest grain + a block)
const MASK = BUF - 1;

class RainHihatProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.fs = sampleRate;
    const opt = options.processorOptions || {};
    this.params = opt.params || resolve({ morph: 0 });
    this.morph = opt.morph ?? 0;
    this.master = opt.master ?? 0.8;
    this.seed = (opt.seed ?? 1) >>> 0;
    this.makeup = 1;

    this.bufL = new Float32Array(BUF);
    this.bufR = new Float32Array(BUF);
    this.playing = false;
    this._reset();

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _reset() {
    this.rng = new RNG(this.seed);
    this.bed = new BedGenerator(this.seed, this.fs);
    this.clock = 0;
    this.nextOnset = 0;
    this.onsetCount = 0;
    this.bufL.fill(0);
    this.bufR.fill(0);
  }

  _onMessage(d) {
    switch (d.type) {
      case 'params':
        this.params = d.params;
        this.morph = d.morph;
        this.master = d.master;
        // contour-compensating makeup: attenuate the dense rain wash, lift the
        // sparse hi-hat, so the morph keeps an even loudness (~4-5 dB spread).
        this.makeup = Math.pow(10, (-4 + 10 * this.morph) / 20);
        break;
      case 'play':
        if (d.seed != null) this.seed = d.seed >>> 0;
        this._reset();
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

  _scheduleNext() {
    const k = shapeFromRegularity(this.params.regularity);
    const rate = Math.max(this.params.rate_hz, 1e-3);
    let ioi = k >= 1e5 ? 1 / rate : this.rng.gamma(k) / (rate * k);
    this.onsetCount++;
    if (this.params.swing > 0 && this.onsetCount % 2 === 1) {
      ioi += this.params.swing * 0.5 * (1 / rate);
    }
    this.nextOnset += Math.max(1, Math.round(ioi * this.fs));
  }

  _triggerGrain() {
    const g = synthGrain(this.params, this.fs, this.rng);
    const pan = (this.rng.uniform() * 2 - 1) * this.params.stereo_spread;
    const th = (Math.PI / 4) * (pan + 1); // equal-power
    const gL = Math.cos(th), gR = Math.sin(th);
    const start = this.clock;
    for (let i = 0; i < g.length; i++) {
      const idx = (start + i) & MASK;
      this.bufL[idx] += g[i] * gL;
      this.bufR[idx] += g[i] * gR;
    }
    // notify the main thread so the visualizer can spawn a synced event
    this.port.postMessage({ type: 'onset', pan });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    if (!this.playing) { L.fill(0); if (R !== L) R.fill(0); return true; }

    const gain = OUT_TRIM * this.makeup * this.master;
    const bedGain = this.params.bed_gain;
    for (let j = 0; j < L.length; j++) {
      while (this.clock >= this.nextOnset) {
        this._triggerGrain();
        this._scheduleNext();
      }
      const idx = this.clock & MASK;
      let sl = this.bufL[idx], sr = this.bufR[idx];
      this.bufL[idx] = 0; this.bufR[idx] = 0;

      if (bedGain > 0) { const b = this.bed.sample(this.morph) * bedGain; sl += b; sr += b; }

      sl *= gain; sr *= gain;
      L[j] = 0.95 * Math.tanh(sl / 0.95);
      R[j] = 0.95 * Math.tanh(sr / 0.95);
      this.clock++;
    }
    return true;
  }
}

registerProcessor('rainhihat-processor', RainHihatProcessor);
