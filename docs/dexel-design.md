# Design: dexel material model

Status: approved in principle by the owner 2026-11-09. Requirement: CLAUDE.md "Accuracy requirement".

Owner answers 2026-11-09:
- Scope now: threads. Build the general profile core, but only the thread mill gets its full profile in
  the tool table now; dovetail, T-slot, keyseat and lollipop tool types come later.
- Thread mill data is entered by the user in the tool table: ISO 68-1 values prefilled and labelled
  assumed, pitch required.
- Neck and shank do not cut; material touching them is the non-cutting contact finding (Q1 as
  recommended). Q3, Q4 as recommended.
- Rotary refusal: only A, B or C words on a motion line. `STOCK id=cylinder` is NOT refused (a round
  blank can be milled 3-axis); round stock is simulated as its bounding box until round stock support
  is added later.

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

## 5. Rendering (accuracy first, speed second)
Exact boundary extraction of the dexel model, drawn as triangles (van Hook 1986; Stautner and Müller):
every interval end is a horizontal face at its exact Z, every column side where neighbouring interval
sets differ is a vertical face. No Z quantisation, no smoothing.
- Top surface: `stockSurface.ts` stays; wall fragments inside a gap of the higher column are discarded.
- New `src/viewer/undercutMesh.ts`: per gap a ceiling quad at `hi` and a floor quad at `lo`, side quads
  from the symmetric difference of neighbouring interval sets; one mesh per 128 tile, rebuilt only for
  dirty tiles; faces coloured from the same eroded/dilated model intervals the findings use.
- Level of detail: tiles holding gaps are always drawn at full resolution; tiles without gaps keep
  today's sub-pixel screen-space error rule (depth of every cell stays exact up close); the undercut
  mesh is never decimated.
- Clipping plane (three.js `clippingPlanes`, both meshes) to look into holes and grooves; it cuts the
  drawn faces only, never the material data.
- Fixture: about 1.6M extra triangles; slower but correct for jobs with large undercut areas.
Rejected: marching cubes / dual contouring (change the shape), shader ray marching (fragile),
instanced boxes (6M instances).

## 6. Migration (app and tests green after each step)
0. Refuse rotary-axis files at the parser boundary (about 1 hour): an A, B or C word on a motion line
   (`gcodeParser.ts` word switch) rejects the job through the parse result with one clear message naming
   the line or field, e.g. "This file uses a rotary axis (A word on line 1234). NcStepCompare simulates
   3-axis milling only, so the job is not loaded." Files with no rotary sign load as today. Tests: A word
   on G1 refused, cylinder stock header still loads, fixture loads.
1. Profile tool model and bands; height-grid results bit-identical.
2. `DexelStock` with tests (interval subtraction, pool growth, checkpoints).
3. Dexel sweep and simulation on `DexelStock`; synthetic tests (T-slot gap, single-tooth helix groove
   every P, lollipop); fixture timing gate.
4. Model dexels and interval deviation.
5. Findings on dexel components and non-cutting contact.
6. Renderer: wall discard, undercut mesh and clipping plane; frame timing before/after; browser check
   of threads.
7. Tools tab fields for the new types; missing-material view from gouge intervals.

## 7. Open questions (recommendation first)
- Q1 Neck and shank: do not cut, only report contact.
- Q2 T6 data: ISO 68-1 assumed values, pitch required as user entry; owner may supply the data sheet.
- Q3 Concave form cutters (corner rounding): out of scope until needed.
- Q4 Tri-dexel: no.
- Q5 (section plane) withdrawn: the clipping plane is part of step 6.
- Q6 Does Makera Studio mark rotary jobs other than `STOCK id=cylinder`? Refuse on `cylinder` and on
  any A, B or C motion word; anything else loads.

## 8. Effort
About 25 agent-hours: steps 0 to 7 = 1, 2, 3, 5, 4, 3, 5, 2.
