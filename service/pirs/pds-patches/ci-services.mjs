// Read only this job's labelled disposable services through the runner socket.
// Older act_runner versions leave job.services.*.ports expressions empty.
import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { request } from 'node:http'

const job = process.env.PIRS_CI_JOB
assert.match(job ?? '', /^\d+-(stock|patched)$/)
assert.ok(process.env.GITHUB_ENV, 'runner environment file required')

function docker(path) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: '/var/run/docker.sock', path, method: 'GET', timeout: 5000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('error', reject)
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 200, `Docker GET ${path} failed`)
          resolve(JSON.parse(body))
        } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Docker API timeout')))
    req.end()
  })
}

const filters = encodeURIComponent(JSON.stringify({ label: [`pirs.ci.job=${job}`] }))
const containers = await docker(`/containers/json?filters=${filters}`)
const ports = {}
for (const [name, image, privatePort] of [
  ['postgres', 'postgres:14.4-alpine', 5432],
  ['redis', 'redis:7.0-alpine', 6379],
]) {
  const matches = containers.filter((c) => c.Labels['pirs.ci.service'] === name)
  assert.equal(matches.length, 1, `expected exactly one ${name} service for ${job}`)
  const container = matches[0]
  assert.equal(container.Image, image, `unexpected ${name} image`)
  const published = container.Ports.filter((p) => p.PrivatePort === privatePort && p.Type === 'tcp' && p.PublicPort)
  const assigned = [...new Set(published.map((p) => p.PublicPort))]
  assert.equal(assigned.length, 1, `missing or ambiguous ${name} published port`)
  assert.ok(Number.isInteger(assigned[0]) && assigned[0] > 0 && assigned[0] <= 65535)
  const inspected = await docker(`/containers/${container.Id}/json`)
  assert.equal(inspected.State.Health?.Status, 'healthy', `${name} must be healthy`)
  ports[name] = assigned[0]
}
await appendFile(process.env.GITHUB_ENV,
  `DB_POSTGRES_URL=postgresql://pg:password@127.0.0.1:${ports.postgres}/postgres\n` +
  `REDIS_HOST=127.0.0.1:${ports.redis}\n`)
console.log(`Resolved healthy disposable service ports for ${job}`)
