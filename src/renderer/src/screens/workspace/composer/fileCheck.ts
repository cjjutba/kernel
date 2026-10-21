/**
 * Whether the agent has no way to open a file, read from its first bytes the way main reads them when a message goes out (`sniffBytes` in services/attachments.ts, KERNEL-907): audio, video and
 * anything that is neither text nor one of the formats an agent can open or extract. The composer asks before a file becomes a token, so a file Kernel can't use is a toast and never a token (KERNEL-1095).
 */
export async function cantOpen(file: File): Promise<boolean> {
  if (/^(audio|video)\//.test(file.type)) return true
  const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer())
  return !opens(head)
}

const ascii = (b: Uint8Array, at: number, text: string) => text.length + at <= b.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0))
const bytes = (b: Uint8Array, at: number, ...v: number[]) => v.every((x, i) => b[at + i] === x)
const HEIC = /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/

/** Images, PDFs, Office files and other zips, archives, RTF, and text open or can be extracted. A video, an audio file or binary data doesn't. */
export function opens(b: Uint8Array): boolean {
  if (!b.length) return true
  if (bytes(b, 0, 0x89, 0x50, 0x4e, 0x47) || bytes(b, 0, 0xff, 0xd8, 0xff) || ascii(b, 0, 'GIF8') || (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'))) return true
  if (ascii(b, 0, '%PDF-') || ascii(b, 0, 'PK\x03\x04') || ascii(b, 0, 'PK\x05\x06') || ascii(b, 0, '{\\rtf') || bytes(b, 0, 0xd0, 0xcf, 0x11, 0xe0)) return true
  if (bytes(b, 0, 0x1f, 0x8b) || ascii(b, 0, 'BZh') || ascii(b, 0, 'Rar!') || bytes(b, 0, 0x37, 0x7a, 0xbc, 0xaf) || bytes(b, 0, 0xfd, 0x37, 0x7a, 0x58) || ascii(b, 257, 'ustar')) return true
  if (ascii(b, 0, 'II*\0') || ascii(b, 0, 'MM\0*')) return true
  if (ascii(b, 4, 'ftyp')) return HEIC.test(String.fromCharCode(...b.subarray(8, 12)))
  if (b.includes(0)) return false
  // Text is UTF-8. The sample may end partway through a character, so up to 3 bytes at its end may be cut.
  for (let cut = 0; cut <= Math.min(3, b.length); cut++) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, b.length - cut)); return true } catch { /* try a shorter sample */ }
  }
  return false
}
