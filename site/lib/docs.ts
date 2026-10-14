import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Marked, type Tokens } from 'marked'
import { DOCS_NAV } from '@/content/docs/nav'
import { REPO_URL } from './links'
import { parseFrontmatter } from './schema'

// The docs: Markdown files in content/docs, read and rendered at build time, so a docs page ships no script for its
// text. Each file starts with a title and a description in frontmatter, then the page, with ## and ### for sections.

const DIR = join(process.cwd(), 'content', 'docs')

export type DocHeading = { id: string; text: string; depth: 2 | 3 }
export type DocPage = {
  slug: string
  href: string
  section: string
  title: string
  description: string
  html: string
  headings: DocHeading[]
  /** Plain text, for search. */
  text: string
  editUrl: string
}

export const docHref = (slug: string) => (slug === 'introduction' ? '/docs' : `/docs/${slug}`)

/** Every slug in sidebar order. */
export const DOC_SLUGS = DOCS_NAV.flatMap((s) => s.pages)

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Text without Markdown, for search and the table of contents. */
const plain = (md: string) =>
  md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-+]|\d+\.)\s+/gm, '')
    .replace(/[*_>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function render(md: string): { html: string; headings: DocHeading[] } {
  const headings: DocHeading[] = []
  const seen = new Map<string, number>()
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens)
        if (depth !== 2 && depth !== 3) return `<h${depth}>${inner}</h${depth}>`
        const base = slugify(inner) || 'section'
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        const id = n ? `${base}-${n}` : base
        headings.push({ id, text: inner.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'), depth })
        return `<h${depth} id="${id}"><a href="#${id}" class="doc-anchor">${inner}</a></h${depth}>`
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens)
        const external = /^https?:\/\//.test(href)
        const t = title ? ` title="${escape(title)}"` : ''
        return external ? `<a href="${escape(href)}"${t} target="_blank" rel="noopener">${inner}</a>` : `<a href="${escape(href)}"${t}>${inner}</a>`
      },
      code({ text, lang }: Tokens.Code) {
        const label = lang ? `<span class="doc-code-lang">${escape(lang)}</span>` : ''
        return `<div class="doc-code">${label}<pre><code>${escape(text)}</code></pre></div>`
      },
      table(token: Tokens.Table) {
        const cell = (c: Tokens.TableCell) => this.parser.parseInline(c.tokens)
        const head = `<tr>${token.header.map((c) => `<th>${cell(c)}</th>`).join('')}</tr>`
        const body = token.rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')
        return `<div class="doc-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        return `<aside class="doc-note">${this.parser.parse(tokens)}</aside>`
      }
    }
  })
  const html = marked.parse(md, { async: false }) as string
  return { html, headings }
}

const cache = new Map<string, DocPage>()

export function getDoc(slug: string): DocPage | null {
  if (!DOC_SLUGS.includes(slug)) return null
  const hit = cache.get(slug)
  if (hit && process.env.NODE_ENV === 'production') return hit
  const file = join('content', 'docs', `${slug}.md`)
  const { data, body } = parseFrontmatter(readFileSync(join(DIR, `${slug}.md`), 'utf8'))
  if (!data.title || !data.description) throw new Error(`${file} needs a title and a description in its frontmatter`)
  const { html, headings } = render(body)
  const page: DocPage = {
    slug,
    href: docHref(slug),
    section: DOCS_NAV.find((s) => s.pages.includes(slug))!.title,
    title: data.title,
    description: data.description,
    html,
    headings,
    text: plain(body),
    editUrl: `${REPO_URL}/edit/main/site/${file}`
  }
  cache.set(slug, page)
  return page
}

/** The page before and after `slug` in sidebar order, for the links at the bottom of a page. */
export function neighbors(slug: string) {
  const i = DOC_SLUGS.indexOf(slug)
  const at = (j: number) => {
    const s = DOC_SLUGS[j]
    return s ? { href: docHref(s), title: getDoc(s)!.title } : null
  }
  return { prev: at(i - 1), next: at(i + 1) }
}

/** The sidebar, with each page's title. */
export function docsNav() {
  return DOCS_NAV.map((s) => ({ title: s.title, pages: s.pages.map((slug) => ({ slug, href: docHref(slug), title: getDoc(slug)!.title })) }))
}

/** What search reads: each page's title, section, headings and text. */
export function searchIndex() {
  return DOC_SLUGS.map((slug) => {
    const d = getDoc(slug)!
    return { href: d.href, title: d.title, section: d.section, description: d.description, headings: d.headings.map((h) => ({ id: h.id, text: h.text })), text: d.text }
  })
}
export type SearchEntry = ReturnType<typeof searchIndex>[number]
