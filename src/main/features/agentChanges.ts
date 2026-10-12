import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { AgentChangePr, AgentDef, AgentDraft, AgentEdit, AgentScope } from '@shared/types'
import { bus } from '../bus'
import { agentFromFile, createAgent, draftId, freeId, isUnreadable, loadAgents, restoreAgent, retireAgent, updateAgent } from '../services/agents'
import { AgentOverrides, editedFields, ownEditOf, withOwnEdit } from '../services/agentOverrides'
import { exec, git, SLOW_MS } from '../services/exec'
import { loadRepoSettings, saveTeamSettings } from '../services/settings'
import { Feature } from './feature'

/** One change for the team: a commit in a workspace of its own, and the pull request it opens (KERNEL-466). */
interface TeamChange {
  /** The commit's subject and the PR's title: "Add Lumi to the team". */
  title: string
  /** What the PR changes, a sentence or two, for its body and the workspace's note. */
  body: string
  /** Writes the change in the worktree at `path`, cut from `base`. Throws to call the change off. */
  write: (path: string, base: string) => Promise<unknown>
  /** The agent the change brings onto the team, which joins `[team] roster` in the same commit when the repo has one (KERNEL-465). */
  joins?: string
  /** Why there is nothing to commit, when the base already says what the change would. */
  same?: string
}

const exists = (p: string) => stat(p).then(() => true, () => false)

/** The plugin a plugin agent comes from: `kit` for `kit:builder` (KERNEL-463). */
const pluginOf = (a: AgentDef) => a.id.slice(0, a.id.indexOf(':'))

/** What a failed git or gh call said, without the command line `run` puts before it. */
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^[\s\S]*? failed \(\d+\): /, '').trim()

/** "the model, tools and instructions", for a PR that changes those lines of an agent file. */
function fieldsOf(edit: AgentEdit): string {
  const words: Record<string, string> = { description: 'description', role: 'role', model: 'model', provider: 'provider', effort: 'effort', tools: 'tools', skills: 'skills', prompt: 'instructions' }
  const list = [...new Set(Object.keys(edit).map((k) => words[k]).filter(Boolean))]
  return `the ${list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0]}`
}

/**
 * Who an agent change is for (KERNEL-466). A change for me stays on this Mac: a new agent goes to ~/.claude/agents, and an edit
 * or a retire of an agent in the repo is kept in Kernel's data folder and laid over its file. A change for the team is one
 * commit on a branch of its own, in a workspace like a task's, and a pull request through the room's code host. Kernel never
 * writes an agent file in the room's own checkout.
 */
export class AgentChanges extends Feature {
  private overrides?: AgentOverrides
  private get own() { return (this.overrides ??= new AgentOverrides(join(this.o.dataDir, 'agent-overrides.json'))) }

  /** The room's agent files as the user has them on this Mac: their own edits laid over, and the agents they retired left out. */
  async apply(roomId: string, files: AgentDef[]): Promise<AgentDef[]> {
    const own = await this.own.of(roomId)
    return files.filter((a) => !own[a.id]?.retired).map((a) => withOwnEdit(a, own[a.id]?.edit))
  }

  /**
   * The agents the user hired or brought back for themselves in this room. They are on the user's team here even when the
   * room's `[team] roster` leaves them out (KERNEL-465).
   */
  async joinedHere(roomId: string): Promise<string[]> {
    return Object.entries(await this.own.of(roomId)).filter(([, o]) => o.joined).map(([id]) => id)
  }

  /** A roster the user picked replaces the agents they joined for themselves in this room. */
  async clearJoined(roomId: string) {
    for (const [id, o] of Object.entries(await this.own.of(roomId))) if (o.joined) await this.own.set(roomId, id, { ...o, joined: false })
  }

  /** The agents the user retired on this Mac whose file is still on the team, for Team's retired list. */
  async retiredHere(roomId: string, files: AgentDef[]): Promise<AgentDef[]> {
    const own = await this.own.of(roomId)
    return files.filter((a) => own[a.id]?.retired).map((a) => ({ ...withOwnEdit(a, own[a.id]?.edit), retired: true }))
  }

