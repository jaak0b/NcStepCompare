/** Reads a decimal number typed with a point or a comma ("0.05" or "0,05"); NaN when empty or unreadable. */
export function parseDecimalInput(raw: string): number {
  const text = raw.trim().replace(',', '.')
  if (text === '' || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return NaN
  return Number(text)
}
