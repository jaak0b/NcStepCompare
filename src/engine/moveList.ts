// Compact, typed-array move list. One entry per straight segment: an arc is stored as the chord
// segments it was flattened into, each carrying the arc's source line.

export const MoveType = { Rapid: 0, Feed: 1, Arc: 2 } as const
export type MoveTypeValue = (typeof MoveType)[keyof typeof MoveType]

export const SpindleState = { Off: 0, Clockwise: 1, CounterClockwise: 2 } as const
export type SpindleStateValue = (typeof SpindleState)[keyof typeof SpindleState]

/** Tool number stored when no tool has been loaded with M6 yet. */
export const NO_TOOL = -1
/** Toolpath number stored for moves outside any `TOOLPATH_START` marker. */
export const NO_TOOLPATH = 0

export interface MoveList {
  count: number
  /** x, y, z per move, in mm, work coordinates. */
  start: Float64Array
  end: Float64Array
  type: Uint8Array
  /** Programmed feed in mm/min; 0 for rapids and when no F word was given yet. */
  feed: Float32Array
  spindle: Uint8Array
  /** Programmed spindle speed (S word) in rpm, also stored while the spindle is off. */
  spindleSpeed: Float32Array
  tool: Int32Array
  /** Toolpath number from the `TOOLPATH_START` marker, or NO_TOOLPATH. */
  toolpath: Int32Array
  /** 1-based line number in the source file. */
  line: Int32Array
}

export interface MoveAttributes {
  type: MoveTypeValue
  feed: number
  spindle: SpindleStateValue
  spindleSpeed: number
  tool: number
  toolpath: number
  line: number
}

export class MoveListBuilder {
  private capacity: number
  private n = 0
  private start: Float64Array
  private end: Float64Array
  private type: Uint8Array
  private feed: Float32Array
  private spindle: Uint8Array
  private spindleSpeed: Float32Array
  private tool: Int32Array
  private toolpath: Int32Array
  private line: Int32Array

  constructor(initialCapacity = 1024) {
    this.capacity = Math.max(1, initialCapacity)
    this.start = new Float64Array(this.capacity * 3)
    this.end = new Float64Array(this.capacity * 3)
    this.type = new Uint8Array(this.capacity)
    this.feed = new Float32Array(this.capacity)
    this.spindle = new Uint8Array(this.capacity)
    this.spindleSpeed = new Float32Array(this.capacity)
    this.tool = new Int32Array(this.capacity)
    this.toolpath = new Int32Array(this.capacity)
    this.line = new Int32Array(this.capacity)
  }

  get count(): number {
    return this.n
  }

  push(
    sx: number,
    sy: number,
    sz: number,
    ex: number,
    ey: number,
    ez: number,
    a: MoveAttributes,
  ): void {
    if (this.n === this.capacity) this.grow()
    const i = this.n++
    const j = i * 3
    this.start[j] = sx
    this.start[j + 1] = sy
    this.start[j + 2] = sz
    this.end[j] = ex
    this.end[j + 1] = ey
    this.end[j + 2] = ez
    this.type[i] = a.type
    this.feed[i] = a.feed
    this.spindle[i] = a.spindle
    this.spindleSpeed[i] = a.spindleSpeed
    this.tool[i] = a.tool
    this.toolpath[i] = a.toolpath
    this.line[i] = a.line
  }

  private grow(): void {
    const cap = this.capacity * 2
    const grow64 = (a: Float64Array, k: number) => {
      const b = new Float64Array(cap * k)
      b.set(a)
      return b
    }
    const grow32f = (a: Float32Array) => {
      const b = new Float32Array(cap)
      b.set(a)
      return b
    }
    const grow32i = (a: Int32Array) => {
      const b = new Int32Array(cap)
      b.set(a)
      return b
    }
    const grow8 = (a: Uint8Array) => {
      const b = new Uint8Array(cap)
      b.set(a)
      return b
    }
    this.start = grow64(this.start, 3)
    this.end = grow64(this.end, 3)
    this.type = grow8(this.type)
    this.feed = grow32f(this.feed)
    this.spindle = grow8(this.spindle)
    this.spindleSpeed = grow32f(this.spindleSpeed)
    this.tool = grow32i(this.tool)
    this.toolpath = grow32i(this.toolpath)
    this.line = grow32i(this.line)
    this.capacity = cap
  }

  /** Returns the list trimmed to its length. The builder must not be used afterwards. */
  finish(): MoveList {
    const n = this.n
    return {
      count: n,
      start: this.start.slice(0, n * 3),
      end: this.end.slice(0, n * 3),
      type: this.type.slice(0, n),
      feed: this.feed.slice(0, n),
      spindle: this.spindle.slice(0, n),
      spindleSpeed: this.spindleSpeed.slice(0, n),
      tool: this.tool.slice(0, n),
      toolpath: this.toolpath.slice(0, n),
      line: this.line.slice(0, n),
    }
  }
}

/** The underlying buffers, for transferring a move list from a worker without copying. */
export function moveListBuffers(list: MoveList): ArrayBuffer[] {
  return [
    list.start,
    list.end,
    list.type,
    list.feed,
    list.spindle,
    list.spindleSpeed,
    list.tool,
    list.toolpath,
    list.line,
  ].map((a) => a.buffer as ArrayBuffer)
}