  forgetRoom(roomId: string) { return this.own.forget(roomId) }

  /** A new agent: its file in ~/.claude/agents for me, or a pull request that adds it to .claude/agents for the team. */
  async hire(roomId: string, draft: Pick<AgentDraft, 'id' | 'text'>, scope: AgentScope = 'me'): Promise<{ agent: AgentDef; pr?: AgentChangePr }> {
    const room = this.mustRoom(roomId)
    const id = draftId(draft)
    // A file the room has wins over the user's own with the same name, as in Claude Code, so the name must be free in both.
    await freeId(room.path, id)
    if (scope === 'me') {
      const agent: AgentDef = { ...(await createAgent(this.home, draft)), origin: 'personal' }
      await this.joined(roomId, id)
      return { agent }
    }
    const rel = `.claude/agents/${id}.md`
    const agent = agentFromFile(join(room.path, rel), draft.text)
    const pr = await this.openPr(roomId, {
      title: `Add ${agent.name} to the team`,
      body: `Adds \`${rel}\`. ${agent.name} joins everyone's team once this merges.`,
      write: (path) => createAgent(path, draft),
      joins: id
    })
    return { agent, pr }
  }

  /**
   * A profile save. For me: the agent's own file in ~/.claude/agents, or Kernel's record of the change over the repo's file.
   * For the team: a pull request with only the fields the user changed, and the agent stays as it is until that merges.
   */
  async edit(roomId: string, agent: AgentDef, patch: AgentEdit, scope: AgentScope = 'me'): Promise<AgentChangePr | undefined> {
    const room = this.mustRoom(roomId)
    if (scope === 'me') {
      if (agent.origin === 'personal' || agent.origin === 'plugin') { await this.editOwn(agent, patch); return undefined }
      const file = (await loadAgents(room.path)).find((a) => a.id === agent.id)
      if (!file) throw new Error(`${agent.id} is not in .claude/agents.`)
      if (isUnreadable(file)) throw new Error(`Kernel can't read ${basename(file.file)}: ${file.warnings![0].detail}. Fix the file, then save again.`)
      if (!(patch.description ?? agent.description).trim()) throw new Error('Add a description so Rowan knows what to hand this agent.')
      const own = (await this.own.of(roomId))[agent.id]
      await this.own.set(roomId, agent.id, { ...own, edit: ownEditOf(file, agent, patch) })
      return undefined
    }
    const rel = await this.teamFile(room.path, agent, 'edit')
    const changed = editedFields(agent, patch)
    if (!Object.keys(changed).length) throw new Error(`Nothing to change: ${agent.name}'s file already says that.`)
    if (changed.description !== undefined && !changed.description.trim()) throw new Error('Add a description so Rowan knows what to hand this agent.')
    return this.openPr(roomId, {
      title: `Change ${agent.name}'s agent file`,
      body: `Changes ${fieldsOf(changed)} in \`${rel}\`. Everyone gets it once this merges.`,
      same: `${rel} already says that on the base branch.`,
      write: async (path, base) => { await onBase(path, rel, base); await updateAgent(path, agent.id, changed) }
    })
  }

  /**
   * A save to an agent that joins every room, with or without one open (KERNEL-640): a personal agent's own file in
   * ~/.claude/agents. A plugin's files are the plugin's.
   */
  async editOwn(agent: AgentDef, patch: AgentEdit): Promise<void> {
    if (agent.origin === 'plugin') throw new Error(`${agent.name} comes from the ${pluginOf(agent)} plugin, and Kernel doesn't change a plugin's files.`)
    if (agent.origin !== 'personal') throw new Error(`${agent.id} is not in ~/.claude/agents.`)
    await updateAgent(this.home, agent.id, patch)
  }

