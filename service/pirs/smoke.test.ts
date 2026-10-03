// Qualifies cleanup after success and after an API failure with an account
// already created. All supplied operator paths are disposable sentinels.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const smoke = fileURLToPath(new URL('./smoke.ts', import.meta.url))
const failWrite = `
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (String(input).endsWith('/com.atproto.repo.createRecord')) {
    console.log('failure probe PLC:', process.env.PDS_DID_PLC_URL);
    const body = JSON.parse(init.body);
    body.record.text = 42;
    init = { ...init, body: JSON.stringify(body) };
  }
  return fetch(input, init);
};`

for (const rejectWrite of [false, true]) {
  test(`smoke cleans up after ${rejectWrite ? 'a rejected record write' : 'success'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pirs-cleanup-'))
    const operatorData = join(root, 'operator-data')
    await mkdir(operatorData)
    await writeFile(join(operatorData, 'sentinel'), 'preserve')
    try {
      const args = rejectWrite
        ? ['--import', `data:text/javascript,${encodeURIComponent(failWrite)}`, smoke]
        : [smoke]
      const child = spawn(process.execPath, args, {
        env: {
          ...process.env,
          TMPDIR: root,
          PDS_DATA_DIRECTORY: operatorData,
          PDS_DID_PLC_URL: 'https://plc.directory',
          PDS_ENTRYWAY_URL: 'http://127.0.0.1:1',
          PDS_EMAIL_SMTP_URL: 'smtp://127.0.0.1:1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stderr.on('data', (chunk) => { output += chunk })
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      }).finally(() => clearTimeout(timer))
      assert.equal(code, rejectWrite ? 1 : 0, output)
      assert.match(output, rejectWrite
        ? /com\.atproto\.repo\.createRecord returned 400/
        : /counts: \{ commit: 2, sync: 1, identity: 1, account: 1 \}/)
      const plcUrl = output.match(/http:\/\/localhost:\d+/)?.[0]
      assert.ok(plcUrl, output)
      await assert.rejects(fetch(plcUrl, { signal: AbortSignal.timeout(1_000) }))
      const port = process.env.PIRS_SMOKE_PORT ?? '2597'
      await assert.rejects(fetch(`http://127.0.0.1:${port}/_pirs/status`, {
        signal: AbortSignal.timeout(1_000)
      }))
      assert.deepEqual(await readdir(root), ['operator-data'])
      assert.equal(await readFile(join(operatorData, 'sentinel'), 'utf8'), 'preserve')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
