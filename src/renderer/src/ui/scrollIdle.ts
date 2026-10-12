/** How long after the last scroll event the thumb stays up. */
const IDLE_MS = 1000

/**
 * Marks whatever scrolls with `data-scrolling` while it scrolls and for a second after, so tokens.css can show its thumb (KERNEL-597, KERNEL-602). A scroll
 * event doesn't bubble but does capture, so one listener on the document sees every scroller in the app, sidebar, chat, Settings, modals and popovers
 * alike. The attribute is set on the element itself, not in state, so a scroll never renders anything. Returns a function that removes the listener.
 */
export function installScrollIdle(): () => void {
  const timers = new WeakMap<Element, number>()
  const onScroll = (e: Event) => {
    // The page itself never scrolls (body is overflow hidden), and `document` has no attributes to set.
    if (!(e.target instanceof Element)) return
    const el = e.target
    if (!el.hasAttribute('data-scrolling')) el.setAttribute('data-scrolling', '')
    window.clearTimeout(timers.get(el))
    timers.set(el, window.setTimeout(() => el.removeAttribute('data-scrolling'), IDLE_MS))
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => document.removeEventListener('scroll', onScroll, { capture: true })
}
