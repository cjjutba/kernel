import { describe, expect, it } from 'vitest'
import { lineCount } from '../src/renderer/src/ui/CodeLines'

describe('lineCount (KERNEL-914)', () => {
  it('counts an empty script as one line', () => {
    expect(lineCount('')).toBe(1)
  })

  it('counts a line for each newline plus the last', () => {
    expect(lineCount('pnpm install')).toBe(1)
    expect(lineCount('pnpm install\npnpm build')).toBe(2)
  })

  it('opens another line after a trailing newline, as a twelve-line script ends on line 12', () => {
    expect(lineCount('pnpm install\n')).toBe(2)
    const script = [...Array.from({ length: 11 }, (_, i) => `step ${i + 1}`), ''].join('\n')
    expect(lineCount(script)).toBe(12)
  })
})
