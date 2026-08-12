// INTERLOCK headless tests. Run: node test.mjs — exit 0 = green.
import * as F from './frame.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.log('FAIL:', name);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const table = F.buildTable();

// ---------------------------------------------------------------------------
// 1. mulberry32 determinism
// ---------------------------------------------------------------------------
{
  const a = F.mulberry32(12345);
  const b = F.mulberry32(12345);
  const seqA = [a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b()];
  check('mulberry32: same seed produces identical sequence', deepEqual(seqA, seqB));
  const c = F.mulberry32(999);
  check('mulberry32: different seeds diverge', c() !== F.mulberry32(12345)());
}

// ---------------------------------------------------------------------------
// 2. interlocking table symmetric-consistent — no deadlock states reachable from start
// ---------------------------------------------------------------------------
{
  const r = F.allStatesCanReturnToStart(table);
  check('reachability: every state reachable from start can return to start (no deadlock)', r.ok);
  check('reachability: state space is non-trivial (>1 state)', r.totalStates > 1);
  check('reachability: reachable-to-start count equals total reachable states', r.reachable === r.totalStates);
}

// ---------------------------------------------------------------------------
// 3. illegal pulls always blocked with a cited rule
// ---------------------------------------------------------------------------
{
  const s0 = F.createInitialState(table);

  const r1 = F.canMove(table, s0, 'L12', 'R');
  check('illegal: L12 (Up Starting) before L7 (Up Home) is blocked', !r1.ok && /Up Home/.test(r1.rule));

  const r2 = F.canMove(table, s0, 'L1', 'R');
  check('illegal: L1 (Down Distant) before L2 (Down Home) is blocked', !r2.ok && /Down Home/.test(r2.rule));

  let s = F.pull(table, s0, 'L3', 'R').state; // set loop points reverse
  s = F.pull(table, s, 'L4', 'R').state; // lock the FPL
  const r3 = F.canMove(table, s, 'L3', 'N');
  check('illegal: points cannot move while their F.P.L. is locked', !r3.ok && /Down Loop F\.P\.L\./.test(r3.rule));

  s = F.setTrackCircuit(s, F.TC.DOWN_JCT, 'occupied');
  const r4 = F.canMove(table, s, 'L4', 'N');
  check('illegal: F.P.L. cannot release while its track circuit is occupied', !r4.ok && /track circuit/.test(r4.rule));

  // The interlock provably prevents ever legally reaching "L6's own requires satisfied
  // AND L5 reversed" (L5 requires L3=N, which the reverse-lock keeps L3 pinned to while
  // L5 is reversed) — so to isolate the conflicts-check itself, construct that state
  // directly rather than via pull(). canMove is a pure function of table+state and this
  // is a legitimate probe of its conflict-resolution order.
  let s2 = F.createInitialState(table);
  s2 = { levers: { ...s2.levers, L3: 'R', L4: 'R', L5: 'R' }, trackCircuits: { ...s2.trackCircuits } };
  const r5 = F.canMove(table, s2, 'L6', 'R'); // loop exit conflicts with main
  check('illegal: conflicting road (L6) blocked while L5 is reversed', !r5.ok && /Down Section/.test(r5.rule));

  const r6 = F.canMove(table, s2, 'L4', 'N');
  check('illegal: F.P.L. locked by a reversed dependent signal cannot normalize', !r6.ok && /Down Section/.test(r6.rule));

  const r7 = F.canMove(table, s0, 'L2', 'N');
  check('re-normalizing an already-normal lever is blocked with a cited reason', !r7.ok && r7.rule.length > 0);
}

