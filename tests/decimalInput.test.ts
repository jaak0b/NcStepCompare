import { describe, expect, it } from 'vitest'
import { decimalInputProblem, parseDecimalInput } from '../src/ui/decimalInput'

describe('decimal input', () => {
  it('reads a decimal point or comma, including three decimals after a point', () => {
    expect(parseDecimalInput('0,05')).toBe(0.05)
    expect(parseDecimalInput(' 3.175 ')).toBe(3.175)
    expect(parseDecimalInput('3000')).toBe(3000)
  })

  it('refuses input that could be a thousands group, with a reason', () => {
    for (const raw of ['3,000', '3.000', '1,500', '1.234,5', '1,234.5']) {
      expect(parseDecimalInput(raw)).toBeNaN()
      expect(decimalInputProblem(raw)).toMatch(/separator|thousands/)
    }
  })
})
