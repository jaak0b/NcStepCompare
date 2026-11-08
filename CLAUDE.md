# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Overview

NcStepCompare is a local browser tool that simulates a CNC G-code file and compares the machined result
with the STEP model, so the owner can see before cutting whether a job is right. Files never leave the
machine: everything runs in the browser, started with `npm run dev`.

Stack: Vue 3 + Vite + TypeScript, three.js for 3D, occt-import-js (OpenCascade WASM) to read STEP in the
browser, Web Workers for the simulation, vitest for tests.

### Version 1 scope: 3-axis milling

1. Load a .nc file. Makera Studio files carry a `;@MKR|` header (stock, origin, tools, toolpath names).
   Other G-code: the tool table is entered by hand. Supported: G0/G1/G2/G3 (G17 plane), G90/G91, G20/G21,
   tool changes (`T# M6`).
2. Load one or more STEP files and place each one by hand in the stock: stock size X/Y/Z; per part centre
   X/Y, bottom Z, rotation in 90 degree steps, and which model axis is "up" (Fusion exports are often Y-up).
   "Auto-orient" tries the rotations and flips and picks the best match with the simulated result.
3. Material removal on a height grid (0.05 mm default, configurable) in a Web Worker. Tool shapes: flat end
   mill, ball end, drill (editable tip angle), V-bit, thread mill (cylinder of its cutting diameter).
   Time slider and playback through the job, per toolpath.
4. Comparison rule (owner decision 2026-11-08, no special cases): outside the parts the expected surface
   is the stock bottom, so any material left outside the part outlines (cut-out frame, tabs, slivers next
   to a wall) is leftover and coloured as such; cutting there is never a gouge. Cells outside the outline
   use the same tolerance zone as inside, so a wall within tolerance of the model wall is within
   tolerance on both sides.
   3D view: machined stock coloured by deviation from the STEP (red = cut deeper than the model, blue =
   material left over, tolerance configurable), the STEP outline, toolpaths as lines (cutting vs rapid),
   toggles per toolpath.
5. Findings list, each clickable so the camera jumps there: gouges; material left over (including holes
   and openings that do not go through); rapid moves through material still present at that moment
   (sequential, not only the final state); shank/holder collision (tool deeper in material than its
   flute/shoulder length); depth into the spoilboard below the
   stock; time per toolpath and total (feed-based, acceleration ignored, and the UI says so); tool-change
   list.
   Threads: a hole cut wider than the model by a thread-mill tool is reported as "thread", not as a
   gouge, in general (not only for the fixture). Thread data is not in the STEP export (the fixture STEP
   is AP214 and has no thread entities), so detection comes from the G-code: thread-mill tool inside a
   hole.
   Feed and spindle checks: cutting moves with the spindle off, a feed of 0, plunging at the cutting
   feed.
   Non-cutting contact: warn whenever material still present at that moment touches the cutter above
   its flute length (e.g. a 30 mm cutter with 5 mm of flute buried 8 mm deep). The flute length comes
   from the Makera header or the tool table and can be edited. The spindle and collet nut are not
   checked.
   Engagement check: per move, the simulation measures the material the cutter actually removes: width
   of cut (radial engagement) and depth of cut (axial). A move above the tool's limit is a finding, so a
   full-width slot where a 0.5 mm stepover was intended shows up with the move that did it. Limits are
   per tool and editable; defaults are width of cut 50 % of the tool diameter and depth of cut 1x the
   diameter (assumed starting values).
   Tabs get no special treatment: they are material left outside the part, so they show as leftover
   like any other (owner decision 2026-11-08). A missing cut-out shows the same way.
   Plunge check: an end mill feeding straight down into material still present (drills excluded).
6. Tolerances (gouge default 0.05 mm, leftover default 0.1 mm, both assumed) are fields in the UI the
   user can change.
7. Only tool-table edits are saved in the browser (`localStorage`), keyed by the tool's Makera Studio
   name, and applied to any job that uses that tool. Placement, tolerances and files are not saved: the
   owner picks the .nc and STEP files by hand each time (owner decision 2026-11-08).

