# Mutation testing with Stryker

StrykerJS (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`) plants small bugs
(mutants: flipped operators, deleted statements, changed constants) in the engine source and
reruns the covering tests; a mutant that survives on covered core code names a weak test
directly. Run it locally only; it is a diagnostic, not a gate.

## How to run it

- **One module (the normal case):** `npx stryker run --mutate src/engine/<module>.ts`, for the
  module a change touched or whose suite a review doubts.
- Use `coverageAnalysis: 'perTest'` so each mutant only reruns the tests that cover it, and
  `incremental: true` so repeat runs reuse prior results. Leave `thresholds.break` null: the run
  reports scores but never fails the command.
- Do not mutate the whole engine in one run on a dev machine; narrow to the modules in question.

## Scope and exclusions

`mutate` targets `src/engine/**/*.ts` minus modules with nothing behavior-shaped to mutate:

- Type-only modules (`types.ts`, `**/types.ts`).
- Loader and IO glue: the occt-import-js STEP loader wrapper, file reading, Web Worker message
  plumbing.
- Display-only output (rendering of the height grid or findings for the UI), which is not a
  measurement path.

Everything else (G-code parser, Makera `;@MKR|` header parsing, arc interpolation, tool shapes,
height-grid simulation, deviation comparison, findings such as gouges, leftover material, rapids
through material, shank collisions, tabs, spoilboard depth, machining time) is mutated.

Tests that load the large fixtures in `fixtures/` are slow; if a mutation run against them is
impractically long, exclude those specs from the mutation run's Vitest config rather than
mutating less of the engine. The synthetic-toolpath tests remain the correctness gate for that
math.

## Reading the results

Read the survivors, not just the score: each surviving mutant is a concrete bug the suite would
miss. Kill it by strengthening an assertion (per the no-math rule: with an independent literal),
or accept it with a reason (an equivalent mutant, or a numeric-tolerance boundary the method's
noise floor genuinely cannot distinguish). Run a targeted pass on the touched module whenever a
review doubts a test's strength.
