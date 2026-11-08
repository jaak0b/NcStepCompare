import type { ValueSource } from '../engine/toolTable'

/** Source of a setting that is either a default or entered by the user. */
export type SettingSource = 'assumed' | 'user'

/** Where a value came from, worded the same everywhere in the UI. */
export const SOURCE_LABEL: Record<ValueSource, string> = {
  header: 'from the file header',
  assumed: 'assumed, default',
  user: 'assumed, user entry',
  saved: 'assumed, saved edit',
  missing: 'missing',
}
