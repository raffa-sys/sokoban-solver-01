// SPDX-License-Identifier: MIT
// Sokoban solver: push-optimal A* per room, rooms found by cutting the
// hallway's dead squares out of the floor. A level is a hallway with one to
// four rooms off it; a box pushed out of a room can never come back, so the
// rooms are independent and the level's optimum is the sum of the rooms'.
// Each room is solved by A* over pushes (one push costs 1, walking is free),
// with an admissible estimate (each box's distance to its nearest goal,
// summed), dead-square pruning and frozen 2x2 pruning, states named by their
// boxes and the player's reachable region. No clock, no randomness: two runs
// write the same bytes. Falls back to a whole-level A* when a level is no
// set of rooms, and to an empty answer when even that gives up.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// The most states one room search keeps before it gives up: work, never the clock.
const MAX_STATES = 250_000;
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Room = { squares: number[]; boxes: number[]; goals: number[]; done: boolean };

/** A level in XSB text: width, walls, goals, boxes, player. Short rows pad as walls; the frame is a wall. */
function parseLevel(text: string): Board {
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

/** The squares from which a box alone can be pushed onto some goal, pulled back from the goals over open floor. */
function liveSquares(b: Board): Uint8Array {
  const { w, wall, goals } = b;
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
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor; each part left holding boxes is
 * a room. Null when a box starts in the hallway, a goal is cut off, or some
 * part holds more or fewer boxes than goals.
 */
function roomsOf(b: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = b;
  const live = liveSquares(b);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const x of boxes) rooms[part[x]!]!.boxes.push(x);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The shortest walk from `from` to `to` around walls and boxes, lower LURD letters (first direction first on ties). */
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = b;
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

/** The square the player stands on after `moves` (case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal solution of a board, A* over pushes, searching at most
 * `maxStates` states: {pushes, moves} (lower LURD letters; the replay, not
 * the case, decides which steps push), or null when the search gives up (or
 * the board has no solution). A state is the boxes' squares and the player's
 * reachable region (named by its lowest square); the first solved state the
 * search generates is push-optimal, because a goal's parent is expanded in
 * non-decreasing f order and a goal's parent has f equal to the goal's push
 * count. Two deadlocks are pruned, neither of which prunes a solvable state:
 * a dead square, and a frozen 2x2 block of walls and boxes with a box off
 * its goal.
 */
function solvePushOptimal(b: Board, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = b;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(b);
  if (b.boxes.some((x) => !live[x])) return null;
  // Each square's walking distance to its nearest goal, over open floor alone.
  const dist = new Int32Array(size).fill(-1);
  const dq = [...goals];
  for (const g of goals) dist[g] = 0;
  for (let qi = 0; qi < dq.length; qi++) {
    const p = dq[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        dq.push(q);
      }
    }
  }
  const estimate = (bs: number[]): number => {
    let s = 0;
    for (const x of bs) {
      const d = dist[x]!;
      if (d < 0) return Infinity;
      s += d;
    }
    return s;
  };
  const solved = (bs: number[]): boolean => bs.every((x) => goal[x]);
  // Region flood fill with stamps; `stack` is shared, calls never nest.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  const occupied = new Uint8Array(size);
  const regionLow = (from: number, stamp: number, arr: Int32Array): number => {
    let low = from;
    let n = 0;
    stack[n++] = from;
    arr[from] = stamp;
    while (n > 0) {
      const p = stack[--n]!;
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
        if (wall[q] === 0 && occupied[q] === 0 && arr[q] !== stamp) {
          arr[q] = stamp;
          stack[n++] = q;
        }
      }
    }
    return low;
  };
  const keyOf = (bs: number[], low: number): number => {
    let k = low;
    for (const x of bs) k = k * size + x;
    return k;
  };
  const frozenBlock = (t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const c2 = a + 1;
      const c3 = a + w;
      const c4 = c3 + 1;
      if (!(wall[a] || occupied[a]) || !(wall[c2] || occupied[c2])) continue;
      if (!(wall[c3] || occupied[c3]) || !(wall[c4] || occupied[c4])) continue;
      if ((occupied[a] && !goal[a]) || (occupied[c2] && !goal[c2])) return true;
      if ((occupied[c3] && !goal[c3]) || (occupied[c4] && !goal[c4])) return true;
    }
    return false;
  };
  // The states in the order found: boxes, the player's square after the push
  // that made them, pushes so far, parent, the push that made them, and key.
  const sBoxes: number[][] = [b.boxes];
  const sPlayer: number[] = [b.player];
  const sG: number[] = [0];
  const sKey: number[] = [];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const best = new Map<number, number>();
  let stamp = 0;
  for (const x of b.boxes) occupied[x] = 1;
  const startLow = regionLow(b.player, ++stamp, seen);
  for (const x of b.boxes) occupied[x] = 0;
  const startKey = keyOf(b.boxes, startLow);
  sKey.push(startKey);
  best.set(startKey, 0);
  // A binary heap on [f, sequence, state]: f first, then the older entry.
  const heap: [number, number, number][] = [];
  let seq = 0;
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      const a = heap[i]!;
      const c = heap[p]!;
      if (a[0] > c[0] || (a[0] === c[0] && a[1] >= c[1])) break;
      heap[i] = c;
      heap[p] = a;
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length) {
          const l = heap[c]!;
          const r = heap[c + 1]!;
          if (r[0] < l[0] || (r[0] === l[0] && r[1] < l[1])) c++;
        }
        const a = heap[i]!;
        const d = heap[c]!;
        if (d[0] > a[0] || (d[0] === a[0] && d[1] >= a[1])) break;
        heap[i] = d;
        heap[c] = a;
        i = c;
      }
    }
    return top;
  };
  heapPush([estimate(b.boxes), seq++, 0]);
  let found = solved(b.boxes) ? 0 : -1;
  while (heap.length > 0 && found < 0) {
    const [, , s] = heapPop();
    if (best.get(sKey[s]!) !== s) continue;
    const boxes = sBoxes[s]!;
    const player = sPlayer[s]!;
    for (const x of boxes) occupied[x] = 1;
    const here = ++stamp;
    regionLow(player, here, seen);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = box + d;
        if (seen[box - d] !== here) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[box] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(t);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b) => a - b);
          key = keyOf(next, regionLow(box, ++stamp, mark));
        }
        occupied[t] = 0;
        occupied[box] = 1;
        if (frozen || next === null) continue;
        const g2 = sG[s]! + 1;
        const prev = best.get(key);
        if (prev !== undefined && sG[prev]! <= g2) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        const ni = sBoxes.length;
        best.set(key, ni);
        sBoxes.push(next);
        sPlayer.push(box);
        sG.push(g2);
        sKey.push(key);
        parent.push(s);
        pushFrom.push(box);
        pushTo.push(t);
        if (solved(next)) {
          found = ni;
          break;
        }
        heapPush([g2 + estimate(next), seq++, ni]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes;
  for (const s of path) {
    const nextBoxes = sBoxes[s]!;
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const x of boxes) occupied[x] = 1;
    moves += walkTo(b, occupied, player, from - d);
    for (const x of boxes) occupied[x] = 0;
    moves += dir[2];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** A level's moves: room by room, each room's push-optimal solution in turn. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) {
    const r = solvePushOptimal(level, MAX_STATES);
    return r ? r.moves : '';
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const x of other.done ? other.goals : other.boxes) wall[x] = 1;
    }
    const sub: Board = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const r = solvePushOptimal(sub, MAX_STATES);
    if (r === null) return '';
    moves += r.moves;
    player = endOf(level.w, player, r.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
