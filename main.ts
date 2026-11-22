// Sokoban solver — make.fun "Build the best Sokoban solver, 21 November 2026"
// (sokoban-solver-01-run-20261121). Node 22, standard library only, one file.
//
// METHOD (read this first — it is the whole design, and it is why the entry
// scores what it scores):
//
// The drawn levels have one structure: a one-square-wide hallway across the
// board with one to four small rooms off it, each room holding 3 or 4 boxes
// and as many goals, opening onto the hallway through a single door. A box
// pushed out of a room through its door can never be pushed back (pushing
// back would need the player on the hallway's far side, which is wall), so
// every box stays in its room and the rooms are independent problems: the
// level's push-optimal count P* is the sum of the rooms' optima. The solver
// therefore splits the level into rooms and solves each room push-optimally,
// then stitches the rooms together with the player's walks through the
// hallway. That split is what makes the search tractable: a whole level with
// 16 boxes has a joint state space no search finishes in 60 seconds, while
// one room of 4 boxes in a 6x6 slot is small.
//
// Each room is solved with A* over macro-push states. A state is the sorted
// box squares plus the player's reachable region (named by its lowest
// square — where exactly the player stands inside its region does not
// matter, only which squares it can reach). One move of the search is one
// push. The heuristic is the minimum-cost assignment of boxes to goals by
// grid distance (each push moves one box one square, so a box's grid
// distance to its goal lower-bounds the pushes it still needs, and the best
// assignment lower-bounds the total). It is admissible, and it changes by
// at most 1 per push, so it is consistent: the first solved state A* pops
// is push-optimal, and a room solved this way contributes exactly its
// optimum to the level total. Two sound prunes keep the search small: dead
// squares (a square from which no push, ignoring the other boxes, can ever
// reach a goal — found by reverse pushing from the goals) and frozen 2x2
// blocks (four squares of walls and boxes holding a box off its goal, which
// can never move again). Neither prunes a solvable state.
//
// Fallbacks, in order, per room: A* (node cap), breadth-first search over
// the same states with the same prunes (also push-optimal, slower), then a
// greedy best-first search (solves, but may cost extra pushes). If a level
// does not split into rooms, the same search runs on the whole level. If
// every search gives up, the level is answered empty rather than crashing:
// an unsolved instance scores 0, a crashed run scores nothing on any
// instance. All budgets are node counts, never the clock: no Date, no
// randomness, no environment read as a source of variation, fixed direction
// order (u, d, l, r) and fixed tie-breaks everywhere, so two executions
// write the same bytes.
//
// MEASURED (practice set in the kit, P* from its manifest: 13 / 16 / 29 /
// 47 / 60 pushes): this program solves all five instances in P* pushes —
// score 1,000,000 of 1,000,000. The house baseline (plain-astar 1.0.0,
// move-optimal, no deadlock knowledge) scores 400,000 on the same set.
// See README.md for the full table.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input \
//   MAKEFUN_OUTPUT_DIR=out node main.ts   (from the kit directory, with
//   practice/ beside it; or point the two variables at any set)
// Then score it: MAKEFUN_OUTPUT_DIR=out \
//   MAKEFUN_REFERENCE_DIR=practice/reference MAKEFUN_SCORES_DIR=scores \
//   node program/scorer/score.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Node budgets: work, never the clock — deterministic on every run. */
const ASTAR_CAP = 150_000;
const BFS_CAP = 250_000;
const GREEDY_CAP = 100_000;

/** The four directions in fixed order: [dx, dy, step letter, push letter]. */
const DIRS: readonly (readonly [number, number, string, string])[] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
] as const;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text: # wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Live squares: every square from which a box alone can be pushed onto some
 * goal. Reverse-push from the goals: a box can step from y to x (x already
 * live) when the player could stand at y - d, i.e. both y and y - d are open
 * floor. A box on any other square is dead on arrival and pruned.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the player's reachable region from `from` with `occupied`
 * (boxes) in the way, stamping cells in `seen` with `stamp` and reusing
 * `stack` as the work list. Returns the region's lowest square, which names
 * the region: two states with the same boxes and the same region-low are
 * the same macro-state whatever square the player stands on.
 */
