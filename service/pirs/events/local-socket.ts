import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, realpath, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { basename, dirname, isAbsolute, join } from 'node:path'

// A socket in a private directory is the local access boundary. Never replace
// a regular file or a live listener when recovering after a process crash.
export async function listenPrivate(server: Server, path: string) {
  if (process.platform !== 'linux') throw new Error('qualified local transport requires Linux')
  if (!isAbsolute(path)) throw new Error('socket path must be absolute')
  const parent = dirname(path)
  await mkdir(parent, { mode: 0o700, recursive: true })
  const dir = await lstat(parent)
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== 0o700) {
    throw new Error('socket parent must be an owned directory with mode 0700')
  }
  // Reserve the canonical pathname in Linux's abstract socket namespace before
  // probing/removing a stale filesystem socket. The kernel releases this guard
  // on SIGKILL, and simultaneous restarts cannot unlink each other's listener.
  const identity = createHash('sha256').update(join(await realpath(parent), basename(path))).digest('hex')
  const guard = createServer((connection) => connection.destroy())
  await new Promise<void>((resolve, reject) => {
    guard.once('error', () => reject(new Error('socket is already active')))
    guard.listen(`\0pirs-${dir.uid}-${identity}`, () => resolve())
  })
  const closeGuard = () => new Promise<void>((resolve) => guard.close(() => resolve()))
  try {
    try {
      const previous = await lstat(path)
      if (!previous.isSocket() || previous.uid !== dir.uid) throw new Error('socket path is occupied')
      await new Promise<void>((resolve, reject) => {
        const probe = createConnection(path)
        probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('socket probe timed out')) })
        probe.once('connect', () => { probe.destroy(); reject(new Error('socket is already active')) })
        probe.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'ECONNREFUSED') resolve()
          else reject(error)
        })
      })
      const current = await lstat(path)
      if (current.ino !== previous.ino || current.dev !== previous.dev) throw new Error('socket changed during recovery')
      await unlink(path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => { server.off('error', reject); resolve() })
    })
    await chmod(path, 0o600)
  } catch (error) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeGuard()
    throw error
  }
  return async () => {
    if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeGuard()
  }
}
