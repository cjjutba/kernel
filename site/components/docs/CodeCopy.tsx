'use client'

import { useEffect } from 'react'

// The Copy button on every code block. The Markdown renderer writes the buttons into the page's HTML, and this one
// listener copies the block's code when any of them is pressed, then says "Copied" for a moment.

export function CodeCopy() {
  useEffect(() => {
    const onClick = async (e: MouseEvent) => {
      const button = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.doc-copy')
      const code = button?.parentElement?.querySelector('code')
      if (!button || !code) return
      try {
        await navigator.clipboard.writeText(code.textContent ?? '')
        button.textContent = 'Copied'
        button.dataset.copied = ''
        setTimeout(() => {
          button.textContent = 'Copy'
          delete button.dataset.copied
        }, 1600)
      } catch {
        button.textContent = 'Press ⌘C'
      }
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])
  return null
}
