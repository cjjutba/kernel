import type { ReactNode } from 'react'
import { Icon, type IconName } from '../../ui'

/** What a new chat offers to start with, by who you're talking to (KERNEL-274): the Lead plans and checks on the team. */
export const LEAD_SUGGESTIONS: { text: string; icon: IconName }[] = [{ text: 'Plan the next issues', icon: 'issues' }, { text: 'Who is blocked right now?', icon: 'team' }, { text: 'Review the open pull requests', icon: 'pr' }]
export const SUGGESTIONS: { text: string; icon: IconName }[] = [{ text: 'Review the diff so far', icon: 'branch' }, { text: 'Write tests for this change', icon: 'flask' }, { text: 'Explain this branch', icon: 'doc' }]

/**
 * The centred welcome of a chat with nothing in it (NewChat.png): the heading, the subtitle and the suggestions. `children` sit between
 * the subtitle and the suggestions, which is where the Lead's New chat state draws its own composer. A new chat with Rowan gets its own
 * worktree (KERNEL-405), so it passes its own `sub`.
 */
export function ChatWelcome({ title, sub = 'Same worktree and branch, fresh context.', suggestions, onPick, children }: { title: string; sub?: string; suggestions: { text: string; icon: IconName }[]; onPick: (text: string) => void; children?: ReactNode }) {
  return (
    <div className="chat-empty">
      <h2>{title}</h2>
      <span className="muted">{sub}</span>
      {children}
      <div className="chat-suggest">
        {suggestions.map(({ text, icon }) => (
          <button key={text} type="button" onClick={() => onPick(text)}><Icon name={icon} size={14} />{text}</button>
        ))}
      </div>
    </div>
  )
}
