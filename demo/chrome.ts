// On a Mac, the window's traffic lights are drawn by macOS, not by the app, so the renderer only leaves room for them at
// the top of the sidebar. The demo draws them there, so the frame reads as the Mac app it is. They are decoration.
const lights = document.createElement('div')
lights.setAttribute('aria-hidden', 'true')
Object.assign(lights.style, { position: 'fixed', top: '24px', left: '20px', zIndex: '2147483646', display: 'flex', gap: '8px', pointerEvents: 'none' })
for (const [fill, edge] of [['#ff5f57', '#e0443e'], ['#febc2e', '#dea123'], ['#28c840', '#1aab29']]) {
  const dot = document.createElement('span')
  Object.assign(dot.style, { width: '12px', height: '12px', borderRadius: '50%', background: fill, boxShadow: `inset 0 0 0 0.5px ${edge}` })
  lights.append(dot)
}
document.body.append(lights)
