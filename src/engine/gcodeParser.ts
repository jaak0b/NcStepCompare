// G-code parser for 3-axis milling: turns program text into a typed-array move list.
//
// Supported: G0/G1/G2/G3 (arcs in G17 with I/J centre or R radius), G17, G20/G21 (inch input is
// converted to mm), G90/G91, G90.1/G91.1 (arc centre mode), F, S, M3/M4/M5, T# with M6, M7/M8/M9,
// ( ) and ; comments, Makera `;@MKR|` records. Anything else becomes a warning with the line number
// and text; the rest of the job is still parsed.
//
// A rotary axis word (A, B or C) on a line that moves the machine refuses the whole job: the result
// carries a refusal and no moves, because a 3-axis simulation of a 4- or 5-axis program would be
// wrong. A rotary word on a line that does not move (G92, G4, M6 and the like) is a warning.
//
// The position before the first absolute move on an axis is unknown. Moves that start or end on
// an unknown axis are not stored: a rapid there is normal (the machine positions itself), a feed
// move there is reported as a warning.

import {
  DEFAULT_CHORD_TOLERANCE_MM,
  assertValidChordTolerance,
  arcCentreFromRadius,
  arcRadiusMismatch,
  flattenArc,
} from './arc'
import {
  MAKERA_RECORD_PREFIX,
  applyMakeraRecord,
  emptyMakeraHeader,
  parseMakeraRecord,
  type MakeraHeader,
} from './makeraHeader'
import {
  MoveListBuilder,
  MoveType,
  NO_TOOL,
  NO_TOOLPATH,
  SpindleState,
  type MoveAttributes,
  type MoveList,
  type MoveTypeValue,
  type SpindleStateValue,
} from './moveList'

export interface ParseWarning {
  /** 1-based line number. */
  line: number
  /** The source line as written. */
  text: string
  message: string
}

export interface ParseOptions {
  /** Maximum distance in mm between a flattened arc and the true arc. */
  chordToleranceMm?: number
}

/** A tool change (M6) as programmed. */
export interface ToolChange {
  /** 1-based line number of the M6. */
  line: number
  tool: number
  /** Toolpath the change belongs to (the toolpath marker in force), or NO_TOOLPATH. */
  toolpath: number
}

/** A programmed dwell (G4). */
export interface Dwell {
  /** 1-based line number. */
  line: number
  /**
   * The word that gave the time. X and S are seconds. The unit of P depends on the controller
   * (seconds in RS274/NGC and Grbl, milliseconds in Fanuc and Smoothieware), so it is left to the caller.
   */
  word: 'P' | 'X' | 'S'
  value: number
  /** Toolpath the dwell belongs to (the toolpath marker in force), or NO_TOOLPATH. */
  toolpath: number
}

/** Why the whole job was not loaded. */
export interface ParseRefusal {
  /** 1-based line number. */
  line: number
  /** The source line as written. */
  text: string
  message: string
}

export interface ParsedJob {
  header: MakeraHeader
  /** True when the file contains at least one `;@MKR|` record. */
  hasMakeraHeader: boolean
  moves: MoveList
  toolChanges: ToolChange[]
  dwells: Dwell[]
  /**
   * Lines that move the machine but add nothing to the move list: a start or end position that is
   * not known (before the first absolute move, after G28 or G53), an unsupported motion mode, or an
   * arc that cannot be drawn.
   */
  unstoredMotionLines: number
  warnings: ParseWarning[]
  /** Set when the job is refused; moves, tool changes and warnings are then empty. */
  refusal: ParseRefusal | null
  lineCount: number
  chordToleranceMm: number
}

const THUMBNAIL_BEGIN = ';(thumbnail_image_begin)'
const THUMBNAIL_END = ';(thumbnail_image_end)'
const MM_PER_INCH = 25.4
const MAX_WORDS_PER_LINE = 64

