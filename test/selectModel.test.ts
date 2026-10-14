import { describe, expect, it } from 'vitest'
import { edgeIndex, flattenOptions, isGroup, nextIndex, typeaheadIndex } from '../src/renderer/src/ui/selectModel'

// KERNEL-680: the keyboard rules of the one dropdown.
const rows = (labels: string, disabled = ''): { label: string; disabled?: boolean }[] =>
  labels.split(' ').map((label, i) => ({ label, disabled: disabled.split(' ').includes(String(i)) }))

describe('flattenOptions', () => {
  it('keeps plain options and opens groups in order', () => {
    const flat = flattenOptions([{ value: 'a', label: 'A' }, { label: 'Codex', options: [{ value: 'b', label: 'B' }, { value: 'c', label: 'C' }] }])
    expect(flat.map((o) => o.value)).toEqual(['a', 'b', 'c'])
  })
  it('tells a group from an option', () => {
    expect(isGroup({ label: 'G', options: [] })).toBe(true)
    expect(isGroup({ value: 'a', label: 'A' })).toBe(false)
  })
})

describe('nextIndex', () => {
  it('moves one row and wraps round both ways', () => {
    const r = rows('a b c')
    expect(nextIndex(r, 0, 1)).toBe(1)
    expect(nextIndex(r, 2, 1)).toBe(0)
    expect(nextIndex(r, 0, -1)).toBe(2)
  })
  it('skips rows that are disabled', () => {
    expect(nextIndex(rows('a b c', '1'), 0, 1)).toBe(2)
    expect(nextIndex(rows('a b c', '0'), 1, -1)).toBe(2)
  })
  it('gives -1 when nothing can be picked', () => {
    expect(nextIndex(rows('a b', '0 1'), 0, 1)).toBe(-1)
    expect(nextIndex([], 0, 1)).toBe(-1)
  })
})

describe('edgeIndex', () => {
  it('finds the first and last rows that can be picked', () => {
    const r = rows('a b c d', '0 3')
    expect(edgeIndex(r, 'first')).toBe(1)
    expect(edgeIndex(r, 'last')).toBe(2)
  })
})

describe('typeaheadIndex', () => {
  const r = rows('Sonnet Opus Haiku Opus-plan')
  it('jumps to the next row starting with the letter, case-insensitive', () => {
    expect(typeaheadIndex(r, 'o', 0)).toBe(1)
    expect(typeaheadIndex(r, 'H', 0)).toBe(2)
  })
  it('cycles through rows when the same letter is typed again', () => {
    expect(typeaheadIndex(r, 'o', 1)).toBe(3)
    expect(typeaheadIndex(r, 'oo', 3)).toBe(1)
  })
  it('keeps the current row while a longer query still matches', () => {
    expect(typeaheadIndex(r, 'opus-', 3)).toBe(3)
  })
  it('skips disabled rows and gives -1 on no match', () => {
    expect(typeaheadIndex(rows('Alpha Apple', '1'), 'a', 0)).toBe(0)
    expect(typeaheadIndex(r, 'z', 0)).toBe(-1)
    expect(typeaheadIndex(r, '', 0)).toBe(-1)
  })
})
