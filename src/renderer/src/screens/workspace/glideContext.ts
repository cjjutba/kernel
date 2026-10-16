import { createContext } from 'react'

/** Reveals `el` in the transcript with its glide: a plan taller than the view at its top, else its end in view, followed for `holdMs` while the view under it changes size. It runs once per plan id (KERNEL-950). */
export const TranscriptGlide = createContext<((el: HTMLElement, holdMs: number, planId: string) => void) | null>(null)
