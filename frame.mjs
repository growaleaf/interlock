// INTERLOCK — pure core. No DOM, no WebAudio, no Date.now()/Math.random() in logic paths.
// Models a real mechanical lever frame: levers, an interlocking table (requires/conflicts/FPL
// locks/track-circuit blocks), a scenario timetable runner, a greedy solver, and a scorer.

// ---------------------------------------------------------------------------
// PRNG (mulberry32) — deterministic, seeded.
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// THE FRAME — track circuits and the 12-lever interlocking table.
// ---------------------------------------------------------------------------
export const TC = {
  DOWN_JCT: 'TC_DOWN_JCT',
  DOWN_SECTION: 'TC_DOWN_SECTION',
  UP_HOME_SEC: 'TC_UP_HOME',
  UP_JCT: 'TC_UP_JCT',
  UP_SECTION: 'TC_UP_SECTION',
};

export const ALL_TRACK_CIRCUITS = Object.values(TC);

export const LEVER_IDS = [
  'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12',
];

export function buildTable() {
  const t = {};
  t.L1 = { id: 'L1', name: 'Down Distant', type: 'signal', requires: [{ lever: 'L2', pos: 'R' }], trackCircuits: [], conflicts: [] };
  t.L2 = { id: 'L2', name: 'Down Home', type: 'signal', requires: [{ lever: 'L4', pos: 'R' }], trackCircuits: [TC.DOWN_JCT], conflicts: [] };
  t.L3 = { id: 'L3', name: 'Down Loop Points', type: 'point', fpl: 'L4', requires: [], trackCircuits: [TC.DOWN_JCT], conflicts: [] };
  t.L4 = { id: 'L4', name: 'Down Loop F.P.L.', type: 'fpl', requires: [], trackCircuits: [TC.DOWN_JCT], conflicts: [] };
  t.L5 = { id: 'L5', name: 'Down Section', type: 'signal', requires: [{ lever: 'L3', pos: 'N' }, { lever: 'L4', pos: 'R' }], trackCircuits: [TC.DOWN_SECTION], conflicts: ['L6'] };
  t.L6 = { id: 'L6', name: 'Down Loop Exit', type: 'signal', requires: [{ lever: 'L3', pos: 'R' }, { lever: 'L4', pos: 'R' }], trackCircuits: [TC.DOWN_SECTION], conflicts: ['L5'] };
  t.L7 = { id: 'L7', name: 'Up Home', type: 'signal', requires: [], trackCircuits: [TC.UP_HOME_SEC], conflicts: [] };
  t.L8 = { id: 'L8', name: 'Up Distant', type: 'signal', requires: [{ lever: 'L7', pos: 'R' }], trackCircuits: [], conflicts: [] };
  t.L9 = { id: 'L9', name: 'Up Refuge Points', type: 'point', fpl: 'L10', requires: [], trackCircuits: [TC.UP_JCT], conflicts: [] };
  t.L10 = { id: 'L10', name: 'Up Refuge F.P.L.', type: 'fpl', requires: [], trackCircuits: [TC.UP_JCT], conflicts: [] };
  t.L11 = { id: 'L11', name: 'Up Refuge Exit', type: 'signal', requires: [{ lever: 'L9', pos: 'R' }, { lever: 'L10', pos: 'R' }], trackCircuits: [TC.UP_SECTION], conflicts: ['L12'] };
  t.L12 = { id: 'L12', name: 'Up Starting', type: 'signal', requires: [{ lever: 'L7', pos: 'R' }, { lever: 'L9', pos: 'N' }, { lever: 'L10', pos: 'R' }], trackCircuits: [TC.UP_SECTION], conflicts: ['L11'] };
  return t;
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
export function createInitialState(table) {
  const levers = {};
  for (const id of Object.keys(table)) levers[id] = 'N';
  const trackCircuits = {};
  for (const tc of ALL_TRACK_CIRCUITS) trackCircuits[tc] = 'clear';
  return { levers, trackCircuits };
}

function cloneState(state) {
  return { levers: { ...state.levers }, trackCircuits: { ...state.trackCircuits } };
}

export function setTrackCircuit(state, tcId, status) {
  const next = cloneState(state);
  next.trackCircuits[tcId] = status;
  return next;
}

// ---------------------------------------------------------------------------
// INTERLOCKING — the constraint table IS the gameplay.
// ---------------------------------------------------------------------------
export function canMove(table, state, leverId, targetPos) {
  const def = table[leverId];
  if (!def) return { ok: false, rule: `no such lever ${leverId}` };
  const cur = state.levers[leverId];
  if (cur === targetPos) {
    return { ok: false, rule: `${def.name} is already ${targetPos === 'R' ? 'reversed' : 'normal'}` };
  }

  // Facing point lock: a point cannot move (either direction) while its FPL is reversed (locked).
  if (def.type === 'point' && def.fpl && state.levers[def.fpl] === 'R') {
    return { ok: false, rule: `${def.name} is locked by ${table[def.fpl].name} — release the lock first` };
  }

  // Track circuit block: points/FPL cannot move under a train, in either direction.
  if (def.type !== 'signal') {
    for (const tc of def.trackCircuits) {
      if (state.trackCircuits[tc] === 'occupied') {
        return { ok: false, rule: `${def.name} cannot move — track circuit ${tc} is occupied by a train` };
      }
    }
  }

  if (targetPos === 'R') {
    for (const req of def.requires) {
      if (state.levers[req.lever] !== req.pos) {
        const other = table[req.lever];
        return { ok: false, rule: `${def.name} requires ${other.name} ${req.pos === 'R' ? 'reversed' : 'normal'} first` };
      }
    }
    for (const c of def.conflicts) {
      if (state.levers[c] === 'R') {
        const other = table[c];
        return { ok: false, rule: `${def.name} is locked out by ${other.name} (conflicting road set)` };
      }
    }
    if (def.type === 'signal') {
      for (const tc of def.trackCircuits) {
        if (state.trackCircuits[tc] === 'occupied') {
          return { ok: false, rule: `${def.name} cannot clear — track circuit ${tc} occupied ahead` };
        }
      }
    }
  } else {
    // Normalizing: blocked if some other reversed lever mechanically requires this lever
    // to stay exactly where it is. This is how a cleared signal "locks" the points/FPL
    // beneath its route until the signalman restores it to danger.
    for (const otherId of Object.keys(table)) {
      if (otherId === leverId) continue;
      if (state.levers[otherId] !== 'R') continue;
      const otherDef = table[otherId];
      for (const req of otherDef.requires) {
        if (req.lever === leverId && req.pos === cur) {
          return { ok: false, rule: `${def.name} is locked by ${otherDef.name} (reversed) — restore it to danger first` };
        }
      }
    }
  }
  return { ok: true };
}

export function pull(table, state, leverId, targetPos) {
  const check = canMove(table, state, leverId, targetPos);
  if (!check.ok) return { ok: false, rule: check.rule, state };
  const next = cloneState(state);
  next.levers[leverId] = targetPos;
  return { ok: true, state: next };
}

// A reachable state is legal iff every reversed lever's own requires/conflicts still hold —
// true by construction if only pull() was used, but asserted independently as a fuzz check.
export function invariantsHold(table, state) {
  for (const id of Object.keys(table)) {
    const def = table[id];
    if (state.levers[id] !== 'R') continue;
    for (const req of def.requires) {
      if (state.levers[req.lever] !== req.pos) {
        return { ok: false, reason: `${id} reversed but ${req.lever} is not ${req.pos}` };
      }
    }
    for (const c of def.conflicts) {
      if (state.levers[c] === 'R') {
        return { ok: false, reason: `${id} and ${c} both reversed (conflicting road)` };
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// REACHABILITY — proves the table itself is consistent: no dead-end state,
// every reachable state can get back to the all-normal starting state.
// ---------------------------------------------------------------------------
function stateKey(state) {
  return LEVER_IDS.map((id) => state.levers[id]).join('');
}

export function bfsWithEdges(table) {
  const start = createInitialState(table);
  const startKey = stateKey(start);
  const nodes = new Map([[startKey, start]]);
  const edges = [];
  const queue = [start];
  while (queue.length) {
    const s = queue.shift();
    const sKey = stateKey(s);
    for (const id of LEVER_IDS) {
      for (const target of ['N', 'R']) {
        const res = pull(table, s, id, target);
        if (res.ok) {
          const key = stateKey(res.state);
          edges.push([sKey, key]);
          if (!nodes.has(key)) {
            nodes.set(key, res.state);
            queue.push(res.state);
          }
        }
      }
    }
  }
  return { nodes, edges, startKey };
}

export function allStatesCanReturnToStart(table) {
  const { nodes, edges, startKey } = bfsWithEdges(table);
  const reverseAdj = new Map();
  for (const [from, to] of edges) {
    if (!reverseAdj.has(to)) reverseAdj.set(to, []);
    reverseAdj.get(to).push(from);
  }
  const reachToStart = new Set([startKey]);
  const queue = [startKey];
  while (queue.length) {
    const k = queue.shift();
    for (const p of reverseAdj.get(k) || []) {
      if (!reachToStart.has(p)) {
        reachToStart.add(p);
        queue.push(p);
      }
    }
  }
  return { ok: reachToStart.size === nodes.size, totalStates: nodes.size, reachable: reachToStart.size };
}

// ---------------------------------------------------------------------------
// SOLVER — recursively resolves whatever the interlocking table demands.
// ---------------------------------------------------------------------------
function resolveLever(table, state, leverId, targetPos, tick, actionsOut, depth) {
  if (depth > 12) return { ok: false, state };
  const def = table[leverId];
  const cur = state.levers[leverId];
  if (cur === targetPos) return { ok: true, state };

  if (def.type === 'point' && def.fpl && state.levers[def.fpl] === 'R') {
    const r = resolveLever(table, state, def.fpl, 'N', tick, actionsOut, depth + 1);
    if (!r.ok) return r;
    state = r.state;
  }

  if (def.type !== 'signal') {
    for (const tc of def.trackCircuits) {
      if (state.trackCircuits[tc] === 'occupied') return { ok: false, state };
    }
  }

  if (targetPos === 'R') {
    for (const req of def.requires) {
      if (state.levers[req.lever] !== req.pos) {
        const r = resolveLever(table, state, req.lever, req.pos, tick, actionsOut, depth + 1);
        if (!r.ok) return r;
        state = r.state;
      }
    }
    for (const c of def.conflicts) {
      if (state.levers[c] === 'R') {
        const r = resolveLever(table, state, c, 'N', tick, actionsOut, depth + 1);
        if (!r.ok) return r;
        state = r.state;
      }
    }
    if (def.type === 'signal') {
      for (const tc of def.trackCircuits) {
        if (state.trackCircuits[tc] === 'occupied') return { ok: false, state };
      }
    }
  } else {
    for (const otherId of Object.keys(table)) {
      if (otherId === leverId) continue;
      if (state.levers[otherId] !== 'R') continue;
      const otherDef = table[otherId];
      for (const req of otherDef.requires) {
        if (req.lever === leverId && req.pos === cur) {
          const r = resolveLever(table, state, otherId, 'N', tick, actionsOut, depth + 1);
          if (!r.ok) return r;
          state = r.state;
        }
      }
    }
  }

  const check = canMove(table, state, leverId, targetPos);
  if (!check.ok) return { ok: false, state };
  const res = pull(table, state, leverId, targetPos);
  actionsOut.push({ tick, lever: leverId, pos: targetPos });
  return { ok: true, state: res.state };
}

export function autoSolve(table, scenario, moveBudget = 40) {
  let state = createInitialState(table);
  const actions = [];
  const trainState = scenario.trains.map(() => ({ ptr: 0, occupiedTc: null, departTick: null, done: false, delay: 0 }));

  for (let tick = 0; tick <= scenario.horizon; tick++) {
    for (const ts of trainState) {
      if (ts.occupiedTc && ts.departTick === tick) {
        state = setTrackCircuit(state, ts.occupiedTc, 'clear');
        ts.occupiedTc = null;
      }
    }
    for (let i = 0; i < trainState.length; i++) {
      const ts = trainState[i];
      if (ts.done) continue;
      const tr = scenario.trains[i];
      const cp = tr.checkpoints[ts.ptr];
      if (!cp) {
        ts.done = true;
        continue;
      }
      const effectiveArrival = cp.arrivalTick + ts.delay;
      if (tick !== effectiveArrival) continue;
      for (const r of cp.route || []) {
        if (state.levers[r.lever] !== r.pos) {
          const rr = resolveLever(table, state, r.lever, r.pos, tick, actions, 0);
          if (rr.ok) state = rr.state;
        }
      }
      if (state.levers[cp.lever] !== 'R') {
        const r = resolveLever(table, state, cp.lever, 'R', tick, actions, 0);
        if (r.ok) state = r.state;
      }
      if (state.levers[cp.lever] === 'R') {
        state = setTrackCircuit(state, cp.tc, 'occupied');
        ts.occupiedTc = cp.tc;
        ts.departTick = tick + cp.transitTicks;
        ts.ptr += 1;
      } else {
        ts.delay += 1;
      }
    }
  }

  if (actions.length > moveBudget) return { ok: false, actions, reason: 'exceeded move budget' };
  return { ok: true, actions };
}

// ---------------------------------------------------------------------------
// SCENARIO RUNNER — plays a scripted action log against a timetable, deterministically.
// ---------------------------------------------------------------------------
export function scorePunctuality(numChecks, totalDelay, numTrains) {
  let score = 100 - numChecks * 20 - totalDelay * 3;
  if (score < 0) score = 0;
  const perfect = numChecks === 0;
  const stars = perfect ? 3 : score >= 60 ? 2 : score >= 30 ? 1 : 0;
  return { score, stars, perfect };
}

export function runScenario(table, scenario, actionLog) {
  let state = createInitialState(table);
  const sortedActions = [...actionLog].sort((a, b) => a.tick - b.tick);
  let ai = 0;
  const checks = [];
  const failedActions = [];
  const trainState = scenario.trains.map((tr) => ({ id: tr.id, ptr: 0, occupiedTc: null, departTick: null, done: false, delay: 0 }));

  for (let tick = 0; tick <= scenario.horizon; tick++) {
    while (ai < sortedActions.length && sortedActions[ai].tick === tick) {
      const act = sortedActions[ai];
      const res = pull(table, state, act.lever, act.pos);
      if (res.ok) state = res.state;
      else failedActions.push({ ...act, rule: res.rule });
      ai++;
    }
    for (const ts of trainState) {
      if (ts.occupiedTc && ts.departTick === tick) {
        state = setTrackCircuit(state, ts.occupiedTc, 'clear');
        ts.occupiedTc = null;
      }
    }
    for (let i = 0; i < trainState.length; i++) {
      const ts = trainState[i];
      if (ts.done) continue;
      const tr = scenario.trains[i];
      const cp = tr.checkpoints[ts.ptr];
      if (!cp) {
        ts.done = true;
        continue;
      }
      const effectiveArrival = cp.arrivalTick + ts.delay;
      if (tick !== effectiveArrival) continue;
      if (state.levers[cp.lever] === 'R') {
        state = setTrackCircuit(state, cp.tc, 'occupied');
        ts.occupiedTc = cp.tc;
        ts.departTick = tick + cp.transitTicks;
        ts.ptr += 1;
      } else {
        checks.push({ train: tr.id, lever: cp.lever, tick });
        ts.delay += 1;
      }
    }
  }

  const totalDelay = trainState.reduce((s, ts) => s + ts.delay, 0);
  const movements = sortedActions.length - failedActions.length;
  const { score, stars, perfect } = scorePunctuality(checks.length, totalDelay, scenario.trains.length);
  return { state, checks, failedActions, movements, totalDelay, score, stars, perfect };
}

// ---------------------------------------------------------------------------
// AUTHORED SCENARIOS — 15 timetable workings for one box, plus a seeded generator.
// ---------------------------------------------------------------------------
function downMainScenario(id, boxNumber, title, blurb, trainId, jctTick, sectionTick) {
  return {
    id, boxNumber, title, blurb, horizon: sectionTick + 8,
    trains: [{
      id: trainId,
      checkpoints: [
        { tc: TC.DOWN_JCT, lever: 'L2', arrivalTick: jctTick, transitTicks: sectionTick - jctTick, route: [{ lever: 'L3', pos: 'N' }] },
        { tc: TC.DOWN_SECTION, lever: 'L5', arrivalTick: sectionTick, transitTicks: 5, route: [] },
      ],
    }],
  };
}

function downLoopScenario(id, boxNumber, title, blurb, trainId, jctTick) {
  return {
    id, boxNumber, title, blurb, horizon: jctTick + 10,
    trains: [{
      id: trainId,
      checkpoints: [
        { tc: TC.DOWN_JCT, lever: 'L2', arrivalTick: jctTick, transitTicks: 4, route: [{ lever: 'L3', pos: 'R' }] },
      ],
    }],
  };
}

function upMainScenario(id, boxNumber, title, blurb, trainId, homeTick, startTick) {
  return {
    id, boxNumber, title, blurb, horizon: startTick + 8,
    trains: [{
      id: trainId,
      checkpoints: [
        { tc: TC.UP_HOME_SEC, lever: 'L7', arrivalTick: homeTick, transitTicks: startTick - homeTick, route: [{ lever: 'L9', pos: 'N' }] },
        { tc: TC.UP_SECTION, lever: 'L12', arrivalTick: startTick, transitTicks: 5, route: [] },
      ],
    }],
  };
}

function upRefugeScenario(id, boxNumber, title, blurb, trainId, homeTick) {
  return {
    id, boxNumber, title, blurb, horizon: homeTick + 12,
    trains: [{
      id: trainId,
      checkpoints: [
        { tc: TC.UP_HOME_SEC, lever: 'L7', arrivalTick: homeTick, transitTicks: 4, route: [{ lever: 'L9', pos: 'R' }] },
        { tc: TC.UP_SECTION, lever: 'L11', arrivalTick: homeTick + 6, transitTicks: 4, route: [] },
      ],
    }],
  };
}

export function buildScenarios() {
  return [
    upMainScenario('box-1', 1, 'First Light', 'The 6:05 stopping service, first movement of the day.', 'up-local', 4, 9),
    downMainScenario('box-2', 2, 'The Down Slow', 'A goods train ambles through on the main.', 'down-goods', 3, 8),
    downLoopScenario('box-3', 3, 'Milk to the Loop', 'The milk train waits its turn, shunted clear.', 'milk-early', 3),
    {
      id: 'box-4', boxNumber: 4, title: 'The 8:40 Fast',
      blurb: 'The milk train waits in the loop while the fast runs through on time behind it.',
      horizon: 25,
      trains: [
        { id: 'milk', checkpoints: [
          { tc: TC.DOWN_JCT, lever: 'L2', arrivalTick: 2, transitTicks: 3, route: [{ lever: 'L3', pos: 'R' }] },
          { tc: TC.DOWN_SECTION, lever: 'L6', arrivalTick: 17, transitTicks: 4, route: [{ lever: 'L3', pos: 'R' }] },
        ] },
        { id: 'fast', checkpoints: [
          { tc: TC.DOWN_JCT, lever: 'L2', arrivalTick: 8, transitTicks: 3, route: [{ lever: 'L3', pos: 'N' }] },
          { tc: TC.DOWN_SECTION, lever: 'L5', arrivalTick: 12, transitTicks: 4, route: [] },
        ] },
      ],
    },
    upRefugeScenario('box-5', 5, 'Room for the Freight', 'A slow freight steps aside into the refuge.', 'up-freight', 3),
    upMainScenario('box-6', 6, 'The 7:50 Express', 'Fast and light, straight through.', 'up-express', 2, 7),
    downMainScenario('box-7', 7, 'Fog on the Down Line', 'Visibility is poor; the distant repeats what the home shows.', 'down-fog', 4, 10),
    downLoopScenario('box-8', 8, 'Sunday Freight', 'A quiet Sunday goods, held clear of the branch connection.', 'sun-freight', 5),
    upMainScenario('box-9', 9, 'The Last Train', 'Final working of the night, main line clear.', 'up-last', 3, 8),
    downMainScenario('box-10', 10, 'Excursion Special', 'A summer excursion, straight down the main.', 'down-excursion', 2, 7),
    {
      id: 'box-11', boxNumber: 11, title: 'Room to Pass',
      blurb: 'The freight steps into the refuge so the passenger can run straight through.',
      horizon: 25,
      trains: [
        { id: 'freight', checkpoints: [
          { tc: TC.UP_HOME_SEC, lever: 'L7', arrivalTick: 2, transitTicks: 3, route: [{ lever: 'L9', pos: 'R' }] },
          { tc: TC.UP_SECTION, lever: 'L11', arrivalTick: 17, transitTicks: 4, route: [{ lever: 'L9', pos: 'R' }] },
        ] },
        { id: 'passenger', checkpoints: [
          { tc: TC.UP_HOME_SEC, lever: 'L7', arrivalTick: 8, transitTicks: 3, route: [{ lever: 'L9', pos: 'N' }] },
          { tc: TC.UP_SECTION, lever: 'L12', arrivalTick: 12, transitTicks: 4, route: [] },
        ] },
      ],
    },
    downLoopScenario('box-12', 12, 'Ten Wagons for the Yard', 'A short trip working, tucked into the loop.', 'yard-trip', 4),
    upMainScenario('box-13', 13, 'The Parcels Van', 'Light engine and a single van, straight through.', 'up-parcels', 3, 8),
    downMainScenario('box-14', 14, 'Relief Working', 'An unscheduled relief service on the main.', 'down-relief', 5, 11),
    upRefugeScenario('box-15', 15, 'Evening Freight', 'The last freight steps into the refuge for the night.', 'ev-freight', 4),
  ];
}

const STRANGE_NAMES = ['the goods', 'a light engine', 'the parcels', 'an excursion', 'the mail', 'a relief working', 'the last train down', 'a special'];
const STRANGE_ROUTES = ['downMain', 'downLoop', 'upMain', 'upRefuge'];

export function generateStrangeWorking(seed) {
  const rnd = mulberry32(seed);
  const routeType = STRANGE_ROUTES[Math.floor(rnd() * STRANGE_ROUTES.length)];
  const jctTick = 2 + Math.floor(rnd() * 5);
  const nameIdx = Math.floor(rnd() * STRANGE_NAMES.length);
  const trainId = STRANGE_NAMES[nameIdx].replace(/\s+/g, '-');
  const boxNumber = `S${seed}`;
  const id = `strange-${seed}`;
  const title = `Strange Working ${seed}`;
  const blurb = `${STRANGE_NAMES[nameIdx]} calls unannounced.`;
  switch (routeType) {
    case 'downMain': return downMainScenario(id, boxNumber, title, blurb, trainId, jctTick, jctTick + 5);
    case 'downLoop': return downLoopScenario(id, boxNumber, title, blurb, trainId, jctTick);
    case 'upMain': return upMainScenario(id, boxNumber, title, blurb, trainId, jctTick, jctTick + 5);
    default: return upRefugeScenario(id, boxNumber, title, blurb, trainId, jctTick);
  }
}

// ---------------------------------------------------------------------------
// SHARE TEXT
// ---------------------------------------------------------------------------
export function buildShareText({ boxNumber, movements, checks, flavor, url }) {
  const checkedPart = checks === 0 ? 'nobody checked' : `${checks} checked`;
  return `🚂 INTERLOCK box ${boxNumber} · ${movements} movements, ${checkedPart} · ${flavor} · ${url}`;
}
