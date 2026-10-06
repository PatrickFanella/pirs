import { spawn } from 'node:child_process'
import { once } from 'node:events'

export class Runtime {
  child: ReturnType<typeof spawn>
  private line = Buffer.alloc(0)
  outputCeiling = 32768
  private queued: unknown[] = []
  private waiter?: { resolve: (value: unknown) => void; reject: (error: Error) => void }
  private failure?: Error

  constructor(options: { host: string; installation: string; stateDir?: string; deadlineMs: number; responseBytes: number }) {
    this.child = spawn(options.host, ['--installation', options.installation,
      ...(options.stateDir ? ['--state-dir', options.stateDir] : []),
      '--parent-pid', String(process.pid), '--input-bytes', '65536', '--deadline-ms', String(options.deadlineMs), '--response-bytes', String(options.responseBytes)],
      { env: {}, stdio: 'pipe' })
    this.child.stdout!.on('data', (chunk: Buffer) => {
      try {
        this.line = Buffer.concat([this.line, chunk])
        if (this.line.length > this.outputCeiling) throw new Error('runtime output exceeds limit')
        let end: number
        while ((end = this.line.indexOf(10)) !== -1) {
          const value: unknown = JSON.parse(this.line.subarray(0, end).toString('utf8'))
          this.line = this.line.subarray(end + 1)
          if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(value) }
          else if (!this.queued.length) this.queued.push(value)
          else throw new Error('unsolicited runtime output')
        }
      } catch { this.fail(); this.child.kill('SIGKILL') }
    })
    this.child.stderr!.resume()
    this.child.stdin!.on('error', () => this.fail())
    this.child.once('error', () => this.fail())
    this.child.once('exit', () => this.fail())
  }

  private fail() {
    this.failure = new Error('PluginUnavailable')
    this.waiter?.reject(this.failure)
    this.waiter = undefined
  }

  response(timeout: number): Promise<any> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.queued.length) return Promise.resolve(this.queued.shift())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(); this.child.kill('SIGKILL') }, timeout)
      this.waiter = {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) }
      }
    })
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = once(this.child, 'exit')
    this.child.kill('SIGKILL')
    await exited
  }
}

