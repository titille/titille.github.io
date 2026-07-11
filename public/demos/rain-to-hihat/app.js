// Thread principal : graphe audio (AudioWorklet + analyser), modules ON/OFF
// avec leurs knobs contextuels, logique "suit le morph", pont worklet →
// pixel art, presets, sweep.
import { Knob } from './knob.js';
import { PixelRain } from './pixel-rain.js';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// --- modules : chacun a ses knobs, son ON/OFF, sa couche d'animation ---
// `follows` = suit MORPH tant que la pastille est allumée.
const MODULES = [
  {
    id: 'pluie', label: 'PLUIE', defOn: true,
    knobs: [
      { id: 'intensity', label: 'INTENSITÉ', min: 0.5, max: 80, def: 10, log: true,
        fmt: (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + 'mm/h',
        info: 'Débit de pluie en mm/h — LE knob physique. Pilote le nombre ET le mélange de tailles de gouttes (Marshall-Palmer 1948) : 0.5-2 = bruine qui siffle (bulles 14-16 kHz), 10 = pluie d’été, 45+ = averse qui ploppe (grosses bulles 1-10 kHz + splashs). À l’écran : densité des traînées et des impacts.' },
      { id: 'taille', label: 'TAILLE', min: -1, max: 1, def: 0,
        fmt: (v) => (v >= 0 ? '+' : '') + v.toFixed(2),
        info: 'Biais sur la distribution de tailles à débit égal : négatif = gouttes plus fines (sifflement), positif = plus grosses (bloops graves, splashs). 0 = physique Marshall-Palmer pure.' },
      { id: 'regularity', label: 'RÉGULARITÉ', min: 0, max: 0.999, def: 0, follows: true,
        fmt: (v) => v.toFixed(2),
        info: 'L’axe temporel commun à tous les modules : 0 = arrivées de Poisson (le hasard de la nature), 1 = grille métronomique. Le coefficient de variation des intervalles vaut exactement 1 − valeur.' },
      { id: 'rate', label: 'DÉBIT ×', min: 0.25, max: 4, def: 1, log: true,
        fmt: (v) => '×' + v.toFixed(2),
        info: 'Multiplicateur du taux d’événements côté pluie (la physique fixe la base). Côté hi-hat, le tempo vient de BPM + subdivision.' },
      { id: 'surface', label: 'SURFACE', min: 0, max: 1, def: 0,
        fmt: (v) => (v < 0.03 ? 'EAU' : v > 0.97 ? 'TÔLE' : Math.round(v * 100) + '%'),
        info: 'Sur quoi tombe la pluie : eau (tap doux + bulle de Minnaert) ↔ surface dure (tap écrasé + spray, pas de bulle). Entre les deux : mélange probabiliste goutte par goutte.' },
      { id: 'espace', label: 'ESPACE', min: 0, max: 1, def: 0.5,
        fmt: (v) => v.toFixed(2),
        info: 'Profondeur de champ : 0 = gros plan (peu de gouttes, proches et fortes), 1 = paysage ouvert (nappe dominante, feutrée par l’absorption de l’air, panorama stéréo).' },
      { id: 'nappe', label: 'NAPPE', min: 0, max: 1, def: 0.8,
        fmt: (v) => v.toFixed(2),
        info: 'Niveau de la nappe de Campbell : l’agrégat des milliers de gouttes non résolues, dont le spectre est calculé depuis le même modèle physique. À l’écran : la brume.' },
      { id: 'brill', label: 'BRILLANCE', min: 0, max: 1, def: 0, follows: true,
        fmt: (v) => v.toFixed(2),
        info: 'Timbre du tick hi-hat (sombre → métallique brillant) et teinte de la palette pixel art (cyan pluie → ambre métal). Suit MORPH par défaut.' },
      { id: 'swing', label: 'SWING', min: 0, max: 0.6, def: 0,
        fmt: (v) => v.toFixed(2),
        info: 'Retarde un événement sur deux — le groove du bout hi-hat.' },
    ],
  },
  {
    id: 'orage', label: 'ORAGE', defOn: false,
    knobs: [
      { id: 'o_activite', label: 'ACTIVITÉ', min: 0.5, max: 12, def: 4, log: true,
        fmt: (v) => v.toFixed(1) + '/min',
        info: 'ORAGE — coups de foudre par minute (arrivées de Poisson). Côté m=1, le coup devient une CYMBALE CRASH quantifiée sur le 1, toutes les 2 mesures.' },
      { id: 'o_distance', label: 'DISTANCE', min: 0.15, max: 3, def: 0.8, log: true,
        fmt: (v) => v.toFixed(2) + 'km',
        info: 'ORAGE — distance de l’impact : l’éclair flashe immédiatement, le tonnerre arrive distance/343 m/s plus tard. Proche = crack sec + roulement fort ; lointain = grondement sourd (les aigus absorbés par l’air).' },
      { id: 'o_traine', label: 'TRAÎNE', min: 1, max: 4, def: 2.5,
        fmt: (v) => v.toFixed(1) + 's',
        info: 'ORAGE — longueur du roulement (échos multi-trajets) ; côté cymbale, longueur de la queue de la crash.' },
    ],
  },
  {
    id: 'vent', label: 'VENT', defOn: false,
    knobs: [
      { id: 'w_force', label: 'FORCE', min: 0, max: 1, def: 0.6,
        fmt: (v) => v.toFixed(2),
        info: 'VENT — niveau de la turbulence (corps large bande qui respire avec les rafales). Côté m=1 : niveau du RISER de bruit blanc qui monte sur 2 mesures et retombe sur le 1.' },
      { id: 'w_rafales', label: 'RAFALES', min: 0, max: 1, def: 0.5,
        fmt: (v) => v.toFixed(2),
        info: 'VENT — profondeur des rafales : module la voix de vent ET la respiration de la nappe de pluie. À l’écran : inclinaison et balancement de tout ce qui tombe.' },
      { id: 'w_sifflement', label: 'SIFFLEMENT', min: 0, max: 1, def: 0.35,
        fmt: (v) => v.toFixed(2),
        info: 'VENT — la résonance éolienne : le sifflement étroit autour des obstacles, dont la hauteur dérive avec les rafales.' },
    ],
  },
  {
    id: 'vague', label: 'VAGUE', defOn: false,
    knobs: [
      { id: 'v_houle', label: 'HOULE', min: 4, max: 18, def: 7,
        fmt: (v) => v.toFixed(1) + 's',
        info: 'VAGUE — période de la houle : un déferlement toutes les N secondes (timing naturellement irrégulier). Côté m=1, le déferlement devient un KICK 808 calé sur chaque beat.' },
      { id: 'v_taille', label: 'TAILLE', min: 0, max: 1, def: 0.6,
        fmt: (v) => v.toFixed(2),
        info: 'VAGUE — ampleur du déferlement : le « boum » sourd de la masse d’eau + l’écume. Côté kick : le punch. À l’écran : amplitude de la houle et de la déferlante.' },
      { id: 'v_ressac', label: 'RESSAC', min: 0, max: 1, def: 0.4,
        fmt: (v) => v.toFixed(2),
        info: 'VAGUE — le ressac continu entre les déferlements (écume lointaine). S’efface vers le kick.' },
    ],
  },
];

const PRESETS = [
  { name: 'bruine', o: { morph: 0, intensity: 0.8, taille: -0.2, nappe: 0.95, espace: 0.7 } },
  { name: 'pluie d’été', o: { morph: 0 } },
  { name: 'averse', o: { morph: 0, intensity: 45, taille: 0.25, nappe: 1 }, mods: { vent: { on: true, w_force: 0.45 } } },
  { name: 'orage', o: { morph: 0, intensity: 55, taille: 0.35, nappe: 1, espace: 0.65 }, mods: { orage: { on: true, o_activite: 5, o_distance: 0.6 }, vent: { on: true, w_force: 0.7, w_rafales: 0.8 } } },
  { name: 'toit en tôle', o: { morph: 0, intensity: 18, surface: 1, espace: 0.3 } },
  { name: 'bord de mer', o: { morph: 0, intensity: 6, espace: 0.8, nappe: 0.6 }, mods: { vague: { on: true, v_houle: 9, v_taille: 0.7, v_ressac: 0.6 }, vent: { on: true, w_force: 0.4, w_sifflement: 0.2 } } },
  { name: 'tempête', o: { morph: 0, intensity: 70, taille: 0.45, nappe: 1, espace: 0.5 }, mods: { orage: { on: true, o_activite: 9, o_distance: 0.35, o_traine: 3.5 }, vent: { on: true, w_force: 0.95, w_rafales: 0.9, w_sifflement: 0.6 }, vague: { on: true, v_houle: 7, v_taille: 0.95, v_ressac: 0.7 } } },
  { name: 'hi-hats', o: { morph: 1 } },
  { name: 'beat', o: { morph: 1, swing: 0.12, brill: 0.6 }, mods: { vague: { on: true }, orage: { on: true, o_traine: 3 }, vent: { on: true, w_force: 0.5 } } },
  { name: 'trap', o: { morph: 1, swing: 0.32, bpm: 140 }, mods: { vague: { on: true } } },
];

const MORPH_INFO = 'Le knob phare. 0 = paysage sonore physique (pluie, houle…) · 1 = kit de batterie sur la grille BPM (hi-hat, kick…). Tous les modules actifs morphent ensemble : timbre, taux d’événements, régularité et nappes glissent d’un seul geste.';
const EXTRA_INFO = [
  { label: 'MODULES', info: 'Chaque élément du paysage est un module : la pastille l’allume/l’éteint, cliquer son nom affiche ses knobs. PLUIE→hi-hat, VAGUE→kick — chacun a sa voix audio et sa couche d’animation.' },
  { label: 'BPM / DIV', info: 'Le transport commun du bout percussion : hi-hat sur la subdivision, kick sur chaque beat, tous en phase sur la même grille.' },
  { label: 'SEED', info: 'Graine du générateur aléatoire : même graine = même paysage, goutte pour goutte.' },
  { label: 'SWEEP', info: 'Balaye MORPH sur 8 s (vers le kit si on est côté nature, vers la nature sinon).' },
  { label: '◖ pastille', info: 'Pastille allumée sous un knob = le paramètre suit MORPH. Tourner le knob ou cliquer la pastille pour le décrocher.' },
  { label: 'pixel art', info: 'Chaque splash visible correspond à une goutte audible, chaque déferlante à une vague entendue, chaque secousse d’écran à un kick. La brume = la nappe des gouttes non résolues.' },
];

const state = { morph: 0, master: 0.8, seed: 1, bpm: 120, subdiv: 4, sel: 'pluie' };
const modOn = {};
for (const md of MODULES) modOn[md.id] = md.defOn;
let ctx = null, node = null, analyser = null, timeData = null;
let playing = false, sweepRAF = null;
const knobs = [];
const knobMap = {};
let morphKnob, stage;

// ---------- accent (teinte pilotée par la brillance : cyan → ambre) ----------
function resolvedBrill() {
  const k = knobMap.brill;
  return k.linked ? state.morph : k.value;
}
function setAccent() {
  const hue = 190 + (36 - 190) * resolvedBrill();
  const root = document.documentElement.style;
  root.setProperty('--accent', `hsl(${hue} 70% 56%)`);
  root.setProperty('--accent-dim', `hsl(${hue} 45% 34%)`);
  Knob.refreshAll();               // les knobs canvas reprennent la teinte
}

// ---------- plomberie des paramètres ----------
function buildMacros() {
  return {
    morph: state.morph,
    intensity: knobMap.intensity.value,
    sizeBias: knobMap.taille.value,
    regularity: knobMap.regularity.linked ? null : knobMap.regularity.value,
    rateMul: knobMap.rate.value,
    bpm: state.bpm,
    subdiv: state.subdiv,
    swing: knobMap.swing.value,
    surface: knobMap.surface.value,
    space: knobMap.espace.value,
    wash: knobMap.nappe.value,
    gustDepth: 0.3,                  // base sans module VENT (lui prend la main sinon)
    brill: resolvedBrill(),
    seed: state.seed,
    master: state.master,
    modules: {
      pluie: { on: modOn.pluie },
      vent: {
        on: modOn.vent,
        force: knobMap.w_force.value,
        rafales: knobMap.w_rafales.value,
        sifflement: knobMap.w_sifflement.value,
      },
      orage: {
        on: modOn.orage,
        activite: knobMap.o_activite.value,
        distance: knobMap.o_distance.value,
        traine: knobMap.o_traine.value,
      },
      vague: {
        on: modOn.vague,
        houle: knobMap.v_houle.value,
        taille: knobMap.v_taille.value,
        ressac: knobMap.v_ressac.value,
      },
    },
  };
}
function pushParams() {
  setAccent();
  const M = buildMacros();
  if (node) node.port.postMessage({ type: 'params', macros: M });
  stage.setParams({
    morph: M.morph, intensity: M.intensity, sizeBias: M.sizeBias,
    regularity: M.regularity ?? M.morph, surface: M.surface, space: M.space,
    wash: M.wash, brill: M.brill, playing,
    wind: M.modules.vent.on ? 0.3 + 0.7 * M.modules.vent.rafales : 0.3,
    mods: M.modules,
  });
}
function updateFollowers() {
  for (const k of knobs) {
    if (!k.follows || !k.linked) continue;
    k.setValue(k.id === 'regularity' ? state.morph * 0.999 : state.morph, true);
  }
}
function setMorph(v) {
  state.morph = clamp(v, 0, 1);
  morphKnob.setValue(state.morph, true);
  updateFollowers();
  pushParams();
}

// ---------- audio ----------
async function initAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.audioWorklet.addModule('rain-processor.js');
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.connect(ctx.destination);
  timeData = new Uint8Array(analyser.fftSize);
  node = new AudioWorkletNode(ctx, 'rain-processor', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { macros: buildMacros() },
  });
  node.port.onmessage = (e) => {
    if (e.data.type === 'drops') stage.onDrops(e.data.events);
    else if (e.data.type === 'tele') stage.onTele(e.data);
  };
  node.connect(analyser);
  drawMeter();
}

