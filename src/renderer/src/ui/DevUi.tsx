import { useRef, useState } from 'react'
import { Avatar, Banner, Button, Card, Chip, CodeBlock, ConfirmDialog, EmptyState, Icon, IconButton, Kbd, Menu, MENU_SEPARATOR, Meter, Modal, Pill, Popover, SegmentedControl, Select, Skeleton, Spinner, Tabs, Toast, Toggle, bannerIcon, iconNames } from './index'
import type { BannerKind, DevUiPage } from '@shared/types'

const kinds = Object.keys(bannerIcon) as BannerKind[]
const bannerCopy: Record<BannerKind, string> = {
  limit: 'Session limit reached', context: 'Context is nearly full', offline: 'You are offline', auth: 'Sign in to Claude again',
  setup: 'Setup failed', hooks: 'Hooks are not connected', retry: 'Retrying the request'
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3>{title}</h3>{children}</section>
}

function Controls() {
  const [tab, setTab] = useState('chat')
  const [seg, setSeg] = useState('dark')
  const [on, setOn] = useState(true)
  const [pill, setPill] = useState(true)
  return (
    <>
      <Section title="Buttons">
        <div className="devui-row">
          <Button variant="primary">Approve</Button><Button>Deny</Button><Button variant="ghost">Cancel</Button>
          <Button variant="danger">Discard</Button><Button variant="merged" icon="pr">Merged</Button><Button disabled>Disabled</Button>
          <Button variant="primary" busy busyLabel="Archiving">Archive</Button>
          <IconButton icon="plus" label="Add" /><IconButton icon="more" label="More" /><IconButton icon="archive" label="Archive" busy busyLabel="Archiving" />
        </div>
      </Section>
      <Section title="Pills, tabs, segmented control, toggle, select">
        <div className="devui-row">
          <Pill pressed={pill} onClick={() => setPill(!pill)}>All rooms</Pill><Pill>Needs you</Pill>
          <Tabs label="Panels" value={tab} onChange={setTab} tabs={[{ id: 'chat', label: 'Chat' }, { id: 'changes', label: 'Changes' }, { id: 'files', label: 'Files' }]} />
        </div>
        <div className="devui-row" style={{ marginTop: 10 }}>
          <SegmentedControl label="Theme" value={seg} onChange={setSeg} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
          <Toggle label="Reduce motion" checked={on} onChange={setOn} /><Toggle label="Pointer cursors" checked={false} onChange={() => undefined} />
          <Select label="Font size" defaultValue="default" options={[{ value: 'default', label: 'Default' }, { value: 'small', label: 'Small' }]} />
        </div>
      </Section>
      <Section title="Chips">
        <div className="devui-row"><Chip kind="file" onRemove={() => undefined}>plan.md</Chip><Chip kind="image" onRemove={() => undefined}>screenshot.png</Chip><Chip kind="mention">Noor</Chip><Chip kind="skill">review</Chip></div>
      </Section>
      <Section title="Meter, code, kbd, avatar, spinner, skeleton">
        <div className="col" style={{ gap: 10 }}>
          <div className="col" style={{ gap: 6 }}><Meter label="Session, 40%" value={0.4} /><Meter label="Weekly, 85%" value={0.85} /><Meter label="Session, 100%" value={1} /></div>
          <CodeBlock>{'npm run shots -- Home'}</CodeBlock>
          <div className="devui-row"><Kbd>⌘K</Kbd><Kbd>⇧⌘N</Kbd><Avatar name="Client A" /><Avatar name="Rowan" size={28} solid /><Spinner /><Skeleton width={120} /></div>
        </div>
      </Section>
      <Section title="Card, empty state">
        <div className="devui-row" style={{ alignItems: 'stretch' }}>
          <Card style={{ padding: 12, flex: 1 }}><b style={{ fontWeight: 600 }}>Client A</b><div className="muted">5 agents</div></Card>
          <Card style={{ flex: 1 }}><EmptyState icon="inbox" title="Nothing needs you" action={<Button>New workspace</Button>}>Approvals and plans show up here.</EmptyState></Card>
        </div>
      </Section>
    </>
  )
}

