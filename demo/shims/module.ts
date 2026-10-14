// Browser stand-in for node:module. createRequire is called at load time by bundled code; the require it returns throws if used.
export const createRequire = () => (id: string) => { throw new Error(`Not available in the demo: require(${id})`) }
export default { createRequire }
