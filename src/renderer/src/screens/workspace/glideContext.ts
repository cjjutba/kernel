import { createContext } from 'react'

/** Reveals `el` in the transcript with its glide: a plan taller than the view at its top, else its end in view. The composer opening under it is the owner's to follow (KERNEL-953). It runs once per plan id (KERNEL-950). */
export const TranscriptGlide = createContext<((el: HTMLElement, planId: string) => void) | null>(null)
