// What both replays share: reading a recording and comparing what Kernel sent with what the recording expects. It is plain
// ESM because the fake Codex app-server (replayCodexServer.mjs) runs in its own process, outside vitest's transform.

/**
 * Parses an NDJSON recording: a header line, then one frame per line. A frame is `{ "dir": "in" | "out", ... }`, `in` for what
 * the provider sends Kernel and `out` for what Kernel is expected to send. Throws with the line number on a bad line.
 */
export function parseReplay(text, name = 'recording') {
  const lines = text.split('\n').filter((l) => l.trim())
  const read = (l, i) => { try { return JSON.parse(l) } catch (e) { throw new Error(`${name}, line ${i + 1}: not JSON (${e.message})`) } }
  if (!lines.length) throw new Error(`${name} is empty`)
  const header = read(lines[0], 0)
  for (const key of ['provider', 'scenario', 'description']) if (typeof header[key] !== 'string' || !header[key]) throw new Error(`${name}, line 1: the header needs "${key}"`)
  const frames = lines.slice(1).map((l, i) => {
    const frame = read(l, i + 1)
    if (frame.dir !== 'in' && frame.dir !== 'out') throw new Error(`${name}, line ${i + 2}: "dir" must be "in" or "out"`)
    return frame
  })
  return { header, frames }
}

/**
 * Why `actual` doesn't match `expected`, or undefined when it does. Objects match when every key `expected` names matches, so
 * volatile fields stay out of a recording by not being named. "*" matches any value that is there, a string starting with "~"
 * matches a string that contains the rest, arrays match item by item, and anything else must be equal.
 */
export function mismatch(expected, actual, path = '$') {
  if (expected === '*') return actual === undefined ? `${path}: missing` : undefined
  if (typeof expected === 'string' && expected.startsWith('~')) {
    return typeof actual === 'string' && actual.includes(expected.slice(1)) ? undefined : `${path}: expected text containing ${JSON.stringify(expected.slice(1))}, got ${JSON.stringify(actual)}`
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return `${path}: expected ${expected.length} items, got ${JSON.stringify(actual)}`
    for (let i = 0; i < expected.length; i++) { const m = mismatch(expected[i], actual[i], `${path}[${i}]`); if (m) return m }
    return undefined
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return `${path}: expected an object, got ${JSON.stringify(actual)}`
    for (const [k, v] of Object.entries(expected)) { const m = mismatch(v, actual[k], `${path}.${k}`); if (m) return m }
    return undefined
  }
  return Object.is(expected, actual) ? undefined : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
}

/** A frame as a failure message shows it. */
export function show(frame) {
  if (!frame) return 'the end of the recording'
  const { dir, ...rest } = frame
  return `${dir} ${JSON.stringify(rest)}`.slice(0, 300)
}
