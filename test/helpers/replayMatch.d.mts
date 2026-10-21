export interface ReplayHeader { provider: 'claude' | 'codex'; scenario: string; description: string; ignore?: string[] }
export interface ReplayFrame { dir: 'in' | 'out'; [key: string]: unknown }
export function parseReplay(text: string, name?: string): { header: ReplayHeader; frames: ReplayFrame[] }
export function mismatch(expected: unknown, actual: unknown, path?: string): string | undefined
export function show(frame: ReplayFrame | undefined): string
