// Cutter profile: the tool is a solid of revolution, its cutting part described by the radius r(h)
// at height h above the tip. The profile is split at each local minimum of r into bands where r is
// unimodal, so at a distance d from the tool axis a band occupies one height interval [a(d), b(d)],
// with a non-decreasing and convex and b non-increasing and concave in d. The sweep relies on this.
//
// Classic cutters (flat end mill, bull nose, ball end, drill, V-bit, and a thread mill without a
// pitch) are one band reaching up without end: the lower boundary is `profileHeight`, and everything
// above it is the cutter, as the height grid has always modelled them.
// A thread mill with a pitch has one band per tooth (ISO 68-1 basic profile: trapezoid teeth with
// straight flanks). Its neck and shank do not cut, so the band ends at the top of the tooth.

export type CutterShapeKind = 'flat end mill' | 'ball end' | 'drill' | 'V-bit' | 'thread mill'
export const CUTTER_SHAPE_KINDS: CutterShapeKind[] = ['flat end mill', 'ball end', 'drill', 'V-bit', 'thread mill']

export interface CutterShape {
  kind: CutterShapeKind
  /** Cutting diameter in mm. */
  diameter: number
  /** Corner radius in mm (flat end mill only: above 0 gives a bull nose). */
  cornerRadius: number
  /** Included tip angle in degrees (drill and V-bit). */
  tipAngle: number
  /**
   * Thread mill tooth data (thread mill only). Without a pitch the thread mill is modelled as a
   * cylinder of its cutting diameter.
   */
  pitch?: number
  /** Included angle between the tooth flanks, degrees. */
  profileAngle?: number
  /** Number of teeth, spaced one pitch apart along the axis. */
  teeth?: number
  /** Axial width of the flat at the tooth tip, mm. */
  toothTipFlat?: number
  /** Diameter of the non-cutting neck above (and between) the teeth, mm. */
  neckDiameter?: number
  /** Axial distance from the tool tip to the centre of the lowest tooth, mm. */
  toothOffset?: number
}

/** A point of a band boundary: radius r at height h above the tool tip, mm. */
export interface ProfilePoint {
  r: number
  h: number
}

/**
 * One band of the profile. At distance d from the axis (d <= rMax) the band occupies [a(d), b(d)].
 * a(d): linear between the `lower` points (r increasing), equal to the first point's h for d below
 * its r. b(d): the same over the `upper` points. `lower` null means the classic form profile
 * (`profileHeight`); `upper` empty means the band reaches up without end.
 */
export interface ProfileBand {
  lower: ProfilePoint[] | null
  upper: ProfilePoint[]
  rMax: number
}

/** Numeric profile form used in the sweep's inner loop. */
export const ProfileForm = { Flat: 0, BullNose: 1, Ball: 2, Cone: 3 } as const
export type ProfileFormValue = (typeof ProfileForm)[keyof typeof ProfileForm]

export interface CutterProfile {
  form: ProfileFormValue
  radius: number
  /** Bull nose: corner radius. Ball: equals radius. */
  cornerRadius: number
  /** Cone: height gained per mm of radius, 1 / tan(tipAngle / 2). */
  coneSlope: number
  /** Bands from the tip upwards; one open classic band for every cutter without a tooth profile. */
  bands: ProfileBand[]
  /** True when the profile is one open classic band, the height grid's own cutter model. */
  classic: boolean
}

function classic(form: ProfileFormValue, radius: number, cornerRadius: number, coneSlope: number): CutterProfile {
  return { form, radius, cornerRadius, coneSlope, bands: [{ lower: null, upper: [], rMax: radius }], classic: true }
}

/** Fundamental triangle height of a thread form: H = P / (2 tan(angle / 2)); ISO 68-1: 0.866 P. */
export function threadTriangleHeight(pitch: number, profileAngle: number): number {
  return pitch / (2 * Math.tan((profileAngle * Math.PI) / 360))
}

/**
 * Thread mill teeth as bands. Each tooth is a trapezoid: the tip flat at the cutting radius, flanks
 * at half the profile angle from the radial direction down to the neck radius.
 */
