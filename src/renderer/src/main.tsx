import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { boot } from './store'
import { installScrollIdle } from './ui/scrollIdle'
import { installZoomSignal } from './ui/zoomSignal'
import { applyStartupAppearance } from './ui/theme'
import { LinkNotice, PhoneSidebar, startRemote } from './remote/start'
import '@fontsource-variable/geist/wght.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import './tokens.css'

const root = document.getElementById('root')!

function run() {
  // Before React mounts, so the first frame already matches Settings, Appearance (KERNEL-708).
  applyStartupAppearance()
  void boot()
  installScrollIdle()
  installZoomSignal()
  createRoot(root).render(<StrictMode><App /><LinkNotice />{window.kernel.remote && <PhoneSidebar />}</StrictMode>)
}

// The app's window has the preload's bridge. A browser has none, and pairs with a Mac first (remote-web-client).
if (window.kernel) run()
else startRemote(root, run)
