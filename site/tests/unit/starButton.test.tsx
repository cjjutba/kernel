import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StarButtonView } from '@/components/ui/StarButton'

// The count cell is the only place the star icon appears.
const STAR_ICON = 'M8 1.8l'

describe('StarButtonView', () => {
  it('hides a count below the minimum', () => {
    const html = renderToStaticMarkup(<StarButtonView count={3} />)
    expect(html.replace(/<[^>]+>/g, '')).toBe('Star Kernel on GitHub')
    expect(html).not.toContain(STAR_ICON)
    expect(html).not.toMatch(/>3</)
  })

  it('hides the count when GitHub could not be reached', () => {
    expect(renderToStaticMarkup(<StarButtonView count={null} />)).not.toContain(STAR_ICON)
  })

  it('shows a formatted count from the minimum up', () => {
    const html = renderToStaticMarkup(<StarButtonView count={1234} />)
    expect(html).toContain('1.2k')
    // Cells are separate boxes, so the accessible name gets a space after the comma (checked in e2e).
    expect(html.replace(/<[^>]+>/g, '')).toBe('Star Kernel on GitHub,1.2k stars')
  })
})