  /**
   * A retire: the agent leaves the team on this Mac now, and its file stays where it is. For the team, a pull request also moves
   * the file to .claude/retired-agents (D-003). It opens first, so a change that can't be made leaves the agent on the team.
   */
  async retire(roomId: string, agent: AgentDef, scope: AgentScope = 'me'): Promise<AgentChangePr | undefined> {
    const room = this.mustRoom(roomId)
    let pr: AgentChangePr | undefined
    if (scope === 'team') {
      const rel = await this.teamFile(room.path, agent, 'retire')
      pr = await this.openPr(roomId, {
        title: `Retire ${agent.name}`,
        body: `Moves \`${rel}\` to \`.claude/retired-agents/${basename(rel)}\`, so Claude Code stops loading it. ${agent.name} leaves everyone's team once this merges.`,
        write: async (path, base) => { await onBase(path, rel, base); await retireAgent(path, agent.id) }
      })
    }
    const own = (await this.own.of(roomId))[agent.id]
    await this.own.set(roomId, agent.id, { ...own, retired: true })
    return pr
  }

  /**
   * Brings back an agent the user retired on this Mac. A file in .claude/retired-agents, which the team retired, comes back to
   * ~/.claude/agents for me, or in a pull request that moves it back for the team.
   */
  async restore(roomId: string, agentId: string, scope: AgentScope = 'me'): Promise<{ agent?: AgentDef; pr?: AgentChangePr }> {
    const room = this.mustRoom(roomId)
    const own = (await this.own.of(roomId))[agentId]
    if (own?.retired) {
      await this.own.set(roomId, agentId, { ...own, retired: false })
      if ((await loadAgents(room.path)).some((a) => a.id === agentId)) return {}
    }
    const file = (await loadAgents(room.path, { retired: true })).find((a) => a.id === agentId)
    if (!file) {
      if (own?.retired) return {}
      throw new Error(`${agentId} is not in .claude/retired-agents.`)
    }
    const name = basename(file.file)
    if (scope === 'me') {
      await freeId(room.path, agentId)
      await freeId(this.home, agentId)
      const to = join(this.home, '.claude', 'agents', name)
      const text = await readFile(file.file, 'utf8')
      await mkdir(dirname(to), { recursive: true })
      await writeFile(to, text)
      await this.joined(roomId, agentId)
      return { agent: { ...agentFromFile(to, text), origin: 'personal' } }
    }
    const rel = `.claude/retired-agents/${name}`
    await committed(room.path, rel)
    const pr = await this.openPr(roomId, {
      title: `Bring ${file.name} back`,
      body: `Moves \`${rel}\` back to \`.claude/agents/${name}\`. ${file.name} rejoins everyone's team once this merges.`,
      write: async (path, base) => { await onBase(path, rel, base); await restoreAgent(path, agentId) },
      joins: agentId
    })
    return { agent: { ...file, retired: undefined }, pr }
  }

  /** Marks an agent hired or brought back for the user in this room, so the room's roster doesn't leave it out. */
  private async joined(roomId: string, agentId: string) {
    const own = (await this.own.of(roomId))[agentId]
    await this.own.set(roomId, agentId, { ...own, joined: true })
  }

  /** The agent's file in the repo, relative to it, for a change for the team. Only a file the repo has committed is the team's. */
  private async teamFile(repoPath: string, agent: AgentDef, change: 'edit' | 'retire'): Promise<string> {
    if (agent.origin === 'personal') throw new Error(`${agent.name}'s file is in ~/.claude/agents, so the team doesn't have ${agent.name}. ${change === 'edit' ? 'Save the change just for you.' : `Retire ${agent.name} just for you.`}`)
    if (agent.origin === 'plugin') throw new Error(`${agent.name} comes from the ${pluginOf(agent)} plugin, so the team's files don't have ${agent.name}.`)
    const rel = relative(repoPath, agent.file).split('\\').join('/')
    await committed(repoPath, rel)
    return rel
  }

