import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const showSaveDialog = vi.fn()
vi.mock('electron', () => ({ app: { getPath: () => '/Users/me/Downloads' }, dialog: { showSaveDialog }, Menu: {}, nativeImage: {} }))
const { decodeDataUrl, imageFileName, imageMenuItems, saveImage } = await import('../src/main/imageMenu')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const image = (over: Partial<Parameters<typeof imageMenuItems>[0]> = {}) =>
  ({ mediaType: 'image' as const, hasImageContents: true, srcURL: `data:image/png;base64,${PNG.toString('base64')}`, altText: '', x: 10, y: 20, ...over })
const act = { copy: vi.fn(), save: vi.fn() }
const wc = { isDestroyed: () => false } as never

describe('imageMenuItems', () => {
  it('offers Copy Image and Save Image… on an image', () => {
    const items = imageMenuItems(image(), act)
    expect(items.map((i) => i.label)).toEqual(['Copy Image', 'Save Image…'])
    ;(items[0].click as () => void)()
    expect(act.copy).toHaveBeenCalled()
  })
  it('offers nothing on text, a link, a canvas or an image that never loaded', () => {
    expect(imageMenuItems(image({ mediaType: 'none' }), act)).toEqual([])
    expect(imageMenuItems(image({ mediaType: 'canvas' }), act)).toEqual([])
    expect(imageMenuItems(image({ hasImageContents: false }), act)).toEqual([])
  })
})

describe('imageFileName', () => {
  it('takes the alt text, or its last segment when it is a path', () => {
    expect(imageFileName({ srcURL: 'data:,', altText: 'Mock' }, 'image/png')).toBe('Mock.png')
    expect(imageFileName({ srcURL: 'data:,', altText: 'Before: src/assets/logo.png' }, 'image/png')).toBe('logo.png')
  })
  it("falls back to the URL's last segment, then to image", () => {
    expect(imageFileName({ srcURL: 'file:///tmp/shots/Board%20view.jpeg?v=2', altText: '' }, 'image/png')).toBe('Board view.png')
    expect(imageFileName({ srcURL: 'data:image/png;base64,AAAA', altText: '' }, 'image/png')).toBe('image.png')
    expect(imageFileName({ srcURL: 'data:image/png;base64,AAAA', altText: '  ' })).toBe('image.png')
  })
  it('takes the extension from the MIME type, and png for one it does not know', () => {
    expect(imageFileName({ srcURL: 'data:,', altText: 'photo.png' }, 'image/jpeg')).toBe('photo.jpg')
    expect(imageFileName({ srcURL: 'data:,', altText: 'a' }, 'image/webp')).toBe('a.webp')
    expect(imageFileName({ srcURL: 'data:,', altText: 'a' }, 'image/svg+xml')).toBe('a.svg')
    expect(imageFileName({ srcURL: 'data:,', altText: 'a' }, 'image/x-made-up')).toBe('a.png')
  })
  it('drops characters a file name cannot hold', () => {
    expect(imageFileName({ srcURL: 'data:,', altText: 'a*b?"c' }, 'image/gif')).toBe('a b c.gif')
  })
})

describe('decodeDataUrl', () => {
  it('decodes base64 and plain data URLs, and leaves other URLs', () => {
    expect(decodeDataUrl(image().srcURL)).toEqual({ mime: 'image/png', bytes: PNG })
    expect(decodeDataUrl('data:image/svg+xml,%3Csvg%2F%3E')).toEqual({ mime: 'image/svg+xml', bytes: Buffer.from('<svg/>') })
    expect(decodeDataUrl('file:///tmp/a.png')).toBeNull()
  })
})

describe('saveImage', () => {
  it('offers a name in Downloads and writes the decoded bytes', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'kernel-image-')), 'saved.png')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: out })
    await saveImage(wc, image({ altText: 'shot' }))
    expect(showSaveDialog).toHaveBeenLastCalledWith({ defaultPath: '/Users/me/Downloads/shot.png' })
    expect(readFileSync(out)).toEqual(PNG)
  })
  it('writes nothing on cancel', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'kernel-image-')), 'saved.png')
    showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: out })
    await saveImage(wc, image())
    expect(existsSync(out)).toBe(false)
  })
  it('logs a failed write instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(tmpdir(), 'no-such-folder-kernel', 'x', 'a.png') })
    await expect(saveImage(wc, image())).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith('[kernel] could not save the image', expect.any(Error))
    error.mockRestore()
  })
})
