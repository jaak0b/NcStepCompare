import type { ValueSource } from '../engine/toolTable'

/** Where a value came from, worded the same everywhere in the UI. */
export const SOURCE_LABEL: Record<ValueSource, string> = {
  header: 'from the file header',
  assumed: 'assumed, default',
  user: 'assumed, user entry',
  missing: 'missing',
}
