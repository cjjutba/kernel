import { z } from 'zod'

// Payloads Claude Code POSTs to Kernel's hook server (type: "http" hooks).
// Shapes follow the HookInput types in @anthropic-ai/claude-agent-sdk 0.3.x.
// Every schema is loose: unknown fields pass through so newer CLIs never break parsing.

export const BaseHook = z.looseObject({
  session_id: z.string(),
  transcript_path: z.string().optional(),
  cwd: z.string(),
  permission_mode: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  hook_event_name: z.string()
})

const tool = { tool_name: z.string(), tool_input: z.unknown() }

export const PreToolUse = BaseHook.extend({ hook_event_name: z.literal('PreToolUse'), ...tool, tool_use_id: z.string() })
export const PostToolUse = BaseHook.extend({ hook_event_name: z.literal('PostToolUse'), ...tool, tool_response: z.unknown(), tool_use_id: z.string(), duration_ms: z.number().optional() })
export const PostToolUseFailure = BaseHook.extend({ hook_event_name: z.literal('PostToolUseFailure'), ...tool, tool_use_id: z.string().optional(), error: z.unknown().optional() })
export const PermissionRequest = BaseHook.extend({ hook_event_name: z.literal('PermissionRequest'), ...tool, permission_suggestions: z.array(z.unknown()).optional() })
export const UserPromptSubmit = BaseHook.extend({ hook_event_name: z.literal('UserPromptSubmit'), prompt: z.string() })
export const Notification = BaseHook.extend({ hook_event_name: z.literal('Notification'), message: z.string(), title: z.string().optional() })
export const SessionStart = BaseHook.extend({ hook_event_name: z.literal('SessionStart'), source: z.string().optional(), model: z.string().optional() })
export const SessionEnd = BaseHook.extend({ hook_event_name: z.literal('SessionEnd'), reason: z.string().optional() })
export const Stop = BaseHook.extend({ hook_event_name: z.literal('Stop'), stop_hook_active: z.boolean().optional() })
export const SubagentStart = BaseHook.extend({ hook_event_name: z.literal('SubagentStart') })
export const SubagentStop = BaseHook.extend({ hook_event_name: z.literal('SubagentStop') })
export const PreCompact = BaseHook.extend({ hook_event_name: z.literal('PreCompact'), trigger: z.string().optional() })
const task = { task_id: z.string(), task_subject: z.string(), task_description: z.string().optional(), teammate_name: z.string().optional(), team_name: z.string().optional() }
export const TaskCreated = BaseHook.extend({ hook_event_name: z.literal('TaskCreated'), ...task })
export const TaskCompleted = BaseHook.extend({ hook_event_name: z.literal('TaskCompleted'), ...task })
export const TeammateIdle = BaseHook.extend({ hook_event_name: z.literal('TeammateIdle'), teammate_name: z.string(), team_name: z.string() })

export const KNOWN_HOOKS = {
  PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, UserPromptSubmit, Notification,
  SessionStart, SessionEnd, Stop, SubagentStart, SubagentStop, PreCompact, TaskCreated, TaskCompleted, TeammateIdle
} as const

export type HookName = keyof typeof KNOWN_HOOKS
export const HOOK_NAMES = Object.keys(KNOWN_HOOKS) as HookName[]

export type HookPayload = { [K in HookName]: z.infer<(typeof KNOWN_HOOKS)[K]> }[HookName]
export type AnyHook = z.infer<typeof BaseHook>

export type ParsedHook =
  | { ok: true; known: true; event: HookPayload }
  | { ok: true; known: false; event: AnyHook }
  | { ok: false; error: string }

/** Validate a raw hook body. Unknown events still parse against the base shape so they can be logged. */
export function parseHook(body: unknown): ParsedHook {
  const base = BaseHook.safeParse(body)
  if (!base.success) return { ok: false, error: base.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  const name = base.data.hook_event_name as HookName
  const schema = KNOWN_HOOKS[name]
  if (!schema) return { ok: true, known: false, event: base.data }
  const parsed = schema.safeParse(body)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  return { ok: true, known: true, event: parsed.data as HookPayload }
}

/** JSON a PermissionRequest http hook answers with. Omit the decision to fall back to Claude Code's own prompt. */
export function permissionResponse(decision: { behavior: 'allow' } | { behavior: 'deny'; message: string } | null) {
  if (!decision) return {}
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}
