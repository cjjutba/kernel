// Browser stand-in for node:crypto. randomUUID is real; hashes are a cheap non-cryptographic digest, fine for ids in a demo.
export const randomUUID = (): string => globalThis.crypto.randomUUID()
export const randomBytes = (n: number) => { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return { toString: () => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('') } }
export const createHash = () => {
  let s = ''
  const h = {
    update(v: unknown) { s += String(v); return h },
    digest() { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) } return (x >>> 0).toString(16).padStart(8, '0').repeat(5) }
  }
  return h
}
export default { randomUUID, randomBytes, createHash }
