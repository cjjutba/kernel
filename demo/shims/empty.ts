// Browser stand-in for Node modules the demo never calls (fs, child_process, os, net, ...).
// Rollup's shimMissingExports turns every named import of this file into undefined, so importing works and calling throws.
const unavailable = new Proxy({}, { get: (_t, key) => (key === '__esModule' ? false : () => { throw new Error(`Not available in the demo: ${String(key)}`) }) })
export default unavailable
