// Browser stand-in for node:fs. Some modules read fs.constants at load; every call throws if used.
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 512, O_EXCL: 2048, O_TRUNC: 1024, O_APPEND: 8, O_NOFOLLOW: 256, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960 }
const no = (name: string) => () => { throw new Error(`Not available in the demo: fs.${name}`) }
export const existsSync = () => false
export const readFileSync = no('readFileSync')
export const writeFileSync = no('writeFileSync')
export const statSync = no('statSync')
export const watch = no('watch')
export const createReadStream = no('createReadStream')
export const createWriteStream = no('createWriteStream')
export default { constants, existsSync, readFileSync, writeFileSync, statSync, watch, createReadStream, createWriteStream }