function Display() {
  return (
    <>
      <Section title="Banners">
        <div className="col" style={{ gap: 6 }}>{kinds.map((k) => <Banner key={k} kind={k} title={bannerCopy[k]} actions={<Button size="md">Open</Button>}>One neutral surface for every failure.</Banner>)}</div>
      </Section>
      <Section title={`Icons (${iconNames().length})`}>
        <div className="devui-icons">{iconNames().map((n) => <span key={n} title={n}><Icon name={n} /></span>)}</div>
      </Section>
    </>
  )
}

function Overlays() {
  const noop = () => undefined
  const anchor = useRef<HTMLSpanElement>(null)
  return (
    <>
      <Section title="Menu with shortcuts and a submenu">
        <div className="devui-stage" style={{ minHeight: 190 }}>
          <Menu label="Workspace" initiallyOpen="open" onClose={noop} style={{ position: 'relative', width: 240 }} items={[
            { id: 'new', label: 'New workspace', icon: 'compose', shortcut: '⇧⌘N' },
            { id: 'open', label: 'Open in', icon: 'ext', children: [{ id: 'term', label: 'Terminal', icon: 'term' }, { id: 'code', label: 'Editor', icon: 'code' }] },
            MENU_SEPARATOR,
            { id: 'arch', label: 'Archive', icon: 'trash', shortcut: '⌘⌫' },
            { id: 'off', label: 'Unavailable', disabled: true }
          ]} />
        </div>
      </Section>
      <Section title="Popover">
        <div className="devui-stage" style={{ minHeight: 140 }}>
          <span ref={anchor}><Button aria-expanded="true">Branch</Button></span>
          <Popover open onClose={noop} label="Branch" anchorRef={anchor}>Base branch <span className="mono">origin/main</span></Popover>
        </div>
      </Section>
      <Section title="Toast, bottom right, 2.6s">
        <div className="devui-stage" style={{ minHeight: 70 }}><div className="toast-stack"><Toast title="Branch copied" sub="samrivera/kernel-9" action={{ label: 'Undo' }} /></div></div>
      </Section>
    </>
  )
}

function Dialogs() {
  const noop = () => undefined
  return (
    <>
      <Section title="Modal shell and confirm dialog">
        <div className="devui-stage" style={{ minHeight: 330 }}>
          <Modal title="New room" onClose={noop} width={420} top={14} footer={<><span className="grow" /><Button>Cancel</Button><Button variant="primary">Create</Button></>}>
            <div className="modal-body ink2">One shell for every dialog.</div>
          </Modal>
        </div>
        <div className="devui-stage" style={{ minHeight: 190 }}>
          <ConfirmDialog title="Discard this workspace?" body="Its worktree and branch are deleted. This cannot be undone." confirmLabel="Discard" danger onConfirm={noop} onCancel={noop} />
        </div>
      </Section>
    </>
  )
}

const pages = { components: Controls, display: Display, overlays: Overlays, dialogs: Dialogs }

/** Every component in both themes (`#/dev/ui/<page>` in dev; fixtures DevUi, DevUiDisplay, DevUiOverlays and DevUiDialogs for the harness). */
export function DevUi({ page = 'components' }: { page?: DevUiPage }) {
  const Page = pages[page]
  return (
    <div className="devui" aria-label="Component gallery">
      <nav className="devui-nav" aria-label="Gallery pages">
        {(Object.keys(pages) as DevUiPage[]).map((p) => <a key={p} href={`#/dev/ui/${p}`} aria-current={p === page ? 'page' : undefined}>{p[0].toUpperCase() + p.slice(1)}</a>)}
      </nav>
      <div className="devui-cols">
        <div className="devui-col" data-theme="dark"><Page /></div>
        <div className="devui-col" data-theme="light"><Page /></div>
      </div>
    </div>
  )
}
