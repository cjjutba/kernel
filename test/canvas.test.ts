import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = join(__dirname, '..', 'design', 'canvas', 'project')
const pages = readdirSync(dir).filter((f) => f.endsWith('.dc.html')).sort()
const canvas = JSON.parse(readFileSync(join(dir, 'canvas.json'), 'utf8')) as {
  boards: Record<string, unknown>
  order: string[]
}
const boards = Object.keys(canvas.boards)

describe('design canvas', () => {
  it('has a board for every page', () => {
    expect(pages.filter((p) => !boards.includes(p))).toEqual([])
  })

  it('has an order entry for every page', () => {
    expect(pages.filter((p) => !canvas.order.includes(p))).toEqual([])
  })

  it('lists each page once in order', () => {
    expect(canvas.order.filter((p, i) => canvas.order.indexOf(p) !== i)).toEqual([])
  })

  it('has no board for a page that does not exist', () => {
    expect(boards.filter((b) => !pages.includes(b))).toEqual([])
  })

  it('has no order entry for a page that does not exist', () => {
    expect(canvas.order.filter((p) => !pages.includes(p))).toEqual([])
  })
})