async function togglePlay() {
  await initAudio();
  if (ctx.state === 'suspended') await ctx.resume();
  playing = !playing;
  node.port.postMessage(playing ? { type: 'play', seed: state.seed } : { type: 'stop' });
  document.getElementById('play').classList.toggle('on', playing);
  document.querySelector('#play .lbl').textContent = playing ? '■ STOP' : '► PLAY';
  pushParams();
}

// ---------- sweep : balaye MORPH sur 8 s ----------
function sweep() {
  if (sweepRAF) { cancelAnimationFrame(sweepRAF); sweepRAF = null; }
  const from = state.morph;
  const to = from < 0.5 ? 1 : 0;
  const dur = 8000;
  const t0 = performance.now();
  const btn = document.getElementById('sweep');
  btn.classList.add('on');
  const step = (now) => {
    const t = clamp((now - t0) / dur, 0, 1);
    setMorph(from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * t)));
    if (t < 1) sweepRAF = requestAnimationFrame(step);
    else { sweepRAF = null; btn.classList.remove('on'); }
  };
  sweepRAF = requestAnimationFrame(step);
}

// ---------- vumètre : 12 blocs pixel, pas de dégradé ----------
function drawMeter() {
  const cv = document.getElementById('meter');
  const mctx = cv.getContext('2d');
  const NB = 12, gap = 1;
  const bw = Math.floor((cv.width - gap * (NB - 1)) / NB);
  const loop = () => {
    analyser.getByteTimeDomainData(timeData);
    let ss = 0;
    for (let i = 0; i < timeData.length; i++) { const v = (timeData[i] - 128) / 128; ss += v * v; }
    const rms = Math.sqrt(ss / timeData.length);
    const lit = Math.round(clamp(rms * 3.2, 0, 1) * NB);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent');
    mctx.clearRect(0, 0, cv.width, cv.height);
    for (let i = 0; i < NB; i++) {
      mctx.fillStyle = i < lit ? (i >= NB - 2 ? '#e8e0c8' : accent) : '#1a2030';
      mctx.fillRect(i * (bw + gap), 1, bw, cv.height - 2);
    }
    requestAnimationFrame(loop);
  };
  loop();
}

