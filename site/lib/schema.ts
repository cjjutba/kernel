import { z } from 'zod'

export const ChangeItem = z.object({
  /** Bold lead in, such as "The floor." */
  lead: z.string().optional(),
  text: z.string(),
  pr: z.number().int().positive().optional()
})

export const Release = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string(),
  image: z.object({ src: z.string(), alt: z.string() }).optional(),
  intro: z.string(),
  sections: z.array(z.object({ title: z.string(), items: z.array(ChangeItem).min(1) }))
})

export const UpNext = z.object({ title: z.string(), intro: z.string(), items: z.array(ChangeItem) })

export const Changelog = z.object({ releases: z.array(Release).min(1), upNext: UpNext })

export type ChangeItem = z.infer<typeof ChangeItem>
export type Release = z.infer<typeof Release>
export type UpNext = z.infer<typeof UpNext>
