// The Claude Agent SDK for suites that stub `Kernel.sessions.send`. A chat with Kernel's first message waits for setup and goes
// out through the real send once setup passes (KERNEL-405), so a suite that starts one swaps `query` for this and no Claude Code
// process ever starts. The rest of the SDK stays real:
// `vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))`
// A query never answers.
export const calls: { options: Record<string, any> }[] = []
export const query = ({ options }: { options?: Record<string, any> } = {}) => (calls.push({ options: options ?? {} }), {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
  interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, applyFlagSettings: async () => {}, getContextUsage: async () => ({ percentage: 0 })
})
