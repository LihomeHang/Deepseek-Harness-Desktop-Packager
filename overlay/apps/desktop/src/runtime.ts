import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

/** Inputs whose Electron-owned values locate the desktop and CLI runtimes. */
export interface DesktopPathOptions {
  appPath: string
  developmentNodePath: string
  isPackaged: boolean
  resourcesPath: string
}

/** Executables used to start the local Harness Web server. */
export interface DesktopPaths {
  cliEntry: string
  nodeExecutable: string
}

/** Resolve development artifacts or files installed beside the packaged application. */
export function resolveDesktopPaths(options: DesktopPathOptions): DesktopPaths {
  if (!options.isPackaged) {
    const repositoryRoot = resolve(options.appPath, '..', '..')
    return {
      cliEntry: join(repositoryRoot, 'apps', 'cli', 'lib', 'bin.js'),
      nodeExecutable: options.developmentNodePath,
    }
  }
  return {
    cliEntry: join(options.appPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    nodeExecutable: join(options.resourcesPath, 'node-runtime', 'node.exe'),
  }
}

/** Inputs for the isolated local Web server process. */
export interface BackendSpawnOptions {
  baseEnv: NodeJS.ProcessEnv
  cliEntry: string
  dshHome: string
  nodeExecutable: string
  port: number
  workspaceRoot: string
}

/** Serializable subset of child_process.spawn arguments owned by the desktop app. */
export interface BackendSpawnSpec {
  args: string[]
  command: string
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdio: ['ignore', 'pipe', 'pipe']
    windowsHide: true
  }
}

/** Build the backend command without leaking Electron's Node-mode override. */
export function createBackendSpawnSpec(options: BackendSpawnOptions): BackendSpawnSpec {
  const env: NodeJS.ProcessEnv = {
    ...options.baseEnv,
    DSH_HOME: options.dshHome,
    NODE_USE_ENV_PROXY: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  return {
    args: [options.cliEntry, 'web', '--host', '127.0.0.1', '--port', String(options.port)],
    command: options.nodeExecutable,
    options: {
      cwd: options.workspaceRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  }
}

/** Return whether a loopback TCP port can be bound exclusively. */
export async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveAvailable) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolveAvailable(false))
    server.listen({ exclusive: true, host: '127.0.0.1', port }, () => {
      server.close(error => resolveAvailable(error === undefined))
    })
  })
}

/** Select the first available port from one bounded consecutive range. */
export async function findAvailablePort(
  firstPort: number,
  attempts: number,
  probe: (port: number) => Promise<boolean> = isLoopbackPortAvailable,
): Promise<number> {
  if (!Number.isInteger(firstPort) || firstPort < 1 || firstPort > 65_535) {
    throw new Error(`Invalid first loopback port: ${firstPort}.`)
  }
  if (!Number.isInteger(attempts) || attempts < 1 || firstPort + attempts - 1 > 65_535) {
    throw new Error(`Invalid loopback port attempt count: ${attempts}.`)
  }
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = firstPort + offset
    if (await probe(port)) return port
  }
  throw new Error(`No loopback port is available in range ${firstPort}-${firstPort + attempts - 1}.`)
}

/** Injectable dependencies for deterministic HTTP readiness checks. */
export interface HttpReadyOptions {
  fetchImpl?: typeof fetch
  intervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
}

const defaultSleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>(resolveSleep => setTimeout(resolveSleep, milliseconds))
}

/** Wait until the local server returns a successful HTTP response. */
export async function waitForHttpReady(url: string, options: HttpReadyOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const intervalMs = options.intervalMs ?? 200
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const timeoutMs = options.timeoutMs ?? 30_000
  const startedAt = now()
  for (;;) {
    try {
      const response = await fetchImpl(url)
      if (response.ok) return
    } catch {
      // Startup polling owns connection failures until the shared deadline.
    }
    if (now() - startedAt >= timeoutMs) {
      throw new Error(`DeepSeek Harness did not become ready at ${url} within ${timeoutMs} ms.`)
    }
    await sleep(intervalMs)
  }
}

/** Minimal backend handle required for process-tree shutdown. */
export interface BackendProcessHandle {
  exited: boolean
  pid?: number
  terminate?: () => void
  waitForExit: () => Promise<void>
}

/** Injectable process operations for Windows and POSIX shutdown. */
export interface StopProcessTreeOptions {
  platform?: NodeJS.Platform
  runTaskkill?: (args: string[]) => Promise<void>
}

const runTaskkill = async (args: string[]): Promise<void> => {
  await new Promise<void>((resolveTaskkill, rejectTaskkill) => {
    const child = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true })
    child.once('error', rejectTaskkill)
    child.once('exit', () => resolveTaskkill())
  })
}

/** Request termination of the backend process tree and wait for its exit. */
export async function stopProcessTree(
  child: BackendProcessHandle,
  options: StopProcessTreeOptions = {},
): Promise<void> {
  if (child.exited) return
  if (child.pid === undefined) throw new Error('Cannot stop the DeepSeek Harness backend before it has a process id.')
  if ((options.platform ?? process.platform) === 'win32') {
    await (options.runTaskkill ?? runTaskkill)(['/PID', String(child.pid), '/T', '/F'])
  } else if (child.terminate !== undefined) {
    child.terminate()
  } else {
    process.kill(child.pid, 'SIGTERM')
  }
  await child.waitForExit()
}
