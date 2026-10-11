import type { SharedFile, SharedVersion } from '@shared/types'
import { useThumb } from './shared'

export type PreviewWidth = 'desktop' | 'tablet' | 'phone'

/**
 * Where an HTML page or a PDF runs in its tab. For now it shows the version's still capture; KERNEL-306 puts the locked-down native view here
 * with the same props. `again` counts Reload presses. A page is drawn in a frame as wide as the width asks, a PDF as a page.
 */
export function PreviewSurface({ file, version, width, again }: { file: SharedFile; version: SharedVersion; width: PreviewWidth; again: number }) {
  const still = useThumb(file, version, again)
  const alt = `Still capture of ${file.title}, version ${version.n}`
  if (!still) return <p className="shared-none">No preview yet</p>
  if (file.kind === 'pdf') return <img className="shared-page" src={still} alt={alt} />
  return <div className="shared-frame" data-width={width}><img src={still} alt={alt} /></div>
}
