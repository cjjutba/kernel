export interface DiffLine { a: string; b: string; mark: ' ' | '+' | '-'; code: string; hunk?: boolean }
export interface DiffFile { path: string; lines: DiffLine[]; added: number; removed: number }

/** Unified diff text to files with old and new line numbers. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let a = 0, b = 0
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git')) {
      const m = / b\/(.+)$/.exec(raw)
      cur = { path: m?.[1] ?? raw, lines: [], added: 0, removed: 0 }
      files.push(cur)
      continue
    }
    if (!cur) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (h) { a = Number(h[1]); b = Number(h[2]); cur.lines.push({ a: '', b: '', mark: ' ', code: raw, hunk: true }); continue }
    if (/^(---|\+\+\+|index |new file|deleted file|similarity|rename|old mode|new mode|Binary)/.test(raw) && !cur.lines.length) continue
    if (raw.startsWith('+')) { cur.lines.push({ a: '', b: String(b++), mark: '+', code: raw.slice(1) }); cur.added++ }
    else if (raw.startsWith('-')) { cur.lines.push({ a: String(a++), b: '', mark: '-', code: raw.slice(1) }); cur.removed++ }
    else if (raw.startsWith(' ')) cur.lines.push({ a: String(a++), b: String(b++), mark: ' ', code: raw.slice(1) })
  }
  return files
}