Out of scope: machine travel-limit checks (the machine controller handles them).

Later, after the groundwork is complete: Makera Studio tool-library import. Not in version 1 either:
reading placement from the Studio project file (.mks), 4th axis. Ask the owner before widening scope or
adding a big dependency.

### Milestones

1. G-code parser + toolpath viewer. 2. Simulation + playback. 3. STEP load + placement + comparison.
4. Findings. 5. Time. Each milestone is checked in the browser preview before it is shown to the owner.

## Test case (fixtures/)

- G-code: `fixtures/Z1 Pro - Backplate CM_TOP_210320.nc` (6.9 MB, 344k lines). Makera Studio 0.1.3.0,
  Makera Z1. Only G0/G1, no arcs. Retract Z3, clearance Z15.
- STEP: `fixtures/V2 Backplate 6.11 v93.step` (mm, Y-up: the 7 mm thickness runs along the model Y axis;
  only planes and cylinders; outline 51.73 x 85.95 mm).
- Placement used in Studio: stock 150 x 100 x 10 mm (6061 aluminium). Part bounding-box centre X 38.5,
  Y 50.0; part bottom on the stock bottom (Z -10), so the part top is at Z -3.0. Top side only.
- Work origin: stock top front-left corner (`ORIGIN type_name=topFrontLeft`). X 0..150, Y 0..100,
  Z0 = stock top, negative Z is down.
- Header lines (examples):
  ```
  ;@MKR|STOCK|id=cuboid|length=150|width=100|height=10|diameter=50
  ;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-75|y=-50|z=5
  ;@MKR|TOOL|number=1|...|type=Flat End|handlediameter=3.175|shoulderlength=12|flutelength=12|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0
  ;@MKR|TIME|seconds=9892.54
  ;@MKR|TOOLPATH|number=1|tool_number=1|name=[T1]3D Relief - Facing
  ```
  Body: `;@MKR|TOOLPATH_START|toolpath_number=N`, then `T1 M6`, `M7`, `S12000 M3`, G0/G1 moves. The file
  ends with a base64 PNG thumbnail between `;(thumbnail_image_begin)` and `;(thumbnail_image_end)`.
  `TIME seconds` is Studio's own estimate: compare ours against it.
- Tools: T1 3.175 flat end (12 mm flute); T2 2.5 mm carbide drill (header says angle 60 / halfAngle 30,
  real tip angle unknown, so it is editable); T3 2.0 flat end on 3.175 shank (8 mm reach); T6 M3 thread
  mill (cutting diameter 2.42, 9 mm reach).
- Expected results:
  - No gouges; all walls at final size.
  - 11 M3 holes are 2.53 mm diameter in the model (thread minor diameter) and get thread-milled to about
    3.0 mm. That is expected: report it as "thread", not as a gouge.
  - Through-cuts end 0.3 mm below the stock (Z -10.3); drilling to Z -11.0.
  - The cut-out leaves 6 tabs, 6 mm wide, 0.6 mm of aluminium high (from the owner's brief; they show
    as leftover, not as a separate finding).
- Negative test (file still to come from the owner): an earlier version roughed with a "3D Relief"
  toolpath (Offset strategy) that cut straight through a raised island of the part next to the end of
  the long central channel, beside the big round cut-out. The tool must catch that gouge.

## Conventions

These rules are strict and numbered for reference while working. Do not cite the numbers in shipped
source, comments or UI text.

1. **Geometry integrity: established methods only, never a fudge.** Simulation, arc interpolation, tool
   shape models, STEP tessellation handling, deviation comparison and finding detection use established,
   named algorithms or standard library primitives (three.js, occt-import-js), chosen because they are the
   correct model. NEVER add a hand-tuned constant, offset or tolerance fitted to make the backplate fixture
   come out right: that overfits one job and lies on the next. Real tolerances are user settings with a
   stated default. Validate every change to these paths against the fixture expectations above and
   against small synthetic G-code cases with hand-calculated results.

