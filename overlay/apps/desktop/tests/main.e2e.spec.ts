import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { _electron as electron } from 'playwright'
import type { ElectronApplication } from 'playwright'
import { findAvailablePort } from '../src/runtime.ts'

let application: ElectronApplication | undefined
let testRoot: string | undefined

afterEach(async () => {
  if (application !== undefined) await application.close()
  if (testRoot !== undefined) await rm(testRoot, { force: true, recursive: true })
  application = undefined
  testRoot = undefined
})

describe('desktop application', () => {
  it('loads the official Web UI and releases its backend when the window closes', async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-'))
    const dshHome = join(testRoot, 'dsh-home')
    const workspaceRoot = join(testRoot, 'workspace')
    const port = await findAvailablePort(33_080, 100)
    const url = `http://127.0.0.1:${port}/`
    await expect(stat(resolve('apps/desktop/lib/main.js'))).resolves.toMatchObject({ isFile: expect.any(Function) })

    application = await electron.launch({
      args: [resolve('apps/desktop')],
      env: {
        ...process.env,
        DSH_DESKTOP_HOME: dshHome,
        DSH_DESKTOP_NODE: process.execPath,
        DSH_DESKTOP_PORT: String(port),
        DSH_DESKTOP_WORKSPACE: workspaceRoot,
      },
    })

    const window = await application.firstWindow({ timeout: 60_000 })
    await expect.poll(() => window.url(), { timeout: 60_000 }).toBe(url)
    expect(await window.title()).toContain('DeepSeek Harness')
    expect((await window.locator('body').innerText()).trim()).not.toBe('')
    await expect(stat(dshHome)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
    await expect(stat(workspaceRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) })

    await application.close()
    application = undefined
    await expect.poll(async () => {
      try {
        await fetch(url)
        return false
      } catch {
        return true
      }
    }, { timeout: 15_000 }).toBe(true)
  }, 90_000)
})
