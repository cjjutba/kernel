import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { Refused, SHARED_DIR, sizeLabel, type ShareRequest, type ShareResult } from './sharedFiles'

export interface SharedToolDeps {
  /** Kernel's share for the calling chat: checks the file, keeps the version, and puts the card in the chat. Throws Refused. */
  share: (o: ShareRequest) => Promise<ShareResult>
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

export const SHARE_DESCRIPTION = `Share a file with the user as a card in this chat, which they open in a tab. Takes HTML, images (PNG, JPEG, GIF, WebP, SVG), PDF and Markdown. HTML must be one self-contained file: inline the CSS and JS and use data: URLs for images, since the preview has no network. Save files under ${SHARED_DIR}/ in your workspace, which git ignores. Share the same path again to add a version.`

/** The warning added when an HTML file's outside references won't load in the preview. */
export const outsideNote = (n: number) => `${n === 1 ? '1 reference' : `${n} references`} to other files or the network won't load: the preview has no network. Inline the CSS and JS and use data: URLs for images, then share it again.`

/** share_file, which every agent gets while sharing is on (KERNEL-302), apart from the server so tests can call it. */
export function sharedTools(d: SharedToolDeps) {
  return [
    tool('share_file', SHARE_DESCRIPTION, {
      path: z.string().describe(`Path relative to your workspace, for example "${SHARED_DIR}/checkout.html"`),
      title: z.string().optional().describe("The card's title. Left out: the HTML's <title>, the Markdown's first # heading, or the file name"),
      note: z.string().optional().describe('What changed in this version, in one line')
    }, async ({ path, title, note }) => {
      try {
        const r = await d.share({ path, title, note })
        const { file, version } = r
        if (r.status === 'same') return text(`Already shared: "${file.title}" v${version.n} is the same file, so there is no new version.`)
        const warn = version.outside ? ` ${outsideNote(version.outside)}` : ''
        return text(`Shared "${file.title}" as v${version.n} (${r.label}, ${sizeLabel(version.bytes)}). The user sees a card for it in this chat and can open it in a tab. Share the same path again after changes to add a version.${warn}`)
      } catch (e) {
        const why = e instanceof Refused ? e.message : `Kernel couldn't share it (${e instanceof Error ? e.message : String(e)}).`
        return { ...text(`Not shared: ${why}`), isError: true }
      }
    })
  ]
}