function threadMillProfile(shape: CutterShape, radius: number): CutterProfile | string {
  const pitch = shape.pitch!
  const angle = shape.profileAngle ?? NaN
  const teeth = shape.teeth ?? NaN
  const flat = shape.toothTipFlat ?? NaN
  const neckRadius = (shape.neckDiameter ?? NaN) / 2
  const offset = shape.toothOffset ?? NaN
  if (!(pitch > 0) || !Number.isFinite(pitch)) return 'Enter a thread pitch above 0 mm.'
  if (!(angle > 0 && angle < 180)) return 'Enter a profile angle between 0 and 180 degrees.'
  if (!Number.isInteger(teeth) || teeth < 1) return 'Enter a number of teeth of 1 or more.'
  if (!(flat >= 0)) return 'Enter a tooth tip flat of 0 mm or more.'
  if (!(neckRadius >= 0 && neckRadius < radius)) return 'Enter a neck diameter of 0 mm or more, below the cutting diameter.'
  const run = (radius - neckRadius) * Math.tan((angle * Math.PI) / 360)
  const half = flat / 2 + run
  if (teeth > 1 && 2 * half > pitch) return 'The teeth overlap: the tooth base is wider than the pitch. Check the tip flat, profile angle and neck diameter.'
  if (!(offset >= half - 1e-12)) return `Enter a tip-to-tooth offset of at least ${+half.toFixed(4)} mm, so the lowest tooth does not reach below the tool tip.`
  const bands: ProfileBand[] = []
  for (let k = 0; k < teeth; k++) {
    const c = offset + k * pitch
    bands.push({
      lower: [
        { r: neckRadius, h: c - half },
        { r: radius, h: c - flat / 2 },
      ],
      upper: [
        { r: neckRadius, h: c + half },
        { r: radius, h: c + flat / 2 },
      ],
      rMax: radius,
    })
  }
  return { form: ProfileForm.Flat, radius, cornerRadius: 0, coneSlope: 0, bands, classic: false }
}

/** Returns the profile, or an error message when the shape's values cannot describe a cutter. */
export function cutterProfile(shape: CutterShape): CutterProfile | string {
  const radius = shape.diameter / 2
  if (!(radius > 0) || !Number.isFinite(radius)) return 'Enter a diameter above 0 mm.'
  switch (shape.kind) {
    case 'flat end mill': {
      const rc = shape.cornerRadius
      if (!(rc >= 0) || rc > radius) return 'Enter a corner radius between 0 mm and half the diameter.'
      if (rc === 0) return classic(ProfileForm.Flat, radius, 0, 0)
      if (rc === radius) return classic(ProfileForm.Ball, radius, radius, 0)
      return classic(ProfileForm.BullNose, radius, rc, 0)
    }
    case 'thread mill':
      // Without a pitch: a cylinder of its cutting diameter.
      if (shape.pitch === undefined || Number.isNaN(shape.pitch)) return classic(ProfileForm.Flat, radius, 0, 0)
      return threadMillProfile(shape, radius)
    case 'ball end':
      return classic(ProfileForm.Ball, radius, radius, 0)
    case 'drill':
    case 'V-bit': {
      const a = shape.tipAngle
      if (!(a > 0 && a < 180)) return 'Enter a tip angle between 0 and 180 degrees.'
      return classic(ProfileForm.Cone, radius, 0, 1 / Math.tan((a * Math.PI) / 360))
    }
  }
}

/**
 * Height of the cutting surface above the tip at radial distance r (0 <= r <= radius). This is the
 * one implementation of the profile; the sweep calls it in its inner loop.
 */
export function profileHeight(p: CutterProfile, r: number): number {
  switch (p.form) {
    case ProfileForm.Flat:
      return 0
    case ProfileForm.Ball:
      return p.radius - Math.sqrt(Math.max(0, p.radius * p.radius - r * r))
    case ProfileForm.BullNose: {
      const flat = p.radius - p.cornerRadius
      if (r <= flat) return 0
      const u = r - flat
      return p.cornerRadius - Math.sqrt(Math.max(0, p.cornerRadius * p.cornerRadius - u * u))
    }
    case ProfileForm.Cone:
      return r * p.coneSlope
  }
  return 0
}

/** a(d) or b(d) of a band boundary given by points (see ProfileBand), for d <= the last point's r. */
export function boundaryHeight(points: ProfilePoint[], d: number): number {
  if (d <= points[0].r) return points[0].h
  for (let k = 1; k < points.length; k++) {
    const p = points[k]
    if (d <= p.r) {
      const q = points[k - 1]
      return q.h + ((d - q.r) * (p.h - q.h)) / (p.r - q.r)
    }
  }
  return points[points.length - 1].h
}
