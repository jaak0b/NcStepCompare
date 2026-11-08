// Cutter lower profile: the height of the tool's cutting surface above its tip at radial distance r
// from the tool axis, for 0 <= r <= radius. Every profile here is convex and non-decreasing in r,
// which the sweep relies on.

export type CutterShapeKind = 'flat end mill' | 'ball end' | 'drill' | 'V-bit' | 'thread mill'

export interface CutterShape {
  kind: CutterShapeKind
  /** Cutting diameter in mm. */
  diameter: number
  /** Corner radius in mm (flat end mill only: above 0 gives a bull nose). */
  cornerRadius: number
  /** Included tip angle in degrees (drill and V-bit). */
  tipAngle: number
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
}

/** Returns the profile, or an error message when the shape's values cannot describe a cutter. */
export function cutterProfile(shape: CutterShape): CutterProfile | string {
  const radius = shape.diameter / 2
  if (!(radius > 0) || !Number.isFinite(radius)) return 'Diameter must be above 0 mm.'
  switch (shape.kind) {
    case 'flat end mill': {
      const rc = shape.cornerRadius
      if (!(rc >= 0) || rc > radius) return 'Corner radius must be between 0 mm and half the diameter.'
      if (rc === 0) return { form: ProfileForm.Flat, radius, cornerRadius: 0, coneSlope: 0 }
      if (rc === radius) return { form: ProfileForm.Ball, radius, cornerRadius: radius, coneSlope: 0 }
      return { form: ProfileForm.BullNose, radius, cornerRadius: rc, coneSlope: 0 }
    }
    case 'thread mill':
      // Modelled as a cylinder of its cutting diameter.
      return { form: ProfileForm.Flat, radius, cornerRadius: 0, coneSlope: 0 }
    case 'ball end':
      return { form: ProfileForm.Ball, radius, cornerRadius: radius, coneSlope: 0 }
    case 'drill':
    case 'V-bit': {
      const a = shape.tipAngle
      if (!(a > 0 && a < 180)) return 'Tip angle must be between 0 and 180 degrees.'
      return { form: ProfileForm.Cone, radius, cornerRadius: 0, coneSlope: 1 / Math.tan((a * Math.PI) / 360) }
    }
  }
}

/** Height of the cutting surface above the tip at radial distance r (0 <= r <= radius). */
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
