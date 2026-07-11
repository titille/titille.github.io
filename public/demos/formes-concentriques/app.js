const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const SIZE = 800;

// ─── Seeded PRNG (xorshift32) ─────────────────────────────────────────────────

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b]
    .map(v => Math.round(v * 255).toString(16).padStart(2, '0'))
    .join('');
}

function toRgba([r, g, b], a = 1) {
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
}

// ─── Core algorithm (faithful to the Python source) ───────────────────────────

function generateAdaptiveCenters(n, margin, rng) {
  const centers = [];
  const minDist = Math.max(50, SIZE / (2 * n));
  let tries = 0;
  while (centers.length < n && tries < 10000) {
    tries++;
    const x = margin + rng() * (SIZE - 2 * margin);
    const y = margin + rng() * (SIZE - 2 * margin);
    if (!centers.some(([cx, cy]) => Math.hypot(x - cx, y - cy) < minDist)) {
      centers.push([x, y]);
    }
  }
  return centers;
}

function gradientColor(c0, c1, steps) {
  return Array.from({ length: steps }, (_, i) => [
    c0[0] + (i / steps) * (c1[0] - c0[0]),
    c0[1] + (i / steps) * (c1[1] - c0[1]),
    c0[2] + (i / steps) * (c1[2] - c0[2]),
  ]);
}

// ─── Draw ─────────────────────────────────────────────────────────────────────

let currentSeed = Math.floor(Math.random() * 0xffffffff);

function draw(newSeed = false) {
  if (newSeed) currentSeed = Math.floor(Math.random() * 0xffffffff);
  document.getElementById('seed-val').textContent =
    currentSeed.toString(16).padStart(8, '0');

  const rng = makeRng(currentSeed);

  const shape     = document.querySelector('input[name="shape"]:checked').value;
  const nCenters  = +document.getElementById('num-centers').value;
  const nShapes   = +document.getElementById('num-shapes').value;
  const b         = +document.getElementById('b-param').value;
  const margin    = +document.getElementById('margin').value;
  const startColor = hexToRgb(document.getElementById('start-color').value);
  const endColor   = hexToRgb(document.getElementById('end-color').value);
  const useRotation   = document.getElementById('rotation').checked;
  const useOpacity    = document.getElementById('opacity').checked;
  const useMultiColor = document.getElementById('multi-color').checked;
  const useGradBg     = document.getElementById('gradient-bg').checked;

  // Clip to canvas bounds (shapes can overflow if b or n is large)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, SIZE, SIZE);
  ctx.clip();

  // Background
  if (useGradBg) {
    const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    grad.addColorStop(0, toRgba(startColor));
    grad.addColorStop(1, toRgba(endColor));
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = '#e8e8e8';
  }
  ctx.fillRect(0, 0, SIZE, SIZE);

  const centers = generateAdaptiveCenters(nCenters, margin, rng);

  for (const [cx, cy] of centers) {
    // a ∈ [2.5, 5] — controls overall scale of the rings for this center
    const a = 2.5 + rng() * 2.5;

    // Color gradient for this center
    let sc = startColor;
    let ec = endColor;
    if (useMultiColor) {
      sc = [rng(), rng(), rng()];
      ec = [rng(), rng(), rng()];
    }
    const colors = gradientColor(sc, ec, nShapes);

    // In mix mode, each center randomly gets circles or squares
    const centerShape = shape === 'mix'
      ? (rng() < 0.5 ? 'circle' : 'square')
      : shape;

    // Draw from outermost (n = nShapes) to innermost (n = 1)
    for (let n = nShapes; n >= 1; n--) {
      // Randomly choose quadratic (a·b·n²) or linear (a·b·n) per ring
      const size = rng() < 0.5 ? a * b * n * n : a * b * n;

      // Innermost rings have thicker lines (faithful to Python source)
      const lw = Math.max(1, 3 * (1 - n / nShapes));
      const color = colors[n - 1];
      const alpha = useOpacity ? n / nShapes : 1;

      ctx.strokeStyle = toRgba(color, alpha);
      ctx.lineWidth = lw;

      if (centerShape === 'circle') {
        ctx.beginPath();
        ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.save();
        ctx.translate(cx, cy);
        if (useRotation) ctx.rotate(n * 0.12);
        ctx.beginPath();
        ctx.rect(-size / 2, -size / 2, size, size);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  ctx.restore();
}

// ─── UI bindings ──────────────────────────────────────────────────────────────

function bindSlider(id, displayId, fmt = v => v) {
  const el = document.getElementById(id);
  const display = document.getElementById(displayId);
  el.addEventListener('input', () => { display.textContent = fmt(el.value); });
}

bindSlider('num-centers', 'centers-val');
bindSlider('num-shapes',  'shapes-val');
bindSlider('b-param',     'b-val',      v => (+v).toFixed(2));
bindSlider('margin',      'margin-val');

document.getElementById('generate').addEventListener('click', () => draw(true));

document.getElementById('random-btn').addEventListener('click', () => {
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  const nCenters = Math.ceil(Math.random() * 12);
  const nShapes  = pick([10, 15, 20]);
  const b        = pick([1.0, 1.5, 2.0]);
  const shape    = pick(['circle', 'square', 'mix']);

  const set = (id, dispId, val, fmt = v => v) => {
    document.getElementById(id).value = val;
    document.getElementById(dispId).textContent = fmt(val);
  };

  set('num-centers', 'centers-val', nCenters);
  set('num-shapes',  'shapes-val',  nShapes);
  set('b-param',     'b-val',       b, v => (+v).toFixed(2));
  set('margin',      'margin-val',  100);

  document.getElementById('start-color').value =
    rgbToHex(Math.random(), Math.random(), Math.random());
  document.getElementById('end-color').value =
    rgbToHex(Math.random(), Math.random(), Math.random());

  document.querySelector(`input[name="shape"][value="${shape}"]`).checked = true;

  ['rotation', 'opacity', 'multi-color', 'gradient-bg'].forEach(id => {
    document.getElementById(id).checked = Math.random() < 0.3;
  });

  draw(true);
});

document.getElementById('export').addEventListener('click', () => {
  const a = document.createElement('a');
  a.download = `formes-concentriques-${document.getElementById('seed-val').textContent}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
});

// Initial draw
draw(true);