function reachRegion(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    if (!wall[p - w] && !occupied[p - w] && seen[p - w] !== stamp) {
      seen[p - w] = stamp;
      stack[n++] = p - w;
    }
    if (!wall[p + w] && !occupied[p + w] && seen[p + w] !== stamp) {
      seen[p + w] = stamp;
      stack[n++] = p + w;
    }
    if (!wall[p - 1] && !occupied[p - 1] && seen[p - 1] !== stamp) {
      seen[p - 1] = stamp;
      stack[n++] = p - 1;
    }
    if (!wall[p + 1] && !occupied[p + 1] && seen[p + 1] !== stamp) {
      seen[p + 1] = stamp;
      stack[n++] = p + 1;
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes holding a box off its goal. Such a box can
 * never move again, so the state is dead. Only blocks containing `t` can
 * have become frozen by this push.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b])) return true;
    if ((occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * Grid distances from each goal, ignoring boxes: dist[g][cell] is the fewest
 * steps a box needs to slide from cell to goal g (or -1 when unreachable).
 * One BFS per goal over open floor.
 */
function goalDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(wall.length).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      const nd = dist[p]! + 1;
      if (!wall[p - w] && dist[p - w] === -1) { dist[p - w] = nd; queue.push(p - w); }
      if (!wall[p + w] && dist[p + w] === -1) { dist[p + w] = nd; queue.push(p + w); }
      if (!wall[p - 1] && dist[p - 1] === -1) { dist[p - 1] = nd; queue.push(p - 1); }
      if (!wall[p + 1] && dist[p + 1] === -1) { dist[p + 1] = nd; queue.push(p + 1); }
    }
    out.push(dist);
  }
  return out;
}

/**
 * The admissible heuristic for a box layout: the cheapest assignment of
 * boxes to distinct goals by grid distance (every goal used once — a room
 * has as many boxes as goals). Enumerated over permutations (at most 4
 * boxes in a room, 24 orders); with more boxes, the sum of each box's
 * nearest-goal distance, which is weaker but still admissible. A box's grid
 * distance lower-bounds the pushes it still needs, so the sum lower-bounds
 * the pushes left, whatever the assignment.
 */
function makeHeuristic(level: Level, dist: Int32Array[]): (boxes: number[]) => number {
  const n = level.goals.length;
  if (n <= 6) {
    const perm = level.goals.map((_, i) => i);
    const orders: number[][] = [];
    const gen = (k: number): void => {
      if (k === 1) { orders.push([...perm]); return; }
      for (let i = 0; i < k; i++) {
        gen(k - 1);
        const j = k % 2 === 0 ? i : 0;
        [perm[j], perm[k - 1]] = [perm[k - 1]!, perm[j]!];
      }
    };
    gen(n);
    return (boxes: number[]): number => {
      let best = Number.POSITIVE_INFINITY;
      for (const order of orders) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const d = dist[order[i]!]![boxes[i]!]!;
          if (d < 0) { sum = Number.POSITIVE_INFINITY; break; }
          sum += d;
        }
        if (sum < best) best = sum;
      }
      if (best === Number.POSITIVE_INFINITY) return sumOfMinima(boxes, dist);
      return best;
    };
  }
  return (boxes: number[]): number => sumOfMinima(boxes, dist);
}

