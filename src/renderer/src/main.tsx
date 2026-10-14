import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { boot } from './store'
import { installScrollIdle } from './ui/scrollIdle'
import { applyStartupAppearance } from './ui/theme'
import '@fontsource-variable/geist/wght.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import './tokens.css'

// Before React mounts, so the first frame already matches Settings, Appearance (KERNEL-708).
applyStartupAppearance()
void boot()
installScrollIdle()
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
