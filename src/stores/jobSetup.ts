// Job setup that survives a reload: tool table edits, cell size, tolerances, part placements and the
// outline toggle. Saved by hand to localStorage on every change. The .nc and STEP file contents are
// not stored (localStorage holds about 5 MB): after a reload the user picks the files again, and the
// saved setup is applied when the file names match.
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { DEFAULT_GOUGE_TOLERANCE_MM, DEFAULT_LEFTOVER_TOLERANCE_MM, type Tolerances } from '../engine/deviation'
import { DEFAULT_CELL_SIZE_MM } from '../engine/heightGrid'
import { QUARTER_TURNS, UP_AXES, type PartPlacement } from '../engine/partPlacement'
import type { ToolSetup } from '../engine/toolTable'

const STORAGE_KEY = 'ncstepcompare.jobSetup'
const STORAGE_VERSION = 1

export type SettingSource = 'assumed' | 'user'

export interface SavedPart {
  fileName: string
  placement: PartPlacement
}

interface SavedSetup {
  version: number
  ncFileName: string | null
  tools: ToolSetup[]
  cellSize: number
  cellSizeSource: SettingSource
  tolerances: Tolerances
  toleranceSources: { gouge: SettingSource; leftover: SettingSource }
  parts: SavedPart[]
  outlinesVisible: boolean
}

function defaults(): SavedSetup {
  return {
    version: STORAGE_VERSION,
    ncFileName: null,
    tools: [],
    cellSize: DEFAULT_CELL_SIZE_MM,
    cellSizeSource: 'assumed',
    tolerances: { gouge: DEFAULT_GOUGE_TOLERANCE_MM, leftover: DEFAULT_LEFTOVER_TOLERANCE_MM },
    toleranceSources: { gouge: 'assumed', leftover: 'assumed' },
    parts: [],
    outlinesVisible: true,
  }
}

const TOOL_NUMBER_FIELDS = ['diameter', 'cornerRadius', 'tipAngle', 'fluteLength', 'shoulderLength'] as const

/** JSON writes NaN (a missing tool value) as null; turn it back. */
function restoreTool(t: ToolSetup): ToolSetup {
  const out = { ...t }
  for (const f of TOOL_NUMBER_FIELDS) if (typeof out[f] !== 'number') out[f] = NaN
  return out
}

function validPlacement(p: unknown): p is PartPlacement {
  const q = p as PartPlacement
  return (
    !!q &&
    UP_AXES.includes(q.upAxis) &&
    QUARTER_TURNS.includes(q.quarterTurns) &&
    [q.centerX, q.centerY, q.bottomZ].every((v) => typeof v === 'number' && Number.isFinite(v))
  )
}

/** The saved setup, or the defaults plus the reason it could not be used. */
function load(): { setup: SavedSetup; problem: string | null } {
  let text: string | null
  try {
    text = localStorage.getItem(STORAGE_KEY)
  } catch (err) {
    return { setup: defaults(), problem: `The browser refused access to saved data: ${String(err)}` }
  }
  if (text === null) return { setup: defaults(), problem: null }
  try {
    const raw = JSON.parse(text) as Partial<SavedSetup>
    if (raw.version !== STORAGE_VERSION) {
      return { setup: defaults(), problem: 'The saved job setup is from another version and was not restored.' }
    }
    const d = defaults()
    const positive = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback)
    return {
      setup: {
        version: STORAGE_VERSION,
        ncFileName: typeof raw.ncFileName === 'string' ? raw.ncFileName : null,
        tools: Array.isArray(raw.tools) ? raw.tools.map(restoreTool) : [],
        cellSize: positive(raw.cellSize, d.cellSize),
        cellSizeSource: raw.cellSizeSource === 'user' ? 'user' : 'assumed',
        tolerances: {
          gouge: positive(raw.tolerances?.gouge, d.tolerances.gouge),
          leftover: positive(raw.tolerances?.leftover, d.tolerances.leftover),
        },
        toleranceSources: {
          gouge: raw.toleranceSources?.gouge === 'user' ? 'user' : 'assumed',
          leftover: raw.toleranceSources?.leftover === 'user' ? 'user' : 'assumed',
        },
        parts: Array.isArray(raw.parts)
          ? raw.parts.filter((p) => typeof p?.fileName === 'string' && validPlacement(p.placement))
          : [],
        outlinesVisible: raw.outlinesVisible !== false,
      },
      problem: null,
    }
  } catch (err) {
    return { setup: defaults(), problem: `The saved job setup could not be read and was not restored: ${String(err)}` }
  }
}

export const useJobSetupStore = defineStore('jobSetup', () => {
  const { setup, problem } = load()
  const ncFileName = ref(setup.ncFileName)
  const tools = ref<ToolSetup[]>(setup.tools)
  const cellSize = ref(setup.cellSize)
  const cellSizeSource = ref<SettingSource>(setup.cellSizeSource)
  const tolerances = ref<Tolerances>(setup.tolerances)
  const toleranceSources = ref(setup.toleranceSources)
  const parts = ref<SavedPart[]>(setup.parts)
  const outlinesVisible = ref(setup.outlinesVisible)
  /** Why the saved setup was not restored or could not be saved, or null. */
  const storageProblem = ref<string | null>(problem)

  function save() {
    const data: SavedSetup = {
      version: STORAGE_VERSION,
      ncFileName: ncFileName.value,
      tools: tools.value,
      cellSize: cellSize.value,
      cellSizeSource: cellSizeSource.value,
      tolerances: tolerances.value,
      toleranceSources: toleranceSources.value,
      parts: parts.value,
      outlinesVisible: outlinesVisible.value,
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      if (storageProblem.value?.startsWith('Not saved')) storageProblem.value = null
    } catch (err) {
      storageProblem.value = `Not saved in the browser: ${String(err)}`
    }
  }
  watch([ncFileName, tools, cellSize, cellSizeSource, tolerances, toleranceSources, parts, outlinesVisible], save, {
    deep: true,
  })

  /**
   * Tool table for a newly loaded .nc file: the saved edits when the file name matches the saved
   * one (per tool number), otherwise the table built from the file.
   */
  function applyLoadedJob(fileName: string, built: ToolSetup[]) {
    if (fileName === ncFileName.value) {
      tools.value = built.map((t) => tools.value.find((s) => s.number === t.number) ?? t)
    } else {
      tools.value = built
      ncFileName.value = fileName
    }
  }

  function setTolerance(which: keyof Tolerances, value: number) {
    tolerances.value = { ...tolerances.value, [which]: value }
    toleranceSources.value = { ...toleranceSources.value, [which]: 'user' }
  }

  function placementFor(fileName: string): PartPlacement | null {
    return parts.value.find((p) => p.fileName === fileName)?.placement ?? null
  }

  function setPlacement(fileName: string, placement: PartPlacement) {
    const next = parts.value.filter((p) => p.fileName !== fileName)
    const at = parts.value.findIndex((p) => p.fileName === fileName)
    next.splice(at < 0 ? next.length : at, 0, { fileName, placement: { ...placement } })
    parts.value = next
  }

  function removePart(fileName: string) {
    parts.value = parts.value.filter((p) => p.fileName !== fileName)
  }

  return {
    ncFileName,
    tools,
    cellSize,
    cellSizeSource,
    tolerances,
    toleranceSources,
    parts,
    outlinesVisible,
    storageProblem,
    applyLoadedJob,
    setTolerance,
    placementFor,
    setPlacement,
    removePart,
  }
})
