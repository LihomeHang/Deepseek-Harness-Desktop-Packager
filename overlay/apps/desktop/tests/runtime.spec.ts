import { describe, expect, it, vi } from 'vitest'
import {
  createBackendSpawnSpec,
  findAvailablePort,
  resolveDesktopPaths,
  stopProcessTree,
  waitForHttpReady,
} from '../src/runtime.ts'

describe('desktop runtime paths', () => {
  it('uses repository artifacts and the configured Node executable during development', () => {
    expect(resolveDesktopPaths({
      appPath: 'D:\\repo\\apps\\desktop',
      developmentNodePath: 'D:\\node\\node.exe',
      isPackaged: false,
      resourcesPath: 'D:\\unused',
    })).toEqual({
      cliEntry: 'D:\\repo\\apps\\cli\\lib\\bin.js',
      nodeExecutable: 'D:\\node\\node.exe',
    })
  })

  it('uses the bundled Node executable and deployed CLI after packaging', () => {
    expect(resolveDesktopPaths({
      appPath: 'C:\\Program Files\\DeepSeek Harness\\resources\\app',
      developmentNodePath: 'D:\\node\\node.exe',
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\DeepSeek Harness\\resources',
    })).toEqual({
      cliEntry: 'C:\\Program Files\\DeepSeek Harness\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      nodeExecutable: 'C:\\Program Files\\DeepSeek Harness\\resources\\node-runtime\\node.exe',
    })
  })
})

describe('desktop backend startup', () => {
  it('passes the loopback server address and isolates persistent data from the workspace', () => {
    expect(createBackendSpawnSpec({
      baseEnv: {
        ELECTRON_RUN_AS_NODE: '1',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        PATH: 'D:\\bin',
      },
      cliEntry: 'D:\\app\\bin.js',
      dshHome: 'C:\\Users\\me\\AppData\\Roaming\\DeepSeek Harness\\dsh-home',
      nodeExecutable: 'D:\\app\\node.exe',
      port: 3083,
      workspaceRoot: 'C:\\Users\\me\\Documents\\DeepSeek Harness Workspace',
    })).toEqual({
      args: ['D:\\app\\bin.js', 'web', '--host', '127.0.0.1', '--port', '3083'],
      command: 'D:\\app\\node.exe',
      options: {
        cwd: 'C:\\Users\\me\\Documents\\DeepSeek Harness Workspace',
        env: {
          DSH_HOME: 'C:\\Users\\me\\AppData\\Roaming\\DeepSeek Harness\\dsh-home',
          HTTPS_PROXY: 'http://127.0.0.1:7890',
          NODE_USE_ENV_PROXY: '1',
          PATH: 'D:\\bin',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    })
  })

  it('selects the first available port in order', async () => {
    const probe = vi.fn(async (port: number) => port === 3082)

    await expect(findAvailablePort(3080, 5, probe)).resolves.toBe(3082)
    expect(probe.mock.calls).toEqual([[3080], [3081], [3082]])
  })

  it('fails when the configured port range is exhausted', async () => {
    await expect(findAvailablePort(3080, 2, async () => false)).rejects.toThrow(
      'No loopback port is available in range 3080-3081.',
    )
  })

  it('waits through transient connection failures until the server responds successfully', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    const sleep = vi.fn(async () => undefined)

    await expect(waitForHttpReady('http://127.0.0.1:3080/', {
      fetchImpl,
      intervalMs: 25,
      sleep,
      timeoutMs: 1_000,
    })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('reports the target URL when startup times out', async () => {
    await expect(waitForHttpReady('http://127.0.0.1:3080/', {
      fetchImpl: async () => {
        throw new Error('connection refused')
      },
      intervalMs: 1,
      now: vi.fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(100),
      sleep: async () => undefined,
      timeoutMs: 50,
    })).rejects.toThrow('DeepSeek Harness did not become ready at http://127.0.0.1:3080/ within 50 ms.')
  })
})

describe('desktop backend shutdown', () => {
  it('terminates and waits for the complete Windows process tree', async () => {
    const waitForExit = vi.fn(async () => undefined)
    const runTaskkill = vi.fn(async () => undefined)

    await stopProcessTree({ exited: false, pid: 4242, waitForExit }, {
      platform: 'win32',
      runTaskkill,
    })

    expect(runTaskkill).toHaveBeenCalledWith(['/PID', '4242', '/T', '/F'])
    expect(waitForExit).toHaveBeenCalledOnce()
  })

  it('does nothing when the backend has already exited', async () => {
    const runTaskkill = vi.fn(async () => undefined)
    const waitForExit = vi.fn(async () => undefined)

    await stopProcessTree({ exited: true, pid: 4242, waitForExit }, {
      platform: 'win32',
      runTaskkill,
    })

    expect(runTaskkill).not.toHaveBeenCalled()
    expect(waitForExit).not.toHaveBeenCalled()
  })
})
