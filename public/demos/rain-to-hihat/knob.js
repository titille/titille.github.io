// Knob pixel art : dessiné sur canvas en grosses cellules (pas d'arc lissé,
// pas d'anti-aliasing) — anneau de pixels cranté, pointeur en escalier.
// Interactions : glisser vertical, maj = fin, double-clic = reset, molette.
const A0 = -135, A1 = 135;           // plage de rotation en degrés
const N = 15;                        // grille de cellules (impair, centre 7)

const registry = [];                 // pour redessiner tous les knobs quand
                                     // l'accent morphe (cyan → ambre)

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class Knob {
  constructor({ id, label, min, max, def, log = false, big = false, fmt = (v) => v.toFixed(2), onChange }) {
    Object.assign(this, { id, label, min, max, def, log, fmt, onChange, big });
    this.value = def;
    this.linked = false;             // géré par app.js pour les knobs "suit le morph"
    this._build();
    this.setValue(def, true);
    registry.push(this);
  }

  static refreshAll() { for (const k of registry) k._draw(); }

  _norm(v) {
    if (this.log) return Math.log(v / this.min) / Math.log(this.max / this.min);
    return (v - this.min) / (this.max - this.min);
  }
  _denorm(t) {
    t = Math.min(1, Math.max(0, t));
    if (this.log) return this.min * Math.pow(this.max / this.min, t);
    return this.min + t * (this.max - this.min);
  }

  _build() {
    const cell = this.big ? 8 : 4;
    const size = N * cell;           // px CSS

    const el = document.createElement('div');
    el.className = 'knob' + (this.big ? ' knob--lg' : '');
    el.innerHTML = `<div class="knob-dial" style="width:${size}px;height:${size}px">
      <canvas width="${size}" height="${size}" style="width:${size}px;height:${size}px"></canvas>
      <div class="knob-readout">${this.big ? '' : '<span class="k-link" title="suit le morph"></span>'}<span class="k-value"></span></div>
    </div>
    <div class="knob-label">${this.label}</div>`;

    this.el = el;
    this.cv = el.querySelector('canvas');
    this.cell = cell;
    // backing store en pixels machine pour des cellules nettes
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.round(size * dpr);
    this.cv.height = Math.round(size * dpr);
    this.px = (size * dpr) / N;      // taille d'une cellule en px machine
    this.kctx = this.cv.getContext('2d');
    this.valText = el.querySelector('.k-value');
    this.linkDot = el.querySelector('.k-link');

    if (this.linkDot) {
      this.linkDot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setLinked(!this.linked);
        this.onChange?.(this.value, this, 'link');
      });
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

  // silent=true : met à jour le visuel sans déclencher onChange (suivi du morph)
  setValue(v, _silent) {
    this.value = Math.min(this.max, Math.max(this.min, v));
    this.valText.textContent = this.fmt(this.value);
    this._draw();
  }

  // rendu cellule par cellule : anneau cranté + pointeur en escalier
  _draw() {
    const ctx = this.kctx, px = this.px, c = (N - 1) / 2;
    const t = this._norm(this.value);
    const aVal = A0 + (A1 - A0) * t;
    const accent = cssVar('--accent') || '#54aabf';
    const track = '#222733', cap = '#0e1116', ptr = '#e9ecf1';

    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const dx = i - c, dy = j - c;
        const dist = Math.hypot(dx, dy);
        let fill = null;
        if (dist >= 5.1 && dist <= 7.0) {
          // angle 0 = haut, sens horaire, en degrés
          const ang = (Math.atan2(dx, -dy) * 180) / Math.PI;
          if (ang >= A0 - 4 && ang <= A1 + 4) fill = ang <= aVal ? accent : track;
        } else if (dist <= 3.4) {
          fill = cap;
        }
        if (fill) { ctx.fillStyle = fill; ctx.fillRect(Math.round(i * px), Math.round(j * px), Math.ceil(px), Math.ceil(px)); }
      }
    }
    // pointeur : 3 cellules en escalier du centre vers l'angle courant
    const rad = ((aVal - 90) * Math.PI) / 180;
    ctx.fillStyle = ptr;
    for (const rr of [1.6, 2.6, 3.6]) {
      const i = Math.round(c + Math.cos(rad) * rr);
      const j = Math.round(c + Math.sin(rad) * rr);
      ctx.fillRect(Math.round(i * px), Math.round(j * px), Math.ceil(px), Math.ceil(px));
    }
  }
}
