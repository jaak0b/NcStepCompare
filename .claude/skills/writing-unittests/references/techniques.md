# Techniques for proving a test works

A test is a claim ("this would catch that bug"). Each technique below is a way to check the
claim instead of assuming it.

## Watch it fail first

The cheapest proof. When writing a test for a bug, run the test against the broken code before
fixing it and confirm it goes red for the expected reason (read the failure message: a timeout or
an import error is not the failure you meant). When writing a test for existing correct code,
temporarily re-break the code (flip a sign, swap G2 and G3, off-by-one a grid bound) and confirm
the test catches it, then revert. A test that has never been seen red is unverified; it may be
asserting nothing.

## Synthetic-toolpath recovery (the project's gold standard)

For the simulation and comparison pipeline the oracle problem is solved by generating the input
from known ground truth: a short G-code program that cuts known geometry (a pocket of known
depth, a slot of known width, a profile leaving tabs of known height, a rapid deliberately routed
through stock) with a known tool (flat, ball, drill, V-bit of given diameter, flute length and
shoulder length) into stock of known size. The test asserts the engine recovers those seed
literals within a justified tolerance: the pocket floor at the seeded depth, the slot at the
tool's diameter, the gouge or leftover material at the seeded location, the rapid flagged, the
spoilboard cut depth. The truth is the seed, never a computed expectation, so this pattern
satisfies the no-math rule. Simulation and comparison math changes must keep these tests green.

Caveat: a synthetic fixture generated from the same wrong equations as the code validates the
bug. Vary the generation path from the measurement path (hand-written G-code rather than code
emitted by a helper that shares engine logic, non-axis-aligned moves, arcs in both directions,
a work origin away from zero) so a shared mistake cannot cancel out.

## Mutation testing

Stryker plants small bugs (mutants: flipped operators, deleted statements, changed constants) in
the engine and reruns the covering tests; a mutant that survives on covered core code is direct,
mechanical evidence that the covering tests are weak, exactly the "would it fail on a real bug"
question answered empirically. Run it on the touched module when in doubt about a test's
strength (see [mutation-testing.md](mutation-testing.md)).

## Property-based testing

For pure geometry and math stages (arc interpolation, tool profile functions, grid indexing,
coordinate transforms), fast-check style property tests assert invariants over generated inputs
instead of one example: every point of an interpolated arc lies on the arc's radius within the
chord tolerance, cutting the same move twice leaves the height grid unchanged, a cut never raises
a grid cell, a ball end mill never removes material outside its radius. Properties are behavior
statements, so they pass the refactoring-resistance test by construction. Keep the invariant
independent of the implementation (do not re-derive the answer, state a relation that must
hold).

## Metamorphic testing

When no oracle exists for a single input, relate the outputs of transformed inputs: translate,
mirror, or rotate the toolpath and assert the result transforms consistently (shifting the work
origin shifts every finding by the same offset, mirroring a program swaps climb and conventional
and turns G2 into G3 while the cut volume stays the same, a program in G20 and its G21 equivalent
produce the same height grid). Include a deliberately distinct figure on the axis that should not
change, to prove a value cannot leak across axes.

## Tolerances

A float tolerance is a claim about the method's noise floor (height-grid cell size, arc chord
error, STEP tessellation deviation, accumulated float error over a long program), stated where it
is chosen with the reason it is that size. It is never a convenient round number picked to pass,
and it is never widened to make a failing test pass: a failure inside the old band is a
regression to explain, not a band to stretch. Size the band tight enough that a sign flip, a
missing unit conversion (inch vs mm), a radius used as a diameter, or a factor-of-2 error still
fails.