const CH_TAB = 9
const CH_SPACE = 32
const CH_PERCENT = 37
const CH_PAREN_OPEN = 40
const CH_PAREN_CLOSE = 41
const CH_PLUS = 43
const CH_MINUS = 45
const CH_DOT = 46
const CH_0 = 48
const CH_9 = 57
const CH_SEMICOLON = 59
const CH_A = 65
const CH_E = 69
const CH_Z = 90
const CH_a = 97
const CH_e = 101
const CH_z = 122

const enum Motion {
  None = -1,
  Rapid = 0,
  Linear = 1,
  ArcCW = 2,
  ArcCCW = 3,
  /** A motion code this parser does not model (canned cycles, probing, splines, threading). */
  Unsupported = 4,
}

const enum Plane {
  XY,
  XZ,
  YZ,
}

const LETTER_INDEX = (ch: string) => ch.charCodeAt(0) - CH_A

/** First rotary axis word (A, B or C with a number) outside comments, for lines the tokeniser rejected. */
function rotaryWordInRawLine(text: string): string {
  const code = text.replace(/\([^)]*\)/g, ' ').replace(/;.*/, '')
  const m = /([ABC])\s*[-+]?[\d.]/i.exec(code)
  return m ? m[1].toUpperCase() : ''
}

export function parseGcode(source: string, options: ParseOptions = {}): ParsedJob {
  const chordTolerance = options.chordToleranceMm ?? DEFAULT_CHORD_TOLERANCE_MM
  assertValidChordTolerance(chordTolerance)
  const header = emptyMakeraHeader()
  let hasMakeraHeader = false
  const warnings: ParseWarning[] = []
  const toolChanges: ToolChange[] = []
  const dwells: Dwell[] = []
  let unstoredMotionLines = 0
  const moves = new MoveListBuilder(Math.max(1024, Math.ceil(source.length / 20)))

  // Modal state.
  let motion: Motion = Motion.None
  let unsupportedMotionName = ''
  let plane: Plane = Plane.XY
  let unitScale = 1
  let incremental = false
  let arcCentreAbsolute = false
  let feed = 0
  let spindleSpeed = 0
  let spindle: SpindleStateValue = SpindleState.Off
  let selectedTool = NO_TOOL
  let tool = NO_TOOL
  let toolpath = NO_TOOLPATH
  let x = NaN
  let y = NaN
  let z = NaN

  // Per-line word buffers (letter index 0..25 and value), reused to avoid allocation.
  const wordLetter = new Uint8Array(MAX_WORDS_PER_LINE)
  const wordValue = new Float64Array(MAX_WORDS_PER_LINE)

  const len = source.length
  let pos = 0
  let lineNo = 0
  let lineStart = 0
  let lineEnd = 0

  const lineText = () => source.slice(lineStart, lineEnd)
  const warn = (message: string) => warnings.push({ line: lineNo, text: lineText(), message })
  const refuse = (rotaryWord: string): ParsedJob => ({
    header,
    hasMakeraHeader,
    moves: new MoveListBuilder(1).finish(),
    toolChanges: [],
    dwells: [],
    unstoredMotionLines: 0,
    warnings: [],
    refusal: {
      line: lineNo,
      text: lineText(),
      message:
        `This file uses a rotary axis (${rotaryWord} word on line ${lineNo}). ` +
        'NcStepCompare simulates 3-axis milling only, so the job is not loaded.',
    },
    lineCount: lineNo,
    chordToleranceMm: chordTolerance,
  })
  const rotaryWarning = (rotaryWord: string) =>
    warn(`Rotary axis word ${rotaryWord} ignored: this line does not move the machine, and only 3-axis milling is simulated.`)

  const attrs: MoveAttributes = {
    type: MoveType.Rapid,
    feed: 0,
    spindle: SpindleState.Off,
    spindleSpeed: 0,
    tool: NO_TOOL,
    toolpath: NO_TOOLPATH,
    line: 0,
  }
  const setAttrs = (type: MoveTypeValue) => {
    attrs.type = type
    attrs.feed = type === MoveType.Rapid ? 0 : feed
    attrs.spindle = spindle
    attrs.spindleSpeed = spindleSpeed
    attrs.tool = tool
    attrs.toolpath = toolpath
    attrs.line = lineNo
  }

  while (pos < len) {
    let nl = source.indexOf('\n', pos)
    if (nl < 0) nl = len
    lineNo++
    lineStart = pos
    lineEnd = nl
    if (lineEnd > lineStart && source.charCodeAt(lineEnd - 1) === 13) lineEnd--
    pos = nl + 1

    // Skip leading whitespace.
    let i = lineStart
    while (i < lineEnd) {
      const c = source.charCodeAt(i)
      if (c !== CH_SPACE && c !== CH_TAB) break
      i++
    }
    if (i >= lineEnd) continue

    if (source.charCodeAt(i) === CH_SEMICOLON) {
      if (source.startsWith(MAKERA_RECORD_PREFIX, i)) {
        const record = parseMakeraRecord(source.slice(i, lineEnd))
        if (record) {
          hasMakeraHeader = true
          const problem = applyMakeraRecord(header, record)
          if (problem) warn(problem)
          if (record.type === 'TOOLPATH_START') {
            const n = Number(record.fields.toolpath_number)
            if (Number.isInteger(n) && n > 0) toolpath = n
            else warn('Toolpath start marker has no valid toolpath number.')
          }
        }
      } else if (source.startsWith(THUMBNAIL_BEGIN, i)) {
        // Skip the embedded base64 image without looking at its lines one by one.
        const endAt = source.indexOf(THUMBNAIL_END, pos)
        if (endAt < 0) {
          warn('Thumbnail image block has no end marker. The rest of the file was not read.')
          pos = len
          break
        }
        let k = source.indexOf('\n', pos)
        while (k >= 0 && k < endAt) {
          lineNo++
          k = source.indexOf('\n', k + 1)
        }
        pos = source.lastIndexOf('\n', endAt) + 1
      }
      continue
    }

    // Tokenise into words.
    let words = 0
    let lineError: string | null = null
    while (i < lineEnd) {
      const c = source.charCodeAt(i)
      if (c === CH_SPACE || c === CH_TAB || c === CH_PERCENT) {
        i++
        continue
      }
      if (c === CH_SEMICOLON) break
      if (c === CH_PAREN_OPEN) {
        let close = i + 1
        while (close < lineEnd && source.charCodeAt(close) !== CH_PAREN_CLOSE) close++
        if (close >= lineEnd) {
          lineError = 'Comment has no closing parenthesis.'
          break
        }
        i = close + 1
        continue
      }
      let letter = -1
      if (c >= CH_A && c <= CH_Z) letter = c - CH_A
      else if (c >= CH_a && c <= CH_z) letter = c - CH_a
      if (letter < 0) {
        lineError = `Unexpected character "${source[i]}".`
        break
      }
      i++
      while (i < lineEnd && (source.charCodeAt(i) === CH_SPACE || source.charCodeAt(i) === CH_TAB)) i++
      const numStart = i
      let ch = source.charCodeAt(i)
      if (ch === CH_PLUS || ch === CH_MINUS) ch = source.charCodeAt(++i)
      let digits = 0
      while (i < lineEnd && ch >= CH_0 && ch <= CH_9) {
        digits++
        ch = source.charCodeAt(++i)
      }
      if (i < lineEnd && ch === CH_DOT) {
        ch = source.charCodeAt(++i)
        while (i < lineEnd && ch >= CH_0 && ch <= CH_9) {
          digits++
          ch = source.charCodeAt(++i)
        }
      }
      if (digits === 0) {
        lineError = `Word "${String.fromCharCode(CH_A + letter)}" has no number.`
        break
      }
      if (i < lineEnd && (ch === CH_E || ch === CH_e)) {
        lineError = 'Number in exponent notation is not valid G-code.'
        break
      }
      if (words === MAX_WORDS_PER_LINE) {
        lineError = `Line has more than ${MAX_WORDS_PER_LINE} words.`
        break
      }
      wordLetter[words] = letter
      wordValue[words] = Number(source.slice(numStart, i))
      words++
    }
    if (lineError) {
      // A rotary word must not slip through on a line the tokeniser gave up on.
      const rotary = rotaryWordInRawLine(lineText())
      if (rotary && (motion !== Motion.None || /G0*[0-3](?![\d.])/i.test(lineText()))) return refuse(rotary)
      warn(`${lineError} Line skipped.`)
      if (rotary) rotaryWarning(rotary)
      continue
    }
    if (words === 0) continue

    // Collect the line's words. Axis and parameter words are single-valued per line.
    let gMotion: Motion = Motion.None
    let hasX = false, hasY = false, hasZ = false, hasI = false, hasJ = false, hasR = false
    let vx = 0, vy = 0, vz = 0, vi = 0, vj = 0, vr = 0
    let fWord = NaN
    let pWord = NaN
    let dwell = false
    let sWord = NaN
    let tWord = NaN
    let toolChange = false
    let spindleWord = -1
    let skipMotion = false
    let homing = false
    let cancelMotion = false
    let unsupportedMotionCode = ''
    let skipReason = ''
    let duplicate = ''
    let rotaryWord = ''
    let nonMoving = false
    let otherCommand = false
    let newPlane: Plane = plane
    let newUnitScale = unitScale
    let newIncremental: boolean = incremental
    let newArcCentreAbsolute: boolean = arcCentreAbsolute
    const ignored: string[] = []

    for (let w = 0; w < words; w++) {
      const letter = wordLetter[w]
      const v = wordValue[w]
      switch (letter) {
        case LETTER_INDEX('G'): {
          const code = Math.round(v * 10)
          switch (code) {
            case 0: gMotion = Motion.Rapid; break
            case 10: gMotion = Motion.Linear; break
            case 20: gMotion = Motion.ArcCW; break
            case 30: gMotion = Motion.ArcCCW; break
            case 40: dwell = true; nonMoving = true; break
            case 170: newPlane = Plane.XY; break
            case 180: newPlane = Plane.XZ; break
            case 190: newPlane = Plane.YZ; break
            case 200: newUnitScale = MM_PER_INCH; break
            case 210: newUnitScale = 1; break
            case 900: newIncremental = false; break
            case 910: newIncremental = true; break
            case 901: newArcCentreAbsolute = true; break
            case 911: newArcCentreAbsolute = false; break
            case 400: case 430: case 490: case 540: case 610: case 640: case 940:
              break // modes with no effect on the drawn toolpath
            case 800: cancelMotion = true; break
            case 50: case 51: case 52: case 330: case 382: case 383: case 384: case 385: case 730: case 760:
            case 810: case 820: case 830: case 840: case 850: case 860: case 870: case 880: case 890:
              gMotion = Motion.Unsupported
              unsupportedMotionCode = `G${v}`
              break
            case 100: case 920: case 921: case 922: case 923:
              nonMoving = true // offsets and coordinate settings: axis words here do not move
              ignored.push(`G${v}`)
              break
            case 280:
              nonMoving = true
              skipMotion = true
              homing = true
              skipReason = 'G28 (return to machine home) is not drawn: the home position is not known in work coordinates.'
              break
            case 530:
              skipMotion = true
              skipReason = 'G53 (machine coordinates) is not drawn: the machine coordinates of the work origin are not known.'
              break
            default:
              ignored.push(`G${v}`)
          }
          break
        }
        case LETTER_INDEX('M'): {
          otherCommand = true
          switch (v) {
            case 3: spindleWord = SpindleState.Clockwise; break
            case 4: spindleWord = SpindleState.CounterClockwise; break
            case 5: spindleWord = SpindleState.Off; break
            case 6: toolChange = true; break
            case 0: case 1: case 2: case 7: case 8: case 9: case 30:
              break // program stop/end and coolant: no effect on the drawn toolpath
            default:
              ignored.push(`M${v}`)
          }
          break
        }
        case LETTER_INDEX('X'): if (hasX) duplicate = 'X'; hasX = true; vx = v; break
        case LETTER_INDEX('Y'): if (hasY) duplicate = 'Y'; hasY = true; vy = v; break
        case LETTER_INDEX('Z'): if (hasZ) duplicate = 'Z'; hasZ = true; vz = v; break
        case LETTER_INDEX('I'): if (hasI) duplicate = 'I'; hasI = true; vi = v; break
        case LETTER_INDEX('J'): if (hasJ) duplicate = 'J'; hasJ = true; vj = v; break
        case LETTER_INDEX('R'): if (hasR) duplicate = 'R'; hasR = true; vr = v; break
        case LETTER_INDEX('A'): case LETTER_INDEX('B'): case LETTER_INDEX('C'):
          if (!rotaryWord) rotaryWord = String.fromCharCode(CH_A + letter)
          break
        case LETTER_INDEX('F'): fWord = v; break
        case LETTER_INDEX('S'): sWord = v; otherCommand = true; break
        case LETTER_INDEX('T'): tWord = v; otherCommand = true; break
        case LETTER_INDEX('P'): pWord = v; break
        case LETTER_INDEX('N'): case LETTER_INDEX('H'): case LETTER_INDEX('D'):
          break // line number, offset numbers
        case LETTER_INDEX('K'):
          // K only matters for arcs outside G17, which are reported separately.
          break
        default:
          ignored.push(`${String.fromCharCode(CH_A + letter)}${v}`)
      }
    }

    // In a dwell block X and S give the dwell time; they are not a move or a spindle speed.
    let dwellWord: Dwell['word'] | null = null
    let dwellValue = NaN
    if (dwell) {
      if (!Number.isNaN(pWord)) [dwellWord, dwellValue] = ['P', pWord]
      else if (hasX) [dwellWord, dwellValue] = ['X', vx]
      else if (!Number.isNaN(sWord)) [dwellWord, dwellValue] = ['S', sWord]
      hasX = false
      sWord = NaN
    }

    if (rotaryWord) {
      // A line moves when it has a motion word, or continues the modal motion with axis words
      // (a bare rotary word counts, a rotary word next to M, S or T commands does not).
      const modalMove = motion !== Motion.None && !cancelMotion && (hasX || hasY || hasZ || !otherCommand)
      if (!nonMoving && (gMotion !== Motion.None || modalMove)) return refuse(rotaryWord)
      rotaryWarning(rotaryWord)
    }
    if (duplicate) {
      warn(`Word ${duplicate} appears twice. Line skipped.`)
      continue
    }
    if (ignored.length > 0) {
      warn(`Unsupported ${ignored.length === 1 ? 'word' : 'words'} ignored: ${ignored.join(' ')}.`)
    }

    // Apply in RS274 order: modes, feed, spindle speed, tool, spindle, then motion.
    plane = newPlane
    unitScale = newUnitScale
    incremental = newIncremental
    arcCentreAbsolute = newArcCentreAbsolute
    if (!Number.isNaN(fWord)) feed = fWord * unitScale
    if (!Number.isNaN(sWord)) spindleSpeed = sWord
    if (!Number.isNaN(tWord)) selectedTool = tWord
    if (toolChange) {
      if (selectedTool === NO_TOOL) warn('Tool change (M6) without a tool number (T).')
      tool = selectedTool
      toolChanges.push({ line: lineNo, tool, toolpath })
    }
    if (spindleWord >= 0) spindle = spindleWord as SpindleStateValue
    if (dwell) {
      if (dwellWord === null || !(dwellValue >= 0)) warn('Dwell (G4) without a valid P, X or S time. It is not counted in the job time.')
      else dwells.push({ line: lineNo, word: dwellWord, value: dwellValue, toolpath })
    }
    if (gMotion !== Motion.None) motion = gMotion
    if (cancelMotion) motion = Motion.None
    if (gMotion === Motion.Unsupported) unsupportedMotionName = unsupportedMotionCode

    const hasAxis = hasX || hasY || hasZ
    if (skipMotion) {
      warn(skipReason)
      if (homing || hasAxis) unstoredMotionLines++
      // Where the named axes end up is not known in work coordinates. A bare G28 homes every axis.
      const all = homing && !hasAxis
      if (all || hasX) x = NaN
      if (all || hasY) y = NaN
      if (all || hasZ) z = NaN
      continue
    }
    if (motion === Motion.Unsupported) {
      if (gMotion === Motion.Unsupported) {
        warn(`${unsupportedMotionName} is not supported. Moves are not drawn until the next G0, G1, G2 or G3.`)
      } else if (hasAxis) {
        warn(`Move in unsupported motion mode ${unsupportedMotionName} is not drawn.`)
      }
      // The machine moves in a way this parser does not model.
      if (hasAxis) {
        unstoredMotionLines++
        x = NaN
        y = NaN
        z = NaN
      }
      continue
    }
    if (!hasAxis && !hasI && !hasJ && !hasR) continue
    if (motion === Motion.None) {
      warn('Coordinates without a motion mode (G0, G1, G2 or G3). Line skipped.')
      continue
    }

    const ex = hasX ? (incremental ? x + vx * unitScale : vx * unitScale) : x
    const ey = hasY ? (incremental ? y + vy * unitScale : vy * unitScale) : y
    const ez = hasZ ? (incremental ? z + vz * unitScale : vz * unitScale) : z
    const sx = x
    const sy = y
    const sz = z
    x = ex
    y = ey
    z = ez

    const known = !(Number.isNaN(sx) || Number.isNaN(sy) || Number.isNaN(sz) ||
      Number.isNaN(ex) || Number.isNaN(ey) || Number.isNaN(ez))

    if (motion === Motion.Rapid || motion === Motion.Linear) {
      if (!known) {
        unstoredMotionLines++
        if (motion === Motion.Linear) {
          warn('Feed move starts from an unknown position and is not drawn. Move every axis with an absolute move first.')
        }
        continue
      }
      setAttrs(motion === Motion.Rapid ? MoveType.Rapid : MoveType.Feed)
      moves.push(sx, sy, sz, ex, ey, ez, attrs)
      continue
    }

    // Arc.
    if (!known) {
      unstoredMotionLines++
      warn('Arc starts from an unknown position and is not drawn. Move every axis with an absolute move first.')
      continue
    }
    if (plane !== Plane.XY) {
      warn('Arcs are only supported in the XY plane (G17). This arc is not drawn.')
      unstoredMotionLines++
      continue
    }
    const clockwise = motion === Motion.ArcCW
    let cx: number
    let cy: number
    if (hasR) {
      if (hasI || hasJ) warn('Arc has both R and I/J. The I/J centre is used.')
    }
    if (hasI || hasJ) {
      if (arcCentreAbsolute) {
        cx = hasI ? vi * unitScale : sx
        cy = hasJ ? vj * unitScale : sy
      } else {
        cx = sx + (hasI ? vi * unitScale : 0)
        cy = sy + (hasJ ? vj * unitScale : 0)
      }
      const mismatch = arcRadiusMismatch(sx, sy, ex, ey, cx, cy)
      if (mismatch !== null) {
        warn(`Arc start and end radius differ by ${mismatch.toFixed(3)} mm. The arc is drawn with a blended radius.`)
      }
    } else if (hasR) {
      const centre = arcCentreFromRadius(sx, sy, ex, ey, vr * unitScale, clockwise)
      if (!centre) {
        warn('Arc radius R cannot connect the start and end point. This arc is not drawn.')
        unstoredMotionLines++
        continue
      }
      cx = centre.cx
      cy = centre.cy
    } else {
      warn('Arc has no centre (I/J) or radius (R). This arc is not drawn.')
      unstoredMotionLines++
      continue
    }
    setAttrs(MoveType.Arc)
    let px = sx
    let py = sy
    let pz = sz
    flattenArc(sx, sy, sz, ex, ey, ez, cx, cy, clockwise, chordTolerance, (qx, qy, qz) => {
      moves.push(px, py, pz, qx, qy, qz, attrs)
      px = qx
      py = qy
      pz = qz
    })
  }

  return {
    header,
    hasMakeraHeader,
    moves: moves.finish(),
    toolChanges,
    dwells,
    unstoredMotionLines,
    warnings,
    refusal: null,
    lineCount: lineNo,
    chordToleranceMm: chordTolerance,
  }
}
