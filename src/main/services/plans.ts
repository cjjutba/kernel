import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Approval } from '@shared/types'
import { excludeFromGit } from './settings'

/**
 * Plan-mode plans as files (D-092). Each plan is written to `.kernel/plans/plan.md` in its workspace folder, so any chat
 * there can build from it (`@.kernel/plans/plan.md`) after the card is gone: a closed tab, /clear, a restart. The folder
 * goes in `info/exclude` like `.kernel/settings.local.toml`, so a plan never shows in Changes or lands in a PR.
 */
export const PLANS_DIR = '.kernel/plans'

const exists = (path: string) => access(path).then(() => true, () => false)

/**
 * Writes the plan and returns its path relative to `root`. `reuse` is the file an earlier version of the same plan went
 * to (a revision after "Request changes"), which is overwritten. A new plan never overwrites another one: it takes the
 * next free name of `plan.md`, `plan-2.md` and up (KERNEL-767).
 */
export async function savePlan(root: string, text: string, o: { reuse?: string } = {}): Promise<string> {
  await excludeFromGit(root, `${PLANS_DIR}/`)
  await mkdir(join(root, PLANS_DIR), { recursive: true })
  let file = o.reuse && /^\.kernel\/plans\/[^/]+\.md$/.test(o.reuse) ? o.reuse : undefined
  if (!file) {
    for (let n = 1; ; n++) {
      file = `${PLANS_DIR}/${n === 1 ? 'plan' : `plan-${n}`}.md`
      if (!(await exists(join(root, file)))) break
    }
  }
  await writeFile(join(root, file), text.endsWith('\n') ? text : `${text}\n`)
  return file
}

export const planExists = (root: string, file: string) => exists(join(root, file))

/**
 * Where a new plan-mode plan in a chat is saved, from ExitPlanMode or the Lead's request_plan_approval (D-092, KERNEL-373).
 * After "Request changes" the revision overwrites the last plan's file. Once a plan there was approved, the next one gets a
 * file of its own. `approvals` are the project's, newest first, read before the new plan's approval is added.
 */
export function revisedPlanFile(approvals: Approval[], chatId: string): string | undefined {
  const last = approvals.find((a) => a.chatId === chatId && a.kind === 'plan')
  return last && last.status !== 'allowed' ? last.planFile : undefined
}

// Attachments moved to ./attachments (KERNEL-908). Re-exported so existing imports keep working.
export {
  ATTACHMENTS_DIR, IMAGE_DATA_URL, IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE, attachedFiles, attachmentNote, hasUnsavedImages, imageMarker, imagePart, imagesNote,
  nativeDownscale, saveAttachments, withImageFiles, type Downscale, type Scaled
} from './attachments'
