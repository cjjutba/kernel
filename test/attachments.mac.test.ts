import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { run } from '../src/main/services/exec'
import { withAttachments } from '../src/main/services/attachments'

// Mac only (vitest.config.ts leaves `*.mac.test.ts` out anywhere else): the quarantine flag is a macOS extended attribute,
// and HEIC, TIFF and BMP go to PNG with macOS's sips (KERNEL-907).

const QUARANTINE = 'com.apple.quarantine'
const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A 2x2 24-bit BMP, which sips reads, so a test can make a HEIC from it. */
function bmp(): Buffer {
  const row = Buffer.from([0, 0, 255, 0, 255, 0, 0, 0]) // two pixels and two bytes of padding to 4
  const pixels = Buffer.concat([row, row])
  const header = Buffer.alloc(54)
  header.write('BM', 0, 'latin1')
  header.writeUInt32LE(54 + pixels.length, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(2, 18)
  header.writeInt32LE(2, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(pixels.length, 34)
  return Buffer.concat([header, pixels])
}

describe('attached files on macOS (KERNEL-907)', () => {
  it('keeps the quarantine flag of a downloaded file on its copy', async () => {
    const repo = await tempRepo()
    const dl = await mkdtemp(join(tmpdir(), 'kernel-downloads-'))
    const src = join(dl, 'invoice.pdf')
    await writeFile(src, '%PDF-1.4\n%%EOF\n')
    const flag = '0083;6710a1b2;Safari;'
    await run('xattr', ['-w', QUARANTINE, flag, src])
    const [part] = await withAttachments(repo, [{ type: 'file', name: 'invoice.pdf', src }])
    expect(part).toMatchObject({ path: '.kernel/attachments/1/invoice.pdf', kind: 'pdf' })
    expect((await run('xattr', ['-p', QUARANTINE, join(repo, '.kernel/attachments/1/invoice.pdf')])).trim()).toBe(flag)
  })

  it('saves a HEIC photo and a BMP as PNGs the agent can open', async () => {
    const repo = await tempRepo()
    const dl = await mkdtemp(join(tmpdir(), 'kernel-downloads-'))
    await writeFile(join(dl, 'shot.bmp'), bmp())
    await run('sips', ['-s', 'format', 'heic', join(dl, 'shot.bmp'), '--out', join(dl, 'IMG_0001.HEIC')])
    const parts = await withAttachments(repo, [
      { type: 'file', name: 'IMG_0001.HEIC', src: join(dl, 'IMG_0001.HEIC') },
      { type: 'file', name: 'shot.bmp', src: join(dl, 'shot.bmp') }
    ])
    expect(parts).toMatchObject([
      { name: 'IMG_0001.HEIC', path: '.kernel/attachments/1/img-0001.png', kind: 'image', readable: true },
      { name: 'shot.bmp', path: '.kernel/attachments/1/shot.png', kind: 'image', readable: true }
    ])
    for (const p of ['img-0001.png', 'shot.png']) expect((await readFile(join(repo, '.kernel/attachments/1', p))).subarray(0, 8)).toEqual(PNG_START)
  })
})