// ---------- modules : chips ON/OFF + sélection de la rangée de knobs ----------
function buildModules() {
  const row = document.getElementById('modules');
  for (const md of MODULES) {
    const chip = document.createElement('button');
    chip.className = 'mod-chip';
    chip.dataset.mod = md.id;
    chip.innerHTML = `<span class="mod-dot"></span><span class="mod-name">${md.label}</span>`;
    chip.querySelector('.mod-dot').addEventListener('click', (e) => {
      e.stopPropagation();
      modOn[md.id] = !modOn[md.id];
      refreshModules();
      pushParams();
    });
    chip.addEventListener('click', () => {
      state.sel = md.id;
      refreshModules();
    });
    row.appendChild(chip);
  }
  refreshModules();
}
function refreshModules() {
  document.querySelectorAll('.mod-chip').forEach((c) => {
    c.classList.toggle('on', !!modOn[c.dataset.mod]);
    c.classList.toggle('sel', state.sel === c.dataset.mod);
  });
  document.querySelectorAll('.knob-row').forEach((r) => {
    r.classList.toggle('sel', state.sel === r.dataset.mod);
  });
}

// ---------- presets ----------
function applyPreset(p) {
  // remet tout aux défauts (knobs + modules)…
  for (const k of knobs) {
    k.setValue(k.def, true);
    if (k.follows) k.setLinked(true);
  }
  for (const md of MODULES) modOn[md.id] = md.defOn;
  state.bpm = 120; document.getElementById('bpm').value = 120;
  // …puis applique les overrides du preset
  for (const [key, val] of Object.entries(p.o)) {
    if (key === 'morph') continue;
    if (key === 'bpm') { state.bpm = val; document.getElementById('bpm').value = val; continue; }
    const k = knobMap[key];
    if (!k) continue;
    k.setValue(val, true);
    if (k.follows) k.setLinked(false);
  }
  if (p.mods) {
    for (const [mid, cfg] of Object.entries(p.mods)) {
      if (cfg.on != null) modOn[mid] = cfg.on;
      for (const [key, val] of Object.entries(cfg)) {
        if (key !== 'on' && knobMap[key]) knobMap[key].setValue(val, true);
      }
    }
  }
  refreshModules();
  setMorph(p.o.morph ?? 0);
  highlightPreset(p.name);
}
function highlightPreset(name) {
  document.querySelectorAll('#presets .preset').forEach((b) =>
    b.classList.toggle('on', b.dataset.name === name));
}

