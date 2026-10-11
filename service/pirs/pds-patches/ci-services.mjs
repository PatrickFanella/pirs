// Read only this job's labelled disposable services through the runner socket.
// Older act_runner versions leave job.services.*.ports expressions empty.
import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { request } from 'node:http'
import { connect, isIP } from 'node:net'

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
const endpoints = {}
for (const [name, image, privatePort] of [
  ['postgres', 'postgres:14.4-alpine', 5432],
  ['redis', 'redis:7.0-alpine', 6379],
]) {
  const matches = containers.filter((c) => c.Labels['pirs.ci.service'] === name)
  assert.equal(matches.length, 1, `expected exactly one ${name} service for ${job}`)
  const container = matches[0]
  assert.equal(container.Image, image, `unexpected ${name} image`)
  const deadline = Date.now() + 60_000
  let inspected
  while (true) {
    inspected = await docker(`/containers/${container.Id}/json`)
    assert.equal(inspected.State.Running, true, `${name} service stopped`)
    const health = inspected.State.Health?.Status
    if (health === 'healthy') break
    assert.equal(health, 'starting', `${name} service is not healthy`)
    assert.ok(Date.now() < deadline, `${name} readiness timed out after 60 seconds`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.equal(inspected.HostConfig.NetworkMode, 'bridge', `${name} must use the runner bridge`)
  const address = inspected.NetworkSettings.Networks.bridge?.IPAddress
  assert.equal(isIP(address ?? ''), 4, `missing ${name} bridge IPv4 address`)
  await new Promise((resolve, reject) => {
    const socket = connect({ host: address, port: privatePort, timeout: 5000 })
    socket.once('connect', () => { socket.destroy(); resolve() })
    socket.once('error', reject)
    socket.once('timeout', () => socket.destroy(new Error(`${name} endpoint unreachable from job`)))
  })
  endpoints[name] = `${address}:${privatePort}`
}
await appendFile(process.env.GITHUB_ENV,
  `DB_POSTGRES_URL=postgresql://pg:password@${endpoints.postgres}/postgres\n` +
  `REDIS_HOST=${endpoints.redis}\n`)
console.log(`Resolved and connected to healthy disposable services for ${job}`)
