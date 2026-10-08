// Playwright's web server: a stub GitHub API that reports 1,234 stars, a production build that reads it,
// and `next start` on port 3100. The build goes to .next-e2e so it never replaces a dev or production build.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

export const STUB_STARS = 1234
const STUB_PORT = 4010
const PORT = 3100

const stub = createServer((req, res) => {
  if (req.url === '/repos/cjjutba/kernel') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ stargazers_count: STUB_STARS }))
  } else {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve))

const env = {
  ...process.env,
  NEXT_DIST_DIR: '.next-e2e',
  GITHUB_API_URL: `http://127.0.0.1:${STUB_PORT}`,
  NEXT_PUBLIC_SITE_URL: `http://localhost:${PORT}`
}
delete env.GITHUB_TOKEN

// Async on purpose: a blocking spawn would also block the stub, and the build's GitHub fetch would time out.
const status = await new Promise((resolve) => spawn('npx', ['next', 'build'], { env, stdio: 'inherit' }).on('exit', resolve))
if (status !== 0) process.exit(status ?? 1)
stub.close()

const server = spawn('npx', ['next', 'start', '-p', String(PORT)], { env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal))
server.on('exit', (code) => process.exit(code ?? 0))