// ---------------------------------------------------------------------------
// 4. each authored scenario solvable by solver within move budget
// ---------------------------------------------------------------------------
{
  const scenarios = F.buildScenarios();
  check('scenarios: exactly 15 authored timetable scenarios', scenarios.length === 15);
  let allSolved = true;
  let allPerfect = true;
  let allWithinBudget = true;
  const seenBoxNumbers = new Set();
  for (const sc of scenarios) {
    seenBoxNumbers.add(sc.boxNumber);
    const sol = F.autoSolve(table, sc, 40);
    if (!sol.ok) { allSolved = false; continue; }
    if (sol.actions.length > 40) allWithinBudget = false;
    const res = F.runScenario(table, sc, sol.actions);
    if (!res.perfect) allPerfect = false;
  }
  check('scenarios: every authored scenario is solvable by the solver', allSolved);
  check('scenarios: every solution fits within the 40-move budget', allWithinBudget);
  check('scenarios: every solved scenario runs with zero signal checks (perfect)', allPerfect);
  check('scenarios: box numbers are unique across the 15 workings', seenBoxNumbers.size === 15);
}

// ---------------------------------------------------------------------------
// 5. the flagship "8:40 Fast" overtake — the milk train really is held, the
//    fast really does run through untouched, the milk exits only afterward
// ---------------------------------------------------------------------------
{
  const scenarios = F.buildScenarios();
  const fastBox = scenarios.find((s) => s.id === 'box-4');
  const sol = F.autoSolve(table, fastBox, 40);
  check('overtake: box-4 solver succeeds', sol.ok);
  const res = F.runScenario(table, fastBox, sol.actions);
  check('overtake: the fast and the milk train both complete with zero checks', res.perfect);
  const l6Action = sol.actions.find((a) => a.lever === 'L6' && a.pos === 'R');
  const l5Action = sol.actions.find((a) => a.lever === 'L5' && a.pos === 'R');
  check('overtake: the milk train is only released (L6) after the fast has cleared (L5)', l6Action && l5Action && l6Action.tick > l5Action.tick);
}

// ---------------------------------------------------------------------------
// 6. collisions impossible whenever signals obeyed — fuzz 1000 random legal
//    sequences, assert invariants hold and no conflicting proceed aspects ever occur
// ---------------------------------------------------------------------------
{
  const rnd = F.mulberry32(42);
  let s = F.createInitialState(table);
  let applied = 0;
  let tries = 0;
  let invariantBroken = false;
  let conflictSeen = false;
  while (applied < 1000 && tries < 50000) {
    tries++;
    const id = F.LEVER_IDS[Math.floor(rnd() * F.LEVER_IDS.length)];
    const pos = rnd() < 0.5 ? 'N' : 'R';
    const res = F.pull(table, s, id, pos);
    if (res.ok) {
      s = res.state;
      applied++;
      const inv = F.invariantsHold(table, s);
      if (!inv.ok) invariantBroken = true;
      if (s.levers.L5 === 'R' && s.levers.L6 === 'R') conflictSeen = true;
      if (s.levers.L11 === 'R' && s.levers.L12 === 'R') conflictSeen = true;
    }
  }
  check('fuzz: reached 1000 applied legal moves within try budget', applied === 1000);
  check('fuzz: invariants hold after every legal move over 1000 moves', !invariantBroken);
  check('fuzz: zero conflicting proceed aspects (L5/L6, L11/L12) across 1000 legal moves', !conflictSeen);
}

// ---------------------------------------------------------------------------
// 7. punctuality scorer — every verdict path
// ---------------------------------------------------------------------------
{
  const perfect = F.scorePunctuality(0, 0, 1);
  check('scorer: zero checks yields perfect + 3 stars', perfect.perfect === true && perfect.stars === 3 && perfect.score === 100);

  const oneCheck = F.scorePunctuality(1, 0, 1);
  check('scorer: one check yields not-perfect, score 80, 2 stars', oneCheck.perfect === false && oneCheck.score === 80 && oneCheck.stars === 2);

  const twoChecks = F.scorePunctuality(2, 2, 1);
  check('scorer: two checks + delay drops into the 1-star band', twoChecks.stars === 1 && twoChecks.score === 54);

  const badRun = F.scorePunctuality(5, 10, 1);
  check('scorer: heavy checks/delay floors at score 0, 0 stars', badRun.score === 0 && badRun.stars === 0);
}

