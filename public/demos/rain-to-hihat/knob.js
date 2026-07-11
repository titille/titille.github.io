// Custom rotary knob: vertical-drag to turn, shift = fine, double-click resets,
// wheel nudges. Renders an SVG arc that fills with the (morph-driven) accent.
const A0 = -135, A1 = 135; // sweep range in degrees
const NS = 'http://www.w3.org/2000/svg';

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

export class Knob {
  constructor({ id, label, min, max, def, log = false, big = false, fmt = (v) => v.toFixed(2), onChange }) {
    Object.assign(this, { id, label, min, max, def, log, fmt, onChange });
    this.value = def;
    this.linked = false; // managed externally for "follow morph" knobs
    this._build(big);
    this.setValue(def, true);
  }

  _norm(v) {
    if (this.log) return Math.log(v / this.min) / Math.log(this.max / this.min);
    return (v - this.min) / (this.max - this.min);
  }
  _denorm(t) {
    t = Math.min(1, Math.max(0, t));
    if (this.log) return this.min * Math.pow(this.max / this.min, t);
    return this.min + t * (this.max - this.min);
  }

  _build(big) {
    const size = big ? 132 : 66;
    const r = size / 2 - (big ? 9 : 6);
    const cx = size / 2, cy = size / 2;

    const el = document.createElement('div');
    el.className = 'knob' + (big ? ' knob--lg' : '');
    el.innerHTML = `<div class="knob-dial" style="width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <path class="k-track" d="${arcPath(cx, cy, r, A0, A1)}" fill="none" stroke-width="${big ? 5 : 4}" stroke-linecap="round"/>
        <path class="k-val" d="" fill="none" stroke-width="${big ? 5 : 4}" stroke-linecap="round"/>
        <line class="k-ptr" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r + (big ? 12 : 8)}" stroke-width="${big ? 3 : 2}" stroke-linecap="round"/>
        <circle class="k-cap" cx="${cx}" cy="${cy}" r="${big ? 30 : 15}"/>
      </svg>
      <div class="knob-readout">${big ? '' : '<span class="k-link" title="suit le morph"></span>'}<span class="k-value"></span></div>
    </div>
    <div class="knob-label">${this.label}</div>`;

    this.el = el;
    this.svg = el.querySelector('svg');
    this.valArc = el.querySelector('.k-val');
    this.ptr = el.querySelector('.k-ptr');
    this.valText = el.querySelector('.k-value');
    this.linkDot = el.querySelector('.k-link');
    this.r = r; this.cx = cx; this.cy = cy;

    if (this.linkDot) {
      this.linkDot.addEventListener('click', (e) => { e.stopPropagation(); this.setLinked(!this.linked); this.onChange?.(this.value, this, 'link'); });
    }

    const dial = el.querySelector('.knob-dial');
    let dragging = false, lastY = 0;
    const onMove = (e) => {
      if (!dragging) return;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      const dy = lastY - y; lastY = y;
      const fine = e.shiftKey ? 0.25 : 1;
      const t = this._norm(this.value) + (dy / 220) * fine;
      this.setValue(this._denorm(t));
      this.onChange?.(this.value, this, 'drag');
      e.preventDefault();
    };
    const stop = () => {
      dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      dial.classList.remove('grab');
    };
    dial.addEventListener('pointerdown', (e) => {
      dragging = true; lastY = e.clientY; dial.classList.add('grab');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stop);
      e.preventDefault();
    });
    dial.addEventListener('dblclick', () => { this.setValue(this.def); this.onChange?.(this.value, this, 'reset'); });
    dial.addEventListener('wheel', (e) => {
      const t = this._norm(this.value) - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.02);
      this.setValue(this._denorm(t));
      this.onChange?.(this.value, this, 'wheel');
      e.preventDefault();
    }, { passive: false });
  }

  setLinked(on) {
    this.linked = on;
    this.el.classList.toggle('linked', on);
  }

  // silent=true updates visuals without firing onChange (used by morph-follow).
  setValue(v, _silent) {
    this.value = Math.min(this.max, Math.max(this.min, v));
    const t = this._norm(this.value);
    const a = A0 + (A1 - A0) * t;
    this.valArc.setAttribute('d', arcPath(this.cx, this.cy, this.r, A0, a));
    this.ptr.setAttribute('transform', `rotate(${a} ${this.cx} ${this.cy})`);
    this.valText.textContent = this.fmt(this.value);
  }
}
