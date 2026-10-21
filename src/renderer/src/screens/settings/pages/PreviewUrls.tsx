import { useState, type FormEvent } from 'react'
import { resolvePreviewUrl } from '@shared/previewUrl'
import { PORT_BLOCK, type ProjectSettings } from '@shared/types'
import { Button, Modal, useBusy } from '../../../ui'
import { Row, Section } from '../kit'
import { patchProjectSettings } from '../useSettings'
import './envScripts.css'

type Urls = ProjectSettings['preview']['urls']

/** The rows worth saving: one with no address is dropped, since the file keeps none (KERNEL-246). */
export const savedUrls = (list: Urls): Urls => list.filter((u) => u.url.trim()).map((u) => ({ name: u.name.trim(), url: u.url.trim() }))

/** What is wrong with an address, or undefined. A port form Kernel can't fill counts, so Open never gets a half-filled address. */
export function addressProblem(address: string): string | undefined {
  if (!address.trim()) return 'Enter the address to open.'
  // Any port in the workspace's block does for the check: the form is what matters.
  if (!resolvePreviewUrl(address, 4300)) return `Use an http or https address. $KERNEL_PORT to $((KERNEL_PORT + ${PORT_BLOCK - 1})) work in it.`
  return undefined
}

/** Preview URLs on Settings > a project > Scripts (KERNEL-914): a row each with Edit and Remove. The list is saved whole in the personal file, so Remove works on rows settings.toml set too. */
export function PreviewUrls({ projectId, rs }: { projectId: string; rs: ProjectSettings | null }) {
  // `index` is the row being edited, or the list's length for a new one.
  const [editing, setEditing] = useState<number | null>(null)
  const urls = rs?.preview?.urls ?? []
  const path = 'preview.urls'
  const save = (next: Urls) => patchProjectSettings(projectId, { preview: { urls: savedUrls(next) } })
  return (
    <>
      <Section
        id="preview-urls" title="Preview URLs"
        action={<span className="rm-aside-act">
          {rs?.sources?.[path] === 'override' && <Button variant="ghost" aria-label="Reset preview URLs" onClick={() => void patchProjectSettings(projectId, { preview: { urls: null } })}>Reset</Button>}
          <Button icon="plus" onClick={() => setEditing(urls.length)}>Add preview URL</Button>
        </span>}
      >
        {urls.length === 0 && <p className="set-empty">No preview URLs. Add one and Open in a workspace goes to it.</p>}
        {urls.map((u, i) => {
          const label = u.name || 'Unnamed'
          return (
            <Row key={i} className="rm-urlrow" label={label} desc={u.url}>
              <span className="set-actions">
                <Button variant="ghost" aria-label={`Edit ${label}`} onClick={() => setEditing(i)}>Edit</Button>
                <Button variant="ghost" aria-label={`Remove ${label}`} onClick={() => void save(urls.filter((_, j) => j !== i))}>Remove</Button>
              </span>
            </Row>
          )
        })}
      </Section>
      {editing !== null && <PreviewUrlForm urls={urls} index={editing} onSave={save} onClose={() => setEditing(null)} />}
    </>
  )
}

/** Add or edit one preview URL. A save writes the whole list. */
function PreviewUrlForm({ urls, index, onSave, onClose }: { urls: Urls; index: number; onSave: (next: Urls) => Promise<unknown>; onClose: () => void }) {
  const current = urls[index]
  const [name, setName] = useState(current?.name ?? '')
  const [url, setUrl] = useState(current?.url ?? '')
  const [shown, setShown] = useState(false)
  const [busy, run] = useBusy<'save'>()
  const problem = addressProblem(url)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setShown(true)
    if (problem) return
    void run('save', async () => {
      const row = { name: name.trim(), url: url.trim() }
      await onSave(current ? urls.map((u, i) => (i === index ? row : u)) : [...urls, row])
      onClose()
    })
  }
  return (
    <Modal
      title={current ? `Edit ${current.name || 'preview URL'}` : 'Add preview URL'}
      onClose={onClose}
      width={480}
      top={200}
      footer={<>
        <span className="grow" />
        <Button variant="ghost" size="lg" data-dismiss>Cancel</Button>
        <Button variant="primary" size="lg" type="submit" form="preview-url-form" busy={busy === 'save'} busyLabel="Saving">Save</Button>
      </>}
    >
      <form id="preview-url-form" className="modal-body set-form" onSubmit={submit} noValidate>
        <p className="set-help">Open in a workspace goes to the first one. Saved in settings.local.toml, so it stays on your Mac.</p>
        <div className="set-field">
          <label htmlFor="preview-url-name">Name</label>
          <input id="preview-url-name" className="input set-text-input" autoComplete="off" placeholder="Web app" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="set-field">
          <label htmlFor="preview-url-address">Address</label>
          <input id="preview-url-address" className="input" autoComplete="off" spellCheck={false} placeholder="http://localhost:$KERNEL_PORT" value={url} aria-invalid={shown && !!problem} aria-describedby="preview-url-address-note" onChange={(e) => setUrl(e.target.value)} />
          {shown && problem
            ? <span id="preview-url-address-note" role="alert" className="set-error">{problem}</span>
            : <span id="preview-url-address-note" className="set-help">$KERNEL_PORT is the first of the workspace’s {PORT_BLOCK} ports. Use $((KERNEL_PORT + 1)) for the next.</span>}
        </div>
      </form>
    </Modal>
  )
}
