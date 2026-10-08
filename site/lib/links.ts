export const REPO_URL = 'https://github.com/cjjutba/kernel'

/** Every download button points here, so the DMG downloads straight away. */
export const DOWNLOAD_URL = `${REPO_URL}/releases/latest/download/Kernel-arm64.dmg`

export const RELEASES_URL = `${REPO_URL}/releases`
export const ISSUES_URL = `${REPO_URL}/issues`
export const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE.md`
export const SECURITY_URL = `${REPO_URL}/security`

export const pullUrl = (n: number) => `${REPO_URL}/pull/${n}`
