// Browser stand-in for node:path, POSIX only. Enough for the fixture handlers.
export const sep = '/'
export const delimiter = ':'
const norm = (p: string): string => {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..') }
    else out.push(part)
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.')
}
export const normalize = norm
export const join = (...parts: string[]): string => norm(parts.filter(Boolean).join('/'))
export const resolve = (...parts: string[]): string => {
  let r = ''
  for (const p of parts) r = p.startsWith('/') ? p : `${r}/${p}`
  return norm(r.startsWith('/') ? r : `/${r}`)
}
export const isAbsolute = (p: string): boolean => p.startsWith('/')
export const dirname = (p: string): string => { const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i <= 0 ? (i === 0 ? '/' : '.') : p.slice(0, i) }
export const basename = (p: string, ext?: string): string => { const b = p.replace(/\/+$/, '').split('/').pop() ?? ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b }
export const extname = (p: string): string => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : '' }
export const relative = (from: string, to: string): string => {
  const a = resolve(from).split('/').filter(Boolean)
  const b = resolve(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}
const globToRe = (g: string): RegExp => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*') + '$')
export const matchesGlob = (p: string, g: string): boolean => globToRe(g).test(p)
export const posix = { sep, delimiter, normalize, join, resolve, isAbsolute, dirname, basename, extname, relative, matchesGlob }
export default posix
