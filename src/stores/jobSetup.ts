// Job setup that survives a reload: tool table edits, cell size, tolerances, part placements and the
// outline toggle. Saved by hand to localStorage on every change. The .nc and STEP file contents are
// not stored (localStorage holds about 5 MB): after a reload the user picks the files again, and the
// saved setup is applied when the file names (and, for STEP files, the file size) match.
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { DEFAULT_GOUGE_TOLERANCE_MM, DEFAULT_LEFTOVER_TOLERANCE_MM, type Tolerances } from '../engine/deviation'
import { DEFAULT_CELL_SIZE_MM } from '../engine/heightGrid'
import { QUARTER_TURNS, UP_AXES, type PartPlacement } from '../engine/partPlacement'
import { CUTTER_SHAPE_KINDS } from '../engine/toolShape'
import type { ToolField, ToolSetup, ValueSource } from '../engine/toolTable'

const STORAGE_KEY = 'ncstepcompare.jobSetup'
const STORAGE_VERSION = 2

export type SettingSource = 'assumed' | 'user'

/** One placed STEP part of a job. Several entries may share a STEP file name. */
export interface SavedPart {
  id: string
  /** The .nc file of the job the part belongs to. */
  ncFileName: string
  fileName: string
  fileSize: number
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
const TOOL_FIELDS: ToolField[] = ['kind', ...TOOL_NUMBER_FIELDS]
const VALUE_SOURCES: ValueSource[] = ['header', 'user', 'assumed', 'missing']

/** A saved tool entry with the shape of a ToolSetup, or null. JSON writes NaN (a missing value) as null. */
function restoreTool(raw: unknown): ToolSetup | null {
  const t = raw as Record<string, unknown> | null
  if (!t || typeof t !== 'object') return null
  if (!Number.isInteger(t.number) || typeof t.name !== 'string') return null
  if (!CUTTER_SHAPE_KINDS.includes(t.kind as ToolSetup['kind'])) return null
  const sources = t.sources as Record<string, unknown> | null
  if (!sources || typeof sources !== 'object') return null
  if (!TOOL_FIELDS.every((f) => VALUE_SOURCES.includes(sources[f] as ValueSource))) return null
  const numberOrNaN = (v: unknown) => (typeof v === 'number' ? v : v === null ? NaN : undefined)
  const out = { ...t } as unknown as ToolSetup
  for (const f of TOOL_NUMBER_FIELDS) {
    const v = numberOrNaN(t[f])
    if (v === undefined) return null
    out[f] = v
  }
  if (t.shankDiameter !== null && typeof t.shankDiameter !== 'number') return null
  if (t.studioType !== null && typeof t.studioType !== 'string') return null
  return out
}

function restorePart(raw: unknown): SavedPart | null {
  const p = raw as SavedPart | null
  if (!p || typeof p !== 'object') return null
  if (typeof p.id !== 'string' || typeof p.ncFileName !== 'string' || typeof p.fileName !== 'string') return null
  if (typeof p.fileSize !== 'number') return null
  const q = p.placement
  const ok =
    !!q &&
    UP_AXES.includes(q.upAxis) &&
    QUARTER_TURNS.includes(q.quarterTurns) &&
    [q.centerX, q.centerY, q.bottomZ].every((v) => typeof v === 'number' && Number.isFinite(v))
  return ok ? p : null
}

/** The saved setup, or the defaults, plus what could not be restored. */
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
    const rawTools: unknown[] = Array.isArray(raw.tools) ? raw.tools : []
    const rawParts: unknown[] = Array.isArray(raw.parts) ? raw.parts : []
    const tools = rawTools.map(restoreTool).filter((t): t is ToolSetup => t !== null)
    const parts = rawParts.map(restorePart).filter((p): p is SavedPart => p !== null)
    const dropped: string[] = []
    if (tools.length < rawTools.length) dropped.push(`${rawTools.length - tools.length} tool table entries`)
    if (parts.length < rawParts.length) dropped.push(`${rawParts.length - parts.length} part placements`)
    return {
      setup: {
        version: STORAGE_VERSION,
        ncFileName: typeof raw.ncFileName === 'string' ? raw.ncFileName : null,
        tools,
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
        parts,
        outlinesVisible: raw.outlinesVisible !== false,
      },
      problem:
        dropped.length > 0 ? `Saved setup restored without ${dropped.join(' and ')} that were not valid.` : null,
    }
  } catch (err) {
    return { setup: defaults(), problem: `The saved job setup could not be read and was not restored: ${String(err)}` }
  }
}

const samePlacement = (a: PartPlacement, b: PartPlacement) =>
  a.upAxis === b.upAxis &&
  a.quarterTurns === b.quarterTurns &&
  a.centerX === b.centerX &&
  a.centerY === b.centerY &&
  a.bottomZ === b.bottomZ

let idCounter = 0
const newPartId = () => `${Date.now().toString(36)}-${(idCounter++).toString(36)}`

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
  /** Why the saved setup was not fully restored or could not be saved, or null. */
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
    if (tolerances.value[which] === value) return
    tolerances.value = { ...tolerances.value, [which]: value }
    toleranceSources.value = { ...toleranceSources.value, [which]: 'user' }
  }

  function placementOf(id: string): PartPlacement | null {
    return parts.value.find((p) => p.id === id)?.placement ?? null
  }

  /** Saved parts of the current job whose id is not in `inUse`, matching the STEP file. */
  function findSaved(fileName: string, fileSize: number, inUse: Set<string>): SavedPart | null {
    return (
      parts.value.find(
        (p) =>
          p.ncFileName === ncFileName.value && p.fileName === fileName && p.fileSize === fileSize && !inUse.has(p.id),
      ) ?? null
    )
  }

  /** Adds a part to the current job; returns its id. */
  function addPart(fileName: string, fileSize: number, placement: PartPlacement): string {
    const id = newPartId()
    parts.value = [...parts.value, { id, ncFileName: ncFileName.value ?? '', fileName, fileSize, placement: { ...placement } }]
    return id
  }

  /** Changes a part's placement; nothing happens when it is unchanged. */
  function setPlacement(id: string, placement: PartPlacement) {
    const at = parts.value.findIndex((p) => p.id === id)
    if (at < 0 || samePlacement(parts.value[at].placement, placement)) return
    const next = [...parts.value]
    next[at] = { ...next[at], placement: { ...placement } }
    parts.value = next
  }

  function removePart(id: string) {
    parts.value = parts.value.filter((p) => p.id !== id)
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
    placementOf,
    findSaved,
    addPart,
    setPlacement,
    removePart,
  }
})
