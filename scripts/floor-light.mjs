// Writes src/renderer/src/floor/floor-light.svg from floor.svg (KERNEL-29). Same geometry; only the room shell
// (floor, walls, grid, rug, glass frames: the dark neutrals in the first 65 lines) gets a light palette.
// Desks, chairs, screens and plants are already mid or light in floor.svg and stay. Run: node scripts/floor-light.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer/src/floor')
const lines = readFileSync(join(dir, 'floor.svg'), 'utf8').split('\n')
const SIDES = { '#1e1e22': '#d9d9de', '#17171a': '#cfcfd5', '#2b2b30': '#ececef' }
const hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
const flip = (c) => '#' + [1, 3, 5].map((i) => hex(236 - (parseInt(c.slice(i, i + 2), 16) - 43))).join('')

const out = lines.map((l, i) => {
  if (i > 64) return l
  return l.replace(/(fill|stroke)="(#[0-9a-f]{6})"/g, (m, k, c) => {
    if (SIDES[c]) return `${k}="${SIDES[c]}"`
    const max = Math.max(...[1, 3, 5].map((j) => parseInt(c.slice(j, j + 2), 16)))
    return max < 0x60 ? `${k}="${flip(c)}"` : m
  })
})
writeFileSync(join(dir, 'floor-light.svg'), out.join('\n'))
