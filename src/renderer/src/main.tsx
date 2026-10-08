import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { boot } from './store'
import '@fontsource-variable/inter/opsz.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import './tokens.css'

void boot()
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
