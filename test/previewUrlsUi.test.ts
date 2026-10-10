import { describe, expect, it, vi } from 'vitest'
import type { RoomSettings } from '@shared/types'

// KERNEL-250: the Preview URLs section and the Open split button in the renderer.

vi.mock('../src/renderer/src/api', () => ({ call: vi.fn() }))
const { applyPreviewUrls, applyRoomPatch } = await import('../src/renderer/src/screens/settings/useSettings')
const { addressProblem, savedUrls } = await import('../src/renderer/src/screens/settings/pages/PreviewUrls')
const { configuredTargets, detectedTarget, detectedUrl, openTarget } = await import('../src/renderer/src/screens/workspace/previewUrls')

const web = { name: 'Web app', url: 'http://localhost:$KERNEL_PORT' }
const docs = { name: 'API docs', url: 'http://localhost:$((KERNEL_PORT + 1))/docs' }

describe('saving the list', () => {
  it('drops a row with no address and trims the rest', () => {
    expect(savedUrls([{ name: ' Web app ', url: ' http://localhost:3000 ' }, { name: 'Empty', url: '  ' }])).toEqual([{ name: 'Web app', url: 'http://localhost:3000' }])
    expect(savedUrls([{ name: 'a', url: '' }])).toEqual([])
  })

  it('asks for an address Open can use', () => {
    expect(addressProblem('')).toMatch(/Enter the address/)
    expect(addressProblem('ftp://localhost:$KERNEL_PORT')).toMatch(/http or https/)
    expect(addressProblem('http://localhost:$((KERNEL_PORT + 12))')).toMatch(/http or https/)
    expect(addressProblem('http://localhost:$((KERNEL_PORT + 1))/docs')).toBeUndefined()
    expect(addressProblem('https://example.com')).toBeUndefined()
  })
})

describe('applyPreviewUrls', () => {
  it('replaces the whole list and marks it personal, or an override of settings.toml', () => {
    const sources: RoomSettings['sources'] = {}
    expect(applyPreviewUrls([], sources, [web])).toEqual([web])
    expect(sources['preview.urls']).toBe('local')
    const shared: RoomSettings['sources'] = { 'preview.urls': 'shared' }
    expect(applyPreviewUrls([web, docs], shared, [docs])).toEqual([docs])
    expect(shared['preview.urls']).toBe('override')
  })

  it('keeps settings.toml\'s list when the personal one is emptied or reset', () => {
    const sources: RoomSettings['sources'] = { 'preview.urls': 'override' }
    expect(applyPreviewUrls([docs], sources, [{ name: 'x', url: '' }])).toEqual([docs])
    expect(sources['preview.urls']).toBe('shared')
    const mine: RoomSettings['sources'] = { 'preview.urls': 'local' }
    expect(applyPreviewUrls([web], mine, null)).toEqual([])
    expect(mine['preview.urls']).toBeUndefined()
  })

  it('leaves the list alone when the patch has no urls', () => {
    expect(applyPreviewUrls([web], {}, undefined)).toEqual([web])
  })

  it('is read from a room patch', () => {
    const rs = { scripts: {}, files: { copy: [] }, workspace: {}, runScripts: [], preview: { urls: [] }, sources: {} } as unknown as RoomSettings
    const next = applyRoomPatch(rs, { preview: { urls: [web] } })
    expect(next.preview.urls).toEqual([web])
    expect(next.sources['preview.urls']).toBe('local')
    expect(applyRoomPatch(next, { preview: { urls: null } }).preview.urls).toEqual([])
  })
})

describe('Open', () => {
  it('opens the first configured URL with the workspace port filled in', () => {
    expect(openTarget([web, docs], 4312, 'http://localhost:4314')).toBe('http://localhost:4312')
    expect(openTarget([docs, web], 4312, null)).toBe('http://localhost:4313/docs')
  })

  it('uses the detected URL when none is configured, and is off until one is printed', () => {
    expect(openTarget([], 4312, 'http://localhost:4314')).toBe('http://localhost:4314')
    expect(openTarget([], 4312, null)).toBeNull()
  })

  it('is off when the first address has a port form that can\'t be filled', () => {
    expect(openTarget([{ name: 'x', url: 'http://localhost:$((KERNEL_PORT + 12))' }, web], 4312, 'http://localhost:4314')).toBeNull()
  })

  it('lists each URL by name with its address, and the unfillable one as off', () => {
    expect(configuredTargets([web, docs, { name: '', url: 'http://localhost:$((KERNEL_PORT + 12))' }], 4312)).toEqual([
      { id: 'url:0', label: 'Web app', address: 'localhost:4312', url: 'http://localhost:4312' },
      { id: 'url:1', label: 'API docs', address: 'localhost:4313/docs', url: 'http://localhost:4313/docs' },
      { id: 'url:2', label: 'localhost:$((KERNEL_PORT + 12))', address: 'localhost:$((KERNEL_PORT + 12))', url: null }
    ])
    expect(detectedTarget('http://localhost:4314')).toEqual({ id: 'detected', label: 'Detected', address: 'localhost:4314', url: 'http://localhost:4314' })
    expect(detectedTarget(null).url).toBeNull()
  })

  it('takes the detected URL of the room\'s first script that printed one', () => {
    expect(detectedUrl(undefined, ['run'])).toBeNull()
    expect(detectedUrl({ backend: 'http://localhost:4313', run: 'http://localhost:4312' }, ['run', 'backend'])).toBe('http://localhost:4312')
    expect(detectedUrl({ gone: 'http://localhost:4399' }, ['run'])).toBe('http://localhost:4399')
  })
})
