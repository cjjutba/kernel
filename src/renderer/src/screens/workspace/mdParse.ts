/** Block structure of the markdown subset assistant replies use: paragraphs, headings, lists and fenced code. */
export type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'ul' | 'ol'; items: string[] }
  | { type: 'code'; lang: string; text: string }

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const flush = () => { if (para.length) out.push({ type: 'p', text: para.join('\n') }); para = [] }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
      out.push({ type: 'code', lang: fence[1], text: body.join('\n') })
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) { flush(); out.push({ type: 'h', level: heading[1].length, text: heading[2] }); continue }
    const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line)
    if (item) {
      flush()
      const type = /\d/.test(item[1]) ? 'ol' : 'ul'
      const last = out[out.length - 1]
      if (last && last.type === type) last.items.push(item[2])
      else out.push({ type, items: [item[2]] })
      continue
    }
    if (!line.trim()) { flush(); continue }
    para.push(line)
  }
  flush()
  return out
}

