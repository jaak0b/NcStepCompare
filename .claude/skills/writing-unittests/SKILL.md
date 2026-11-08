---
name: writing-unittests
description: Use when adding or changing a Vitest unit test under tests/**, when changing engine code under src/engine/** (G-code parser, arc interpolation, tool shapes, height-grid simulation, STEP comparison, findings) that needs a test which would actually catch a real bug, or when reviewing unit tests, before committing the change.
---

# Writing unit tests

Unit tests (Vitest, `tests/**`) are the correctness net for whoever touches the code: they keep
the engine (`src/engine/**`: G-code parser, arc interpolation, tool shapes, height-grid
simulation, deviation comparison, findings) honest against known ground truth. Run them locally
with `npx vitest run`, and type-check with `npx vue-tsc --noEmit`.

## The two questions every test must pass

A unit test earns its place by answering yes to both (Khorikov's four pillars, Beck's test
desiderata, the Google Testing Blog agree on the core):

1. **Would it fail on a real bug?** (regression protection)
2. **Would it stay green through a behavior-preserving refactor?** (refactoring resistance)

Plus fast feedback and maintainability. Test observable behavior through the public interface of
the module under test; never assert internal steps, private helpers, or call sequences. Test
state, not interactions: an interaction test checks how a result was reached, and only the result
matters. A test that fails both questions is a change detector, and a change detector is worse
than no test, because it trains people to update expectations on sight.

## HARD RULE: no math in tests

Owner-mandated and non-negotiable. An expected value is NEVER calculated inside a test: no
formulas, no unit conversions (inch to mm, feed per minute to time), no reuse of production
helpers to derive the expectation. The parser, simulation and comparison are deterministic, so
every expected result is a hardcoded literal with an independent provenance: hand-calculated once
outside the test, taken from a spec or standard (the G-code arc conventions, the tool's catalogue
dimensions), or the known ground truth a synthetic fixture was generated from. A test that
recomputes the expected value with the same formula as production is tautological: it shares any
bug with the code under test and can never catch the bug it mirrors (a sign inversion, a G2/G3
direction swap, a radius used where a diameter was meant).

**Clarification, not an exception:** the synthetic-toolpath recovery pattern generates the INPUT
(a short G-code program cutting known geometry with a known tool into known stock) and asserts
the engine recovers those hardcoded parameters within tolerance: pocket depth, slot width, the
cusp left by a ball end mill at a given stepover, the remaining tab height. That is the gold
standard for this project, because the truth is the seed literal, not a computed expectation.
Any change to simulation or comparison math must keep these tests green, unweakened.

Tolerances on float assertions come from the method's numerical noise floor (height-grid cell
size, arc segmentation chord error, tessellation deviation of the STEP mesh) and are justified
where chosen, never a convenient round number, and never widened to make a failure pass.

## Banned smells

Full catalogue with examples in [references/smells.md](references/smells.md). The headline list
(Meszaros's xUnit Test Patterns, Google Testing Blog):

- **Tautological test**: expected value derived by the production formula (see hard rule above).
- **Change detector**: fails on any implementation change; unread snapshot dumps.
- **Over-mocking**: `expect(mock).toHaveBeenCalledWith(...)` mirroring the calling code tests
  "did I write this code". Mock only true boundaries (IO, network, clock). Engine tests call the
  real parser, simulator and comparator on real or synthetic G-code (the classicist style); keep
  it that way.
- **Obscure test / mystery guest**: the expected behavior is unreadable without opening the
  implementation or an unseen shared fixture.
- **Assertion roulette**: many unlabeled asserts in one test.
- **Conditional logic in tests**: no if/loops branching on outcomes; parametrized case tables are
  fine.
- **Shared mutable fixtures**: prefer local builders per test.
- **DRY over DAMP**: duplication is acceptable when it keeps a test verifiable by inspection.

## Proving a test works

Details and recipes in [references/techniques.md](references/techniques.md).

- **Watch it fail first.** When writing a test for a bug, run it against the broken code (or
  temporarily re-break it) and see red. A test never seen red is unverified.
- **Mutation testing** is the mechanical version: Stryker over the touched engine module. A
  surviving mutant on covered core code is direct evidence of a weak test. Scope and how to run
  it: [references/mutation-testing.md](references/mutation-testing.md).
- **Property-based tests** (fast-check) fit pure geometry and math stages: assert invariants over
  generated inputs.
- **Metamorphic tests** when no oracle exists: transform the input (translate the work origin,
  mirror the toolpath, reverse G2 and G3, scale the units) and assert the result transforms
  consistently.

## Structure rules

- One behavior per test; the name states the behavior ("reports a gouge where the ball end mill
  cuts below the model floor"), not the method name.
- Arrange-act-assert visibly separated.
- Expected literals visible in the test body, not hidden behind helpers or constants files.

## Review checklist

Use [references/review-checklist.md](references/review-checklist.md) when reviewing new or
existing unit tests.

## Slow or heavy fixtures are not an excuse

Tests on the large fixtures in `fixtures/` (the 344k-line Makera `.nc` file and the STEP model)
are slow and memory-heavy. That is never a reason to weaken an assertion, widen a tolerance, or
skip a test in committed code.
