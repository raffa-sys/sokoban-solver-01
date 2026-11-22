# sokoban-solver-01

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/raffa-sys/sokoban-solver-01/rank.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/raffa-sys/sokoban-solver-01/reward.svg)](https://make.fun/competitions/sokoban-solver-01-run-20261121)

**sokoban-solver-01** is a push-optimal Sokoban solver for make.fun's
sokoban-solver-01-run-20261121: `main.ts` answers all 5 instances of a set
in as few pushes as possible — the practice set and 8 freshly drawn sets all
score 1,000,000 (every instance in exactly its push-optimal count).

How it works:

- **Rooms, not the whole level.** Each level is a hallway with one to four
  rooms off it, and a box pushed out of a room can never come back, so the
  rooms are independent problems. The solver cuts the hallway's dead squares
  out of the floor, takes each remaining part holding boxes as a room, and
  solves the rooms one by one; the level's optimum is the sum of the rooms'.
- **A\* over pushes.** One push costs 1 and walking is free. The estimate
  is each box's walking distance to its nearest goal, summed — admissible,
  so the first solved state generated is push-optimal. States are named by
  their boxes and the player's reachable region.
- **Deadlock pruning.** Dead squares (a box there can never reach a goal)
  and frozen 2x2 blocks of walls and boxes are pruned; neither prunes a
  solvable state. At most 250,000 states per room, counted in work, never
  by the clock.
- **Deterministic.** No clock, no randomness: two runs write the same bytes.
  A whole set solves in under a second, far inside the 60-second budget.
