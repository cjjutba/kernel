import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { run } from '../src/main/services/exec'
import { searchFiles } from '../src/main/services/files'
import { planName, savePlan } from '../src/main/services/plans'

// D-085: plan-mode plans are saved as files a later chat can build from, and git never sees them.

const status = async (repo: string) => (await run('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'])).trim()
const PLAN = '# Export invoices as PDF\n\n## Context\nThe table has row actions.\n\n## Steps\n1. Renderer\n2. Button\n'

describe('saved plans', () => {
  it('names the file after the opening heading, or the fallback without one', () => {
    expect(planName(PLAN, 'Plan for lead')).toBe('export-invoices-as-pdf')
    expect(planName('1. Do it\n2. Test it', 'Plan for invoice-table')).toBe('plan-for-invoice-table')
    expect(planName('## KERNEL-83 Fix batch B1: floor renderer, sequence and moments', 'x')).toBe('kernel-83-fix-batch-b1-floor-renderer-sequence-and-moments')
    expect(planName('# ¿¿??', '!!')).toBe('plan')
  })

  it('writes the plan under .kernel/plans and keeps it out of git', async () => {
    const repo = await tempRepo()
    const file = await savePlan(repo, PLAN, { fallback: 'Plan for lead' })
    expect(file).toBe('.kernel/plans/export-invoices-as-pdf.md')
    expect(await readFile(join(repo, file), 'utf8')).toBe(PLAN)
    expect(await status(repo)).toBe('')
  })

  it('overwrites a revision in place, and gives a new plan with the same title a file of its own', async () => {
    const repo = await tempRepo()
    const first = await savePlan(repo, PLAN, { fallback: 'x' })
    const revised = await savePlan(repo, `${PLAN}3. Tests`, { fallback: 'x', reuse: first })
    expect(revised).toBe(first)
    expect(await readFile(join(repo, first), 'utf8')).toContain('3. Tests')
    const another = await savePlan(repo, PLAN, { fallback: 'x' })
    expect(another).toBe('.kernel/plans/export-invoices-as-pdf-2.md')
    // A reuse path that isn't a saved plan is ignored rather than written to.
    expect(await savePlan(repo, PLAN, { fallback: 'x', reuse: '../outside.md' })).toBe('.kernel/plans/export-invoices-as-pdf-3.md')
  })

  it('lists saved plans in the @ menu even though git ignores them', async () => {
    const repo = await tempRepo()
    await savePlan(repo, PLAN, { fallback: 'x' })
    expect((await searchFiles(repo, 'exportpdf')).map((f) => f.path)).toContain('.kernel/plans/export-invoices-as-pdf.md')
  })
})