// ---------- info ----------
function buildInfo() {
  const list = document.getElementById('info-list');
  const row = (k, d) => `<div class="info-row"><div class="info-k">${k}</div><div class="info-d">${d}</div></div>`;
  let html = row('MORPH', MORPH_INFO);
  for (const e of EXTRA_INFO) html += row(e.label, e.info);
  for (const md of MODULES) for (const c of md.knobs) html += row(c.label, c.info);
  list.innerHTML = html;
}

// ---------- boot ----------
function boot() {
  const dock = document.querySelector('.dock');
  stage = new PixelRain(document.getElementById('stage'), {
    bottomInset: () => (dock ? dock.offsetHeight + 18 : 0),
  });
  // le dock change de hauteur après remplissage (knobs, presets) → re-caler
  if (window.ResizeObserver) new ResizeObserver(() => stage.resize()).observe(dock);

  morphKnob = new Knob({
    id: 'morph', label: 'MORPH', min: 0, max: 1, def: 0, big: true,
    fmt: (v) => v.toFixed(2),
    onChange: (v) => setMorph(v),
  });
  document.getElementById('morph-slot').appendChild(morphKnob.el);

  // une rangée de knobs par module, affichée selon la sélection
  const grid = document.getElementById('knobs');
  for (const md of MODULES) {
    const rowEl = document.createElement('div');
    rowEl.className = 'knob-row';
    rowEl.dataset.mod = md.id;
    // custom property (pas de style inline : il écraserait le responsive CSS)
    rowEl.style.setProperty('--cols', md.knobs.length);
    for (const c of md.knobs) {
      const k = new Knob({
        ...c,
        onChange: (v, kn, why) => {
          if (kn.follows && why !== 'link') kn.setLinked(false);
          highlightPreset(null);
          pushParams();
        },
      });
      k.follows = !!c.follows;
      if (k.follows) k.setLinked(true);
      knobs.push(k);
      knobMap[c.id] = k;
      rowEl.appendChild(k.el);
    }
    grid.appendChild(rowEl);
  }

  buildModules();

  const presetBar = document.getElementById('presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.name = p.name;
    b.textContent = p.name;
    b.addEventListener('click', () => applyPreset(p));
    presetBar.appendChild(b);
  }

  document.getElementById('play').addEventListener('click', togglePlay);
  document.getElementById('sweep').addEventListener('click', async () => {
    if (!playing) await togglePlay();
    sweep();
  });
  document.getElementById('bpm').addEventListener('change', (e) => {
    state.bpm = clamp(+e.target.value || 120, 40, 220);
    e.target.value = state.bpm;
    pushParams();
  });
  document.getElementById('subdiv').addEventListener('change', (e) => {
    state.subdiv = +e.target.value;
    pushParams();
  });
  document.getElementById('seed').addEventListener('change', (e) => {
    state.seed = Math.max(0, Math.floor(+e.target.value || 0));
    if (node) node.port.postMessage({ type: 'seed', seed: state.seed });
  });
  document.getElementById('master').addEventListener('input', (e) => {
    state.master = +e.target.value;
    pushParams();
  });

  const info = document.getElementById('info');
  document.getElementById('info-btn').addEventListener('click', () => { info.hidden = false; });
  document.getElementById('info-close').addEventListener('click', () => { info.hidden = true; });
  info.addEventListener('click', (e) => { if (e.target === info) info.hidden = true; });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); togglePlay(); }
  });

  buildInfo();
  updateFollowers();
  pushParams();
  window.__stage = stage;          // hook de debug (déclencher des événements visuels)
}

boot();
