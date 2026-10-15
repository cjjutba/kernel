// Browser stand-in for node:util.
export const promisify = (fn: unknown) => (...args: unknown[]) => Promise.reject(new Error(`Not available in the demo: ${typeof fn === 'function' ? fn.name : 'call'}(${args.length} args)`))
export const inspect = (v: unknown) => { try { return JSON.stringify(v) } catch { return String(v) } }
export const format = (...a: unknown[]) => a.map(String).join(' ')
export default { promisify, inspect, format }