  /**
   * A change for the team, the way a task goes out: a workspace on the Lead with a branch of its own from the room's base, one
   * commit there, and a pull request through the room's code host (KERNEL-453). Nobody works in it, so the room's setup doesn't
   * run and no brief waits. The PR poll, Merge and archive then treat it like any workspace's. A change that can't be written or
   * committed takes its workspace and branch away again. A PR that doesn't open leaves the commit in the workspace, where
   * Create PR finishes it.
   */
  private async openPr(roomId: string, change: TeamChange): Promise<AgentChangePr> {
    const room = this.mustRoom(roomId)
    const host = this.k.codeHost.hostFor(room)
    if (!host.create) throw new Error("Kernel can't open pull requests on this room's code host yet. Make the change just for you.")
    const { ws } = await this.k.workspaces.cutWorkspace(roomId, { prompt: change.title, title: change.title, mode: 'worktree' })
    this.k.setup.setSetup(ws.id, undefined)
    try {
      await change.write(ws.path, ws.baseRef)
      await git(ws.path, 'add', '-A', '--', '.claude')
      // A hire or a restore joins the roster the base has, or it would land off the team once this merges.
      const roster = change.joins ? (await loadRepoSettings(ws.path)).team?.roster : undefined
      if (change.joins && roster?.length && !roster.includes(change.joins)) {
        await saveTeamSettings(ws.path, { roster: [...roster, change.joins] })
        await git(ws.path, 'add', '--', '.kernel/settings.toml')
      }
      if (!(await git(ws.path, 'diff', '--cached', '--name-only')).trim()) throw new Error(change.same ?? 'There is nothing to change.')
      const commit = await exec('git', ['-C', ws.path, 'commit', '-q', '-m', change.title, '-m', change.body], { timeoutMs: SLOW_MS })
      if (commit.code !== 0) throw new Error(`Kernel couldn't commit the change. ${(commit.stderr || commit.stdout).trim()}`)
    } catch (e) {
      await this.drop(ws.id)
      throw e
    }
    this.updateWs(ws.id, { status: 'ready' })
    this.note(ws.id, `Kernel made this change for the team. ${change.body}`)
    const draft = this.settings.pr.draft
    let made: { number: number; url: string } | null
    try {
      made = await host.create(ws.path, { title: change.title, body: `${change.body}\n\nOpened by Kernel.`, base: ws.baseRef, draft }, await this.k.config.remoteFor(room.path))
    } catch (e) {
      const error = reason(e)
      this.note(ws.id, `Kernel couldn't open the pull request: ${error} Click Create PR to try again.`)
      return { workspaceId: ws.id, error }
    }
    // A PR the host opened but couldn't name is found on the branch, the way the poll finds an agent's.
    const next = this.updateWs(ws.id, made ? { prNumber: made.number, prUrl: made.url, prTitle: change.title, prState: draft ? 'draft' : 'open' } : { prState: 'creating' })
    bus.push({ type: 'pr', workspaceId: ws.id, state: next.prState })
    void this.k.prs.refreshPr(ws.id, { settle: true }).catch(() => undefined)
    return { workspaceId: ws.id, ...(made ? { number: made.number, url: made.url } : {}) }
  }

  /** A change for the team that didn't happen: its workspace, worktree and branch go, and History keeps no record of it. */
  private async drop(id: string) {
    await this.k.archive.archiveWorkspace(id, true, { noScript: true }).catch(() => undefined)
    await this.k.history.deleteWorkspaces([id], { deleteUnpushed: true }).catch(() => undefined)
  }
}

/** Refuses a file the repo hasn't committed: the team doesn't have it, so a pull request can't change it. */
async function committed(repoPath: string, rel: string) {
  if ((await exec('git', ['-C', repoPath, 'ls-files', '--error-unmatch', '--', rel])).code === 0) return
  throw new Error(`${rel} isn't committed, so the team doesn't have it yet. Commit it first, or make the change just for you.`)
}

/** Refuses a file the workspace's base doesn't have, when the room's checkout has it committed but not pushed. */
async function onBase(path: string, rel: string, base: string) {
  if (!(await exists(join(path, rel)))) throw new Error(`${rel} isn't on ${base} yet, so the team doesn't have it. Push it first, or make the change just for you.`)
}
