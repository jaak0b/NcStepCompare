import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadToolEdits, storeToolEdits } from '../src/ui/toolEditStorage'

describe('saved tool edits', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('round-trips a thread mill entry with its thread fields', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    const t6 = { kind: 'thread mill' as const, pitch: 0.5, profileAngle: 60, teeth: 1, toothTipFlat: 0.0625, neckDiameter: 1.8, toothOffset: 0.3 }

    expect(storeToolEdits({ 'name:M3 thread mill': t6 })).toBeNull()
    expect(loadToolEdits()).toEqual({ edits: { 'name:M3 thread mill': t6 }, problem: null })
  })
})
