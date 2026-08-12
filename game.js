// INTERLOCK — DOM layer. All rules and scoring come from frame.mjs; this file only
// sequences calls to it, renders the result, and drives timing.
import * as F from './frame.mjs';

const params = new URLSearchParams(location.search);
const DEV = params.get('dev') === '1';

const table = F.buildTable();
const scenarios = F.buildScenarios();
const STORE_KEY = 'interlock_v1';

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : { best: {} };
  } catch {
    return { best: {} };
  }
}
function saveStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // storage unavailable — play on without persistence
  }
}
let store = loadStore();

const screens = {};
document.querySelectorAll('.screen').forEach((el) => { screens[el.id] = el; });
function showScreen(id) {
  Object.values(screens).forEach((el) => el.classList.remove('active'));
  screens[id].classList.add('active');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

const FLAVORS = {
  'box-1': 'first light, and nobody late',
  'box-2': 'the goods rolled through quiet',
  'box-3': 'the milk waited, patient as ever',
  'box-4': 'the milk train forgave me',
  'box-5': 'the freight tucked itself away',
  'box-6': 'fast and clean',
  'box-7': 'not a soul lost in the fog',
  'box-8': 'a quiet Sunday, kept quiet',
  'box-9': 'the last road of the night, set true',
  'box-10': 'the excursion never knew',
  'box-11': 'the passenger never slowed',
  'box-12': 'ten wagons, tucked in tidy',
  'box-13': 'a light engine and a clean board',
  'box-14': 'the relief made its own schedule work',
  'box-15': 'the last freight of the day, home',
};
function pickFlavor(sc) {
  return FLAVORS[sc.id] || 'the frame kept its word';
}
function starsText(n) {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

// ---------------------------------------------------------------------------
// runtime state
// ---------------------------------------------------------------------------
let scenario = null;
let frameState = null;
let tick = 0;
let liveTrainState = [];
let actionLog = [];
let checkEvents = [];
let logEntries = [];
let running = false;
let paused = false;
let lastTickTime = 0;
let lastResult = null;
const TICK_MS = 700;

function freshTrainState(sc) {
  return sc.trains.map((tr) => ({ id: tr.id, ptr: 0, occupiedTc: null, departTick: null, done: false, delay: 0 }));
}

function beginScenario(sc) {
  scenario = sc;
  frameState = F.createInitialState(table);
  tick = 0;
  actionLog = [];
  checkEvents = [];
  logEntries = [];
  liveTrainState = freshTrainState(sc);
  running = true;
  paused = false;
  lastTickTime = 0;
  showScreen('screen-play');
  document.getElementById('play-title').textContent = `Box ${scenario.boxNumber} — ${scenario.title}`;
  document.getElementById('play-blurb').textContent = scenario.blurb;
  document.getElementById('btn-pause').textContent = 'PAUSE';
  renderAll();
  requestAnimationFrame(rafLoop);
}

function loadScenario(idOrIndex) {
  const sc = typeof idOrIndex === 'number' ? scenarios[idOrIndex] : scenarios.find((s) => s.id === idOrIndex);
  if (sc) beginScenario(sc);
}

function loadStrangeScenario(seedOverride) {
  const seed = seedOverride != null ? seedOverride : Math.floor(Math.random() * 1e9);
  beginScenario(F.generateStrangeWorking(seed));
}

function pullLever(leverId, targetPos) {
  const res = F.pull(table, frameState, leverId, targetPos);
  if (res.ok) {
    frameState = res.state;
    actionLog.push({ tick, lever: leverId, pos: targetPos });
    pushLog(`${table[leverId].name} → ${targetPos === 'R' ? 'reversed' : 'normal'}`, 'ok');
  } else {
    pushLog(res.rule, 'rule');
  }
  renderAll();
  return res;
}

function toggleLever(leverId) {
  const cur = frameState.levers[leverId];
  pullLever(leverId, cur === 'R' ? 'N' : 'R');
}

function pushLog(msg, cls) {
  logEntries.push({ msg, cls });
  if (logEntries.length > 60) logEntries.shift();
}

function advanceTick() {
  if (!running) return;
  for (const ts of liveTrainState) {
    if (ts.occupiedTc && ts.departTick === tick) {
      frameState = F.setTrackCircuit(frameState, ts.occupiedTc, 'clear');
      ts.occupiedTc = null;
    }
  }
  scenario.trains.forEach((tr, i) => {
    const ts = liveTrainState[i];
    if (ts.done) return;
    const cp = tr.checkpoints[ts.ptr];
    if (!cp) {
      ts.done = true;
      return;
    }
    const effectiveArrival = cp.arrivalTick + ts.delay;
    if (tick !== effectiveArrival) return;
    if (frameState.levers[cp.lever] === 'R') {
      frameState = F.setTrackCircuit(frameState, cp.tc, 'occupied');
      ts.occupiedTc = cp.tc;
      ts.departTick = tick + cp.transitTicks;
      ts.ptr += 1;
      pushLog(`${tr.id} passes ${table[cp.lever].name}`, 'ok');
    } else {
      checkEvents.push({ train: tr.id, lever: cp.lever, tick });
      ts.delay += 1;
      pushLog(`${tr.id} is checked at ${table[cp.lever].name}`, 'check');
    }
  });
  tick += 1;
  renderAll();
  if (tick > scenario.horizon) {
    running = false;
    finish();
  }
}

function finish() {
  const result = F.runScenario(table, scenario, actionLog);
  lastResult = result;
  const prevBest = store.best[scenario.id] || 0;
  if (result.stars > prevBest) {
    store.best[scenario.id] = result.stars;
    saveStore(store);
  }
  document.getElementById('result-title').textContent = `Box ${scenario.boxNumber} closed`;
  document.getElementById('result-score').textContent = String(result.score);
  document.getElementById('result-stars').textContent = starsText(result.stars);
  document.getElementById('result-summary').textContent = result.perfect
    ? 'A clean shift. Nobody was checked.'
    : `${result.checks.length} train${result.checks.length === 1 ? '' : 's'} checked along the way.`;
  const flavor = result.perfect ? pickFlavor(scenario) : 'the frame held, even so';
  const share = F.buildShareText({
    boxNumber: scenario.boxNumber,
    movements: result.movements,
    checks: result.checks.length,
    flavor,
    url: 'http://interlock.defimagic.io',
  });
  document.getElementById('share-text').textContent = share;
  showScreen('screen-result');
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
function renderScenarioList() {
  const el = document.getElementById('scenario-list');
  el.innerHTML = '';
  scenarios.forEach((sc, idx) => {
    const row = document.createElement('div');
    row.className = 'scenario-row';
    const stars = store.best[sc.id] || 0;
    row.innerHTML = `<div class="num">${sc.boxNumber}</div>` +
      `<div class="meta"><div class="title">${escapeHtml(sc.title)}</div><div class="blurb">${escapeHtml(sc.blurb)}</div></div>` +
      `<div class="stars">${stars ? starsText(stars) : '—'}</div>`;
    row.addEventListener('click', () => loadScenario(idx));
    el.appendChild(row);
  });
}

function renderFrame() {
  const grid = document.getElementById('frame-grid');
  grid.innerHTML = '';
  for (const id of F.LEVER_IDS) {
    const def = table[id];
    const pos = frameState.levers[id];
    const div = document.createElement('div');
    div.className = 'lever' + (def.type === 'signal' ? ' signal' : '') + (pos === 'R' ? ' reversed' : '');
    div.innerHTML = `<div class="num">${id.replace('L', '')}</div>` +
      `<div class="name">${escapeHtml(def.name)}</div>` +
      `<div class="shaft"></div>` +
      `<div class="pos">${pos}</div>`;
    div.addEventListener('click', () => toggleLever(id));
    grid.appendChild(div);
  }
}

function renderDiagram() {
  const el = document.getElementById('diagram');
  const tc = frameState.trackCircuits;
  const lv = frameState.levers;
  const occ = (id) => tc[id] === 'occupied';
  const sigState = (leverId) => (lv[leverId] === 'R' ? 'clear' : 'danger');
  const dot = (cls, x, y) => `<circle class="sig-dot ${cls}" cx="${x}" cy="${y}"></circle>`;

  const onTc = {};
  scenario.trains.forEach((tr, i) => {
    const ts = liveTrainState[i];
    if (ts.occupiedTc) {
      onTc[ts.occupiedTc] = onTc[ts.occupiedTc] || [];
      onTc[ts.occupiedTc].push(tr.id);
    }
  });
  const trainLabel = (tcId, cx, cy) => {
    const list = onTc[tcId];
    if (!list || !list.length) return '';
    return `<text class="train-icon" x="${cx}" y="${cy}" text-anchor="middle">🚆</text>` +
      `<text class="diagram-label" x="${cx}" y="${cy + 14}" text-anchor="middle">${escapeHtml(list.join(', '))}</text>`;
  };

  const l3y = lv.L3 === 'R' ? 42 : 18;
  const l9y = lv.L9 === 'R' ? 122 : 98;

  el.innerHTML = `
  <svg viewBox="0 0 440 150" xmlns="http://www.w3.org/2000/svg">
    <text class="diagram-label" x="4" y="10">DOWN</text>
    <rect class="tc-rect ${occ(F.TC.DOWN_JCT) ? 'occupied' : ''}" x="20" y="15" width="110" height="30" rx="4"></rect>
    <rect class="tc-rect ${occ(F.TC.DOWN_SECTION) ? 'occupied' : ''}" x="140" y="15" width="290" height="30" rx="4"></rect>
    ${dot(sigState('L2'), 12, 30)}
    ${dot(sigState('L5'), 138, 22)}
    ${dot(sigState('L6'), 138, 38)}
    <line class="pt-mark" x1="60" y1="30" x2="80" y2="${l3y}"></line>
    <text class="diagram-label" x="95" y="12">${lv.L4 === 'R' ? 'F.P.L. locked' : 'F.P.L. free'}</text>
    ${trainLabel(F.TC.DOWN_JCT, 75, 33)}
    ${trainLabel(F.TC.DOWN_SECTION, 285, 33)}

    <text class="diagram-label" x="4" y="90">UP</text>
    <rect class="tc-rect ${occ(F.TC.UP_HOME_SEC) ? 'occupied' : ''}" x="20" y="95" width="110" height="30" rx="4"></rect>
    <rect class="tc-rect ${occ(F.TC.UP_JCT) ? 'occupied' : ''}" x="140" y="95" width="110" height="30" rx="4"></rect>
    <rect class="tc-rect ${occ(F.TC.UP_SECTION) ? 'occupied' : ''}" x="260" y="95" width="170" height="30" rx="4"></rect>
    ${dot(sigState('L7'), 12, 110)}
    ${dot(sigState('L11'), 258, 102)}
    ${dot(sigState('L12'), 258, 118)}
    <line class="pt-mark" x1="180" y1="110" x2="200" y2="${l9y}"></line>
    <text class="diagram-label" x="215" y="92">${lv.L10 === 'R' ? 'F.P.L. locked' : 'F.P.L. free'}</text>
    ${trainLabel(F.TC.UP_HOME_SEC, 75, 113)}
    ${trainLabel(F.TC.UP_JCT, 195, 113)}
    ${trainLabel(F.TC.UP_SECTION, 345, 113)}
  </svg>`;
}

function renderLog() {
  const el = document.getElementById('log');
  el.innerHTML = logEntries
    .slice(-14)
    .reverse()
    .map((e) => `<div class="entry ${e.cls}">${escapeHtml(e.msg)}</div>`)
    .join('');
}

function renderAll() {
  if (!scenario) return;
  renderFrame();
  renderDiagram();
  renderLog();
  document.getElementById('play-tick').textContent = `t=${tick} / ${scenario.horizon}`;
}

// ---------------------------------------------------------------------------
// frame loop — step() is callable directly (dev hook / hidden-tab safe);
// rafLoop drives it in real time.
// ---------------------------------------------------------------------------
function step(now) {
  if (!running || paused) return;
  if (now - lastTickTime >= TICK_MS) {
    lastTickTime = now;
    advanceTick();
  }
}
function rafLoop(now) {
  step(now);
  if (running) requestAnimationFrame(rafLoop);
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
document.getElementById('btn-start').addEventListener('click', () => {
  renderScenarioList();
  showScreen('screen-select');
});
document.getElementById('btn-howto-from-title').addEventListener('click', () => showScreen('screen-howto'));
document.getElementById('btn-howto-back').addEventListener('click', () => showScreen('screen-title'));
document.getElementById('btn-select-back').addEventListener('click', () => showScreen('screen-title'));
document.getElementById('btn-strange').addEventListener('click', () => loadStrangeScenario());
document.getElementById('btn-pause').addEventListener('click', () => {
  paused = !paused;
  document.getElementById('btn-pause').textContent = paused ? 'RESUME' : 'PAUSE';
  if (!paused) {
    lastTickTime = 0;
    requestAnimationFrame(rafLoop);
  }
});
document.getElementById('btn-step').addEventListener('click', () => {
  if (running) advanceTick();
});
document.getElementById('btn-play-quit').addEventListener('click', () => {
  running = false;
  renderScenarioList();
  showScreen('screen-select');
});
document.getElementById('btn-copy-share').addEventListener('click', () => {
  const text = document.getElementById('share-text').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
});
document.getElementById('btn-next').addEventListener('click', () => {
  const idx = scenarios.indexOf(scenario);
  if (idx >= 0 && idx < scenarios.length - 1) loadScenario(idx + 1);
  else {
    renderScenarioList();
    showScreen('screen-select');
  }
});
document.getElementById('btn-result-menu').addEventListener('click', () => {
  renderScenarioList();
  showScreen('screen-select');
});

// ---------------------------------------------------------------------------
// dev hook — ?dev=1 exposes window.__g sufficient to drive every screen headlessly.
// ---------------------------------------------------------------------------
if (DEV) {
  window.__g = {
    table,
    F,
    scenarios,
    getState: () => ({
      screen: Object.values(screens).find((s) => s.classList.contains('active'))?.id,
      tick,
      scenarioId: scenario && scenario.id,
      frameState,
      checks: checkEvents.length,
      running,
      paused,
      lastResult,
    }),
    listScenarios: () => scenarios.map((s, i) => ({ index: i, id: s.id, boxNumber: s.boxNumber, title: s.title })),
    goto: (id) => showScreen(id),
    openSelect: () => {
      renderScenarioList();
      showScreen('screen-select');
    },
    load: (idOrIndex) => loadScenario(idOrIndex),
    loadStrange: (seed) => loadStrangeScenario(seed),
    pull: (leverId, pos) => pullLever(leverId, pos),
    advance: (n = 1) => {
      for (let i = 0; i < n && running; i++) advanceTick();
    },
    autoSolveAndRun: () => {
      if (!scenario) return { ok: false, reason: 'no scenario loaded' };
      const sol = F.autoSolve(table, scenario, 40);
      if (!sol.ok) return sol;
      for (const a of sol.actions) {
        while (running && tick < a.tick) advanceTick();
        pullLever(a.lever, a.pos);
      }
      while (running) advanceTick();
      return { ok: true, result: lastResult };
    },
  };
}
