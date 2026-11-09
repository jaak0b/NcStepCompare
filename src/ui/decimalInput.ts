/**
 * Why a typed decimal number cannot be read, or null when it can. A point or a comma is the decimal
 * separator. Input that looks like a thousands group ("3,000", "1,500", "3.000") or has more than
 * one separator is refused, because it could mean two different numbers.
 */
export function decimalInputProblem(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return 'Enter a number.'
  if ((text.match(/[.,]/g) ?? []).length > 1) {
    return `"${text}" has more than one separator. Enter one decimal point or comma and no thousands separators, for example 3000 or 0.05.`
  }
  if (!/^[+-]?(\d+[.,]?\d*|[.,]\d+)$/.test(text)) return `"${text}" is not a number.`
  // A comma before exactly three digits, or ".000", reads as a thousands group in many locales.
  // A point before other digits ("3.175") is a decimal: tool sizes are written that way.
  if (/^[+-]?[1-9]\d{0,2}(,\d{3}|\.000)$/.test(text)) {
    return `"${text}" could be a decimal number or a thousands group. Enter it without the separator, or with a decimal point and no trailing zeros (for example 3000, 3 or 3.175).`
  }
  return null
}

/** Reads a decimal number typed with a point or a comma ("0.05" or "0,05"); NaN when empty, unreadable or ambiguous. */
export function parseDecimalInput(raw: string): number {
  if (decimalInputProblem(raw) !== null) return NaN
  return Number(raw.trim().replace(',', '.'))
}