2. **No silently swallowed errors.** A `catch` must surface the error to the user, rethrow, or return a
   value the caller can act on. Never an empty `catch`. Unparseable or unsupported G-code is a normal
   outcome: report it with the line number and the text, do not throw away the job.

3. **Keep the engine framework-agnostic and modular.** Code in `src/engine/` (parser, header reader,
   simulation, comparison, findings, time estimate) must not import Vue, Pinia, three.js scene code or
   touch the DOM. The UI, the workers and the tests all import it directly. A new tool shape, finding type
   or G-code dialect is its own module, not an edit to unrelated ones.

4. **Commits.** Commit at will on `master`, one commit per coherent working step, so the history stays
   reviewable. Commit message: one short subject line, no body, plus the `Co-Authored-By` trailer. No other
   AI attribution anywhere (no "Generated with" lines, no AI tool name in subjects). Never push, and never
   add a remote, without the owner's explicit approval each time.

5. **Never use the em-dash character, and never a hyphen as a substitute for it.** Applies to source,
   comments, docs, UI text, commit messages and chat replies. Rewrite with a colon, parentheses, a comma,
   or two sentences. A hyphen is fine only where grammar needs one ("feed-based", "Y-up").

6. **UI text is plain technical prose in machinist terminology, everywhere.** Hints and warnings are
   complete, neutral sentences, two to three short ones is normal. Use the words CNC machinists and CAM
   software use, consistently, in UI text AND identifiers: stock, work origin, spoilboard, toolpath,
   rapid, feed, plunge, stepover, stepdown, flute length, shoulder length, shank, holder, end mill, ball
   end, V-bit, thread mill, tabs, gouge. One term per concept; never invent a synonym. Where Makera Studio
   uses its own field name (e.g. `flutelength`), map it to the standard term at the parser boundary.

7. **Diagnostic readouts show raw values.** Findings and per-job facts show each field as its own labelled
   row with the exact value and unit ("Depth below stock: 0.30 mm"). State whether a number is measured
   (from the simulation), calculated (from the G-code) or assumed (a default or user entry).

8. **Extend the concept's existing home; never bolt a duplicate beside a symptom.** Find the module that
   owns the concept before adding or fixing logic. Never compute a value twice (tool geometry, stock
   bounds, work origin transform, grid resolution): unify on one source. Any non-trivial engine or
   cross-cutting change gets a short written design first (its home, what it extends, what it must not
   duplicate).

## Working method

**Lean project.** This is a personal tool used now and then: keep token and time spend low. Write tests
only for engine logic where a bug would otherwise hide (G-code parsing, arcs, simulation math, findings,
time estimate), a few focused cases each. No UI component tests, no mutation testing, no test for trivial
code. Prefer one agent doing a whole milestone over many small agents; no extra review rounds unless the
owner asks.

**Verification bar.** "Verified" means `npx vue-tsc --noEmit` and `npx vitest run` both green, plus a
check in the browser preview for anything visible. There is no CI; the full vitest suite runs locally.
A bug fix is test-driven: write the failing test, see it fail, fix, see it pass. Make code changes first,
then run tests once at the end; do not re-run them after every edit.

**Subagents.** Implementation work goes to background `general-purpose` agents on Opus, one milestone (or
one coherent piece) at a time. Read-only lookups go to `Explore`. Every agent gets a title that names what
it does. Never run more than 1 Fable agent at a time.

**Code review after each milestone.** The parent session invokes the `/code-review` skill itself (the
owner does not) with the arguments "medium with 2 opus agents over the changes": medium effort, over that
milestone's changes only, with exactly 2 Opus review agents, never more. The builder
agent then fixes all findings, and the fixes are checked in the browser before the next milestone.

**Review subagents never extend the benefit of the doubt.** A reviewer treats every existing assumption in
the code under review (input validated, edge case handled, branch unreachable) as unverified until it
checks it. "I checked this and it holds" is a complete answer; an empty findings list is a valid outcome.