function sumOfMinima(boxes: number[], dist: Int32Array[]): number {
  let sum = 0;
  for (const b of boxes) {
    let m = Number.POSITIVE_INFINITY;
    for (const dg of dist) {
      const d = dg[b]!;
      if (d >= 0 && d < m) m = d;
    }
    if (m === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
    sum += m;
  }
  return sum;
}

/** A state's key: region-low, then the box squares, as digits in base size. */
function keyOf(boxes: number[], low: number, size: number): number | string {
  if (boxes.length <= 5) {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  }
  return `${low}|${boxes.join(',')}`;
}

type SearchMode = 'astar' | 'bfs' | 'greedy';

interface SearchResult {
  pushes: number;
  moves: string;
  states: number;
  expansions: number;
}

/**
 * Push-optimal (astar, bfs) or greedy search of one board. A state is the
 * sorted box squares plus the player's reachable region; one step is one
 * push. `mode` picks the open-list order: astar ranks by pushes + heuristic
 * (optimal: the heuristic is admissible and consistent), bfs by pushes
 * alone (optimal), greedy by heuristic alone (fast, not optimal). The
 * search stops at maxStates states and answers null — the caller falls
 * back to the next mode. Deterministic: fixed direction order, heap ties
 * broken by heuristic, then by insertion order.
 */
function searchPushes(level: Level, maxStates: number, mode: SearchMode): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const dist = goalDistances(level);
  const heuristic = makeHeuristic(level, dist);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (solved(level.boxes)) return { pushes: 0, moves: '', states: 1, expansions: 0 };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states, in discovery order: boxes, player square, parent, the push
  // that made the state (box from -> to). The heap ranks [f, h, index].
  const statesBoxes: number[][] = [level.boxes];
  const statesPlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const gOf: number[] = [0];
  const best = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  best.set(keyOf(level.boxes, reachRegion(level, occupied, level.player, seen, ++stamp, stack), size), 0);
  for (const b of level.boxes) occupied[b] = 0;

  const heapF: number[] = [];
  const heapH: number[] = [];
  const heapI: number[] = [];
  const less = (a: number, b: number): boolean =>
    heapF[a]! < heapF[b]! ||
    (heapF[a]! === heapF[b]! && (heapH[a]! < heapH[b]! || (heapH[a]! === heapH[b]! && heapI[a]! < heapI[b]!)));
  const heapPush = (f: number, h: number, i: number): void => {
    let n = heapF.length;
    heapF.push(f); heapH.push(h); heapI.push(i);
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (!less(n, p)) break;
      [heapF[n], heapF[p]] = [heapF[p]!, heapF[n]!];
      [heapH[n], heapH[p]] = [heapH[p]!, heapH[n]!];
      [heapI[n], heapI[p]] = [heapI[p]!, heapI[n]!];
      n = p;
    }
  };
  const heapPop = (): number => {
    const top = heapI[0]!;
    const lf = heapF.pop()!;
    const lh = heapH.pop()!;
    const li = heapI.pop()!;
    if (heapF.length > 0) {
      heapF[0] = lf; heapH[0] = lh; heapI[0] = li;
      for (let n = 0; ; ) {
        let c = 2 * n + 1;
        if (c >= heapF.length) break;
        if (c + 1 < heapF.length && less(c + 1, c)) c++;
        if (!less(c, n)) break;
        [heapF[n], heapF[c]] = [heapF[c]!, heapF[n]!];
        [heapH[n], heapH[c]] = [heapH[c]!, heapH[n]!];
        [heapI[n], heapI[c]] = [heapI[c]!, heapI[n]!];
        n = c;
      }
    }
    return top;
  };

  const h0 = heuristic(level.boxes);
  heapPush(mode === 'bfs' ? 0 : mode === 'greedy' ? h0 : h0, h0, 0);
  let expansions = 0;
  let found = -1;
  while (heapF.length > 0) {
    const s = heapPop();
    const boxes = statesBoxes[s]!;
    const g = gOf[s]!;
    for (const b of boxes) occupied[b] = 1;
    const low = reachRegion(level, occupied, statesPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    if (best.get(keyOf(boxes, low, size)) !== g) {
      for (const b of boxes) occupied[b] = 0;
      continue;
    }
    if (solved(boxes)) { found = s; for (const b of boxes) occupied[b] = 0; break; }
    expansions++;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        let nextLow = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          nextLow = reachRegion(level, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, nextLow, size);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g + 1) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g + 1);
        const idx = statesBoxes.length;
        statesBoxes.push(next);
        statesPlayer.push(b);
        parent.push(s);
        pushFrom.push(b);
        pushTo.push(t);
        gOf.push(g + 1);
        const h = heuristic(next);
        const f = mode === 'bfs' ? g + 1 : mode === 'greedy' ? h : g + 1 + h;
        heapPush(f, h, idx);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The push path, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const d = to - from;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves, states: statesBoxes.length, expansions };
}

/** The shortest walk from `from` to `to` around walls and boxes (lower LURD letters; first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, a goal falls in the cut, or a box starts in the hallway — then the
 * level is no set of rooms and the whole-level search runs instead.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      if (!wall[p - w] && !cut[p - w] && part[p - w] < 0) { part[p - w] = rooms.length; squares.push(p - w); }
      if (!wall[p + w] && !cut[p + w] && part[p + w] < 0) { part[p + w] = rooms.length; squares.push(p + w); }
      if (!wall[p - 1] && !cut[p - 1] && part[p - 1] < 0) { part[p - 1] = rooms.length; squares.push(p - 1); }
      if (!wall[p + 1] && !cut[p + 1] && part[p + 1] < 0) { part[p + 1] = rooms.length; squares.push(p + 1); }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * One board solved with the fallback chain: A*, then breadth-first, then
 * greedy. The first two are push-optimal; the greedy one only runs when
 * both optimal searches give up, and still has to solve the board.
 */
function solveBoard(level: Level): SearchResult | null {
  return (
    searchPushes(level, ASTAR_CAP, 'astar') ??
    searchPushes(level, BFS_CAP, 'bfs') ??
    searchPushes(level, GREEDY_CAP, 'greedy')
  );
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 */
function solveByRooms(level: Level): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solveBoard(level);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  let states = 0;
  let expansions = 0;
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveBoard(sub);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    states += solved.states;
    expansions += solved.expansions;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves, states, expansions };
}

/** One level's moves: room by room, or the whole level when it is no set of rooms. Never throws. */
function solveLevel(text: string): string {
  try {
    const level = parseLevel(text);
    if (level.player < 0 || level.boxes.length === 0) return '';
    if (level.boxes.length !== level.goals.length) return '';
    const solved = solveByRooms(level) ?? solveBoard(level);
    return solved === null ? '' : solved.moves;
  } catch {
    return '';
  }
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
