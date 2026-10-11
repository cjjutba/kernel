/**
 * The flag as the shell hands it to `claude`: quoted, after a backslash, with `=value`, next to `;`, `|`, `&`, `<` and `>`,
 * or inside backticks. `--dangerously-skip-permissions-x` is another word and is left alone. A variable or an alias can't
 * be caught (KERNEL-248). The engine and the renderer's skip notice both use this one matcher (KERNEL-317).
 */
const SKIP_WORD = /(^|[\s;&|(`])\\?(["']?)--dangerously-skip-permissions(?:=[^\s;&|()<>"'`]*)?\2(?=$|[\s;&|)<>`])/g

/** Whether `command` runs with the flag in any of those forms. */
export const skipsPermissions = (command: string) => new RegExp(SKIP_WORD.source).test(command)
/** Removes every form of the flag. The space before it goes with it, a `;` or `(` before it stays. */
export const withoutSkip = (command: string) => command.replace(SKIP_WORD, (_, before: string) => (/\s/.test(before) ? '' : before)).trim()