// ---------------------------------------------------------------------------
// 8. determinism of runScenario given the same table/scenario/actionLog
// ---------------------------------------------------------------------------
{
  const scenarios = F.buildScenarios();
  const sc = scenarios[0];
  const sol = F.autoSolve(table, sc, 40);
  const r1 = F.runScenario(table, sc, sol.actions);
  const r2 = F.runScenario(table, sc, sol.actions);
  check('determinism: runScenario is deterministic given identical inputs', deepEqual(r1.state, r2.state) && r1.checks.length === r2.checks.length && r1.score === r2.score);
}

// ---------------------------------------------------------------------------
// 9. strange-working generator — determinism + solvability over 100 seeds
// ---------------------------------------------------------------------------
{
  let deterministic = true;
  let allSolvable = true;
  let allPerfect = true;
  for (let seed = 0; seed < 100; seed++) {
    const a = F.generateStrangeWorking(seed);
    const b = F.generateStrangeWorking(seed);
    if (!deepEqual(a, b)) deterministic = false;
    const sol = F.autoSolve(table, a, 40);
    if (!sol.ok) { allSolvable = false; continue; }
    const res = F.runScenario(table, a, sol.actions);
    if (!res.perfect) allPerfect = false;
  }
  check('strange workings: same seed reproduces an identical scenario (100 seeds)', deterministic);
  check('strange workings: every generated scenario is solvable (100 seeds)', allSolvable);
  check('strange workings: every generated scenario solves with zero checks (100 seeds)', allPerfect);
}

// ---------------------------------------------------------------------------
// 10. share text format
// ---------------------------------------------------------------------------
{
  const t1 = F.buildShareText({ boxNumber: 6, movements: 14, checks: 0, flavor: 'the milk train forgave me', url: 'http://interlock.defimagic.io' });
  check('share text: zero-check phrasing matches spec', t1 === '🚂 INTERLOCK box 6 · 14 movements, nobody checked · the milk train forgave me · http://interlock.defimagic.io');

  const t2 = F.buildShareText({ boxNumber: 4, movements: 15, checks: 2, flavor: 'the fast waited on the fog', url: 'http://interlock.defimagic.io' });
  check('share text: checked-count phrasing pluralizes correctly', t2 === '🚂 INTERLOCK box 4 · 15 movements, 2 checked · the fast waited on the fog · http://interlock.defimagic.io');
}

// ---------------------------------------------------------------------------
// 11. track circuit occupancy blocks point/FPL movement, both directions
// ---------------------------------------------------------------------------
{
  let s = F.createInitialState(table);
  s = F.setTrackCircuit(s, F.TC.UP_JCT, 'occupied');
  const rN = F.canMove(table, s, 'L9', 'R');
  check('track circuit: points cannot move onto an occupied circuit (N->R)', !rN.ok);
  s = F.setTrackCircuit(s, F.TC.UP_JCT, 'clear');
  const rOk = F.canMove(table, s, 'L9', 'R');
  check('track circuit: points move freely once the circuit clears', rOk.ok);
}

// ---------------------------------------------------------------------------
// 12. pull() is a pure function — does not mutate the input state
// ---------------------------------------------------------------------------
{
  const s0 = F.createInitialState(table);
  const before = JSON.stringify(s0);
  F.pull(table, s0, 'L7', 'R');
  check('purity: pull() does not mutate its input state', JSON.stringify(s0) === before);
}

// ---------------------------------------------------------------------------
// 13. bfsWithEdges: every non-start reachable state has at least one outgoing edge
// ---------------------------------------------------------------------------
{
  const { nodes, edges } = F.bfsWithEdges(table);
  const outdegree = new Map();
  for (const [from] of edges) outdegree.set(from, (outdegree.get(from) || 0) + 1);
  let allHaveExit = true;
  for (const key of nodes.keys()) {
    if (!outdegree.has(key)) allHaveExit = false;
  }
  check('reachability: no state is a total dead end (every state has an outgoing legal move)', allHaveExit);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures.join('; '));
  process.exit(1);
}
process.exit(0);
