/** The language a file's header names, by extension (Pen 9.3). A file with none of these says nothing. */
const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  json: 'JSON', jsonc: 'JSON', md: 'Markdown', mdx: 'Markdown', css: 'CSS', scss: 'SCSS', html: 'HTML', yml: 'YAML', yaml: 'YAML', toml: 'TOML',
  py: 'Python', rb: 'Ruby', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', cs: 'C#', php: 'PHP',
  sh: 'Shell', zsh: 'Shell', bash: 'Shell', sql: 'SQL', xml: 'XML', svg: 'SVG', txt: 'Plain text', env: 'Environment'
}

export function languageOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const at = name.lastIndexOf('.')
  return at < 0 ? undefined : LANGUAGES[name.slice(at + 1).toLowerCase()]
}
