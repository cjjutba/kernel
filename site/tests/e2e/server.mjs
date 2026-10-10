// Playwright's web server: a stub GitHub API that reports 1,234 stars, two production builds that read it, and
// `next start` for each. Port 3100 serves the site's own content. Port 3101 serves tests/fixtures/render, the
// releases and plans design/site/renders shows, for the render comparison in visual.spec.ts (D-135). Each build
// goes to its own folder so it never replaces a dev or production build.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

export const STUB_STARS = 1234
const STUB_PORT = 4010
const PORT = 3100
const RENDER_PORT = 3101

const stub = createServer((req, res) => {
  if (req.url === '/repos/cjjutba/kernel') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ stargazers_count: STUB_STARS }))
  } else {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve))

const base = { ...process.env, GITHUB_API_URL: `http://127.0.0.1:${STUB_PORT}` }
delete base.GITHUB_TOKEN
delete base.CHANGELOG_FIXTURE

const render = {
  port: RENDER_PORT,
  env: {
    ...base,
    NEXT_DIST_DIR: '.next-e2e-render',
    NEXT_PUBLIC_SITE_URL: `http://localhost:${RENDER_PORT}`,
    CHANGELOG_FIXTURE: fileURLToPath(new URL('../fixtures/render', import.meta.url))
  }
}
const site = { port: PORT, env: { ...base, NEXT_DIST_DIR: '.next-e2e', NEXT_PUBLIC_SITE_URL: `http://localhost:${PORT}` } }

// Async on purpose: a blocking spawn would also block the stub, and the build's GitHub fetch would time out.
// One at a time, and the site's own build last, so next-env.d.ts ends up pointing at .next-e2e.
for (const { env } of [render, site]) {
  const status = await new Promise((resolve) => spawn('npx', ['next', 'build'], { env, stdio: 'inherit' }).on('exit', resolve))
  if (status !== 0) process.exit(status ?? 1)
}
stub.close()

const servers = []
function start({ port, env }) {
  const server = spawn('npx', ['next', 'start', '-p', String(port)], { env, stdio: 'inherit' })
  servers.push(server)
  // Either server stopping ends the run, and takes the other one with it.
  server.on('exit', (code) => {
    for (const s of servers) s.kill()
    process.exit(code ?? 0)
  })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => servers.forEach((s) => s.kill(signal)))

// Playwright waits for port 3100 only, so the render server has to answer before the site starts.
start(render)
for (let tries = 0; ; tries++) {
  const up = await fetch(`http://localhost:${RENDER_PORT}`).then((r) => r.ok, () => false)
  if (up) break
  if (tries === 600) throw new Error(`next start on port ${RENDER_PORT} never answered`)
  await new Promise((resolve) => setTimeout(resolve, 100))
}
start(site)
