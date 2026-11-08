# Design: dexel material model

Status: proposed, waiting for owner approval. Requirement: CLAUDE.md "Accuracy requirement".

## 1. Data structure
Single-direction Z dexels (van Hook, "Real-time shaded NC milling display", SIGGRAPH 1986). A 3-axis
tool axis is always vertical, so every undercut is a gap along Z and a Z dexel stores it exactly.
Tri-dexel (Müller, Surmann, Stautner) only improves walls below the XY cell size, at 3x memory and work.

`src/engine/dexelStock.ts` extends `HeightGrid`:
- `heights: Float32Array(nx*ny)` stays the topmost material Z; all current consumers keep working.
- Undercuts are stored as air gaps below `top` (in 3-axis the lowest material always sits on the stock
  bottom unless the column is cut through).
- Gaps per 128x128 tile, allocated on the first gap: per column an Int32 offset and a Uint16 count; a
  shared Float32 pool of (lo, hi) pairs with capacity doubling and a free list per size class.
- Intervals merge only when they touch or overlap exactly; no snapping constant.

Memory (fixture): thread grooves about 200k gaps = 1.6 MB pool, about 1 MB index; total about 27 MB.
Checkpoints: today's dirty-rectangle snapshots of `heights` plus a sparse record of gap columns, under
2 MB per thread-toolpath checkpoint.

## 2. Tool model (`toolShape.ts`)
A tool is a solid of revolution with profile r(h) from the tip upwards: lines and circular arcs, split
into cutting part (to flute length), neck (non-cutting cylinder) and shank. The profile is split at
each local minimum of r into bands where r is unimodal, so {h : r(h) >= d} is one interval
[a(d), b(d)] with a convex non-decreasing and b concave non-increasing.

Tool table inputs (header fields map as today; the rest editable and labelled assumed):
- Flat, bull nose, ball: diameter, corner radius.
- Drill, V-bit: diameter, tip angle (drill 118, V-bit 90 assumed), tip diameter.
- Thread mill: cutting diameter, pitch (user entry, no default; until entered simulated as a cylinder
  with a tool problem shown), profile angle 60 deg, teeth 1, tooth tip flat P/8, neck diameter
  (cutting diameter minus 2 x 5/8 H), tip-to-tooth offset; ISO 68-1 values, assumed.
- Dovetail: large diameter, angle, cutting height, neck diameter.
- T-slot / keyseat: diameter, cutting width, corner radius, neck diameter.
- Lollipop: ball diameter, neck diameter.
- All: shank diameter, shoulder length, flute length.

## 3. Sweep (`sweep.ts`)
Exact per-column swept-volume intervals: per column and band the tool occupies
[min_t (z+a(d(t))), max_t (z+b(d(t)))] over the connected t-range where d(t) <= r_max. Horizontal moves
and flat elements: closed form. Line elements (cone, flanks, dovetail): one quadratic per element.
Arcs on ramps: golden-section search (unimodal). The column's material intervals minus these.
Fast path: band top above the column top and no gaps gives today's min(top, lower).
Neck and shank do not cut; material they meet is the non-cutting contact finding.
Accuracy: Z exact to Float32; XY point-sampled at column centres.
Cost gate: fixture simulation time at most today's plus about 1 to 2 s for the thread mill.

## 4. Model and comparison
Model dexels: scanline traversal collecting every crossing Z per column, sorted and paired even-odd;
shared edges once by the top-left fill rule. Odd counts are reported as a mesh problem, never patched.
Expected solid E: the parts; outside outlines everything below the stock bottom; in through-holes
everything below the part bottom. Tolerance zone (ISO 1101, L-infinity): gouge = (E eroded by a cube of
half-size tol_g) minus S; leftover = S minus (E dilated by tol_l). Separable: sliding union over the XY
window, then widen in Z. Single-interval columns reduce to today's comparison.
Threads: gouge components labelled on dexels (8-neighbour, overlapping Z); a helical groove is one
component per hole; rows for measured pitch and major diameter.
One source: the worker computes eroded and dilated E once per compare; findings, colours and the
missing-material solid all read it.

## 5. Rendering
Hybrid: `stockSurface.ts` keeps the top surface. Heightfield wall fragments are discarded where Z lies
in a gap of the higher column (gap textures read only in tiles with gaps). New
`src/viewer/undercutMesh.ts`: blocky boundary of the dexels (gap ceilings and floors, side quads from
neighbouring columns), one mesh per 128 tile, rebuilt only for dirty tiles, per-face deviation class from
the worker. Fixture: about 1.6M triangles. Without undercuts the path and speed are unchanged.
Rejected: marching cubes / dual contouring (quantise Z), shader ray marching (cost and fragility),
instanced boxes (6M instances).

## 6. Migration (app and tests green after each step)
0. Refuse rotary-axis files at the parser boundary: A, B or C words on a motion line, or a rotary setup
   in the Makera header, reject the load with a clear message (added by the parent session).
1. Profile tool model and bands; height-grid results bit-identical.
2. `DexelStock` with tests (interval subtraction, pool growth, checkpoints).
3. Dexel sweep and simulation on `DexelStock`; synthetic tests (T-slot gap, single-tooth helix groove
   every P, lollipop); fixture timing gate.
4. Model dexels and interval deviation.
5. Findings on dexel components and non-cutting contact.
6. Renderer: wall discard and undercut mesh; frame timing before/after; browser check of threads.
7. Tools tab fields for the new types; missing-material view from gouge intervals.

## 7. Open questions (recommendation first)
- Q1 Neck and shank: do not cut, only report contact.
- Q2 T6 data: ISO 68-1 assumed values, pitch required as user entry; owner may supply the data sheet.
- Q3 Concave form cutters (corner rounding): out of scope until needed.
- Q4 Tri-dexel: no.
- Q5 Section plane to look into threads: yes, small later step.

## 8. Effort
About 24 agent-hours: steps 1 to 7 = 2, 3, 5, 4, 3, 5, 2.
