import { createWriteStream } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import {
  createBackendSpawnSpec,
  findAvailablePort,
  resolveDesktopPaths,
  stopProcessTree,
  waitForHttpReady,
} from './runtime.ts'
import type { BackendProcessHandle } from './runtime.ts'
import { installDesktopUiCompatibility } from './ui-compatibility.ts'

const DEFAULT_PORT = 3080
const PORT_ATTEMPTS = 100
const STARTUP_TIMEOUT_MS = 45_000

let backend: BackendProcessHandle | undefined
let backendReady = false
let mainWindow: BrowserWindow | undefined
let shutdownStarted = false

function parseFirstPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`DSH_DESKTOP_PORT must be an integer from 1 through 65535, got ${JSON.stringify(raw)}.`)
  }
  return port
}

function startupPage(): string {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeepSeek Harness</title>
  <style>
    :root { color-scheme: light dark; font-family: "Segoe UI", system-ui, sans-serif; }
    body { align-items: center; background: #f7f8fa; color: #202124; display: flex; height: 100vh; justify-content: center; margin: 0; }
    main { align-items: center; display: flex; flex-direction: column; gap: 18px; }
    h1 { font-size: 24px; font-weight: 600; letter-spacing: 0; margin: 0; }
    .spinner { animation: spin 0.9s linear infinite; border: 3px solid #d9dde5; border-radius: 50%; border-top-color: #3b6eea; height: 28px; width: 28px; }
    p { color: #687080; font-size: 14px; margin: 0; }
    @media (prefers-color-scheme: dark) {
      body { background: #17181b; color: #f4f5f7; }
      p { color: #a9afba; }
      .spinner { border-color: #3b3e45; border-top-color: #7ea2ff; }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body><main><h1>DeepSeek Harness</h1><div class="spinner" aria-label="正在启动"></div><p>正在启动本地服务...</p></main></body>
</html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ]))
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    backgroundColor: '#f7f8fa',
    height: 900,
    minHeight: 640,
    minWidth: 900,
    show: false,
    title: 'DeepSeek Harness',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    width: 1440,
  })
  installDesktopUiCompatibility(window.webContents)
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow = window
  return window
}

function focusWindow(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function backendExitHandle(child: ChildProcess): { handle: BackendProcessHandle; startupFailure: Promise<never> } {
  if (child.pid === undefined) throw new Error('DeepSeek Harness backend started without a process id.')
  const pid = child.pid
  let exited = false
  let resolveExit: (() => void) | undefined
  const exit = new Promise<void>((resolvePromise) => {
    resolveExit = resolvePromise
  })
  const startupFailure = new Promise<never>((_resolve, reject) => {
    child.once('error', (error) => {
      exited = true
      resolveExit?.()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      exited = true
      resolveExit?.()
      const detail = signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`
      if (!backendReady && !shutdownStarted) reject(new Error(`DeepSeek Harness backend stopped during startup (${detail}).`))
      if (backendReady && !shutdownStarted) {
        dialog.showErrorBox('DeepSeek Harness 已停止', `本地服务意外退出（${detail}）。应用将关闭。`)
        app.quit()
      }
    })
  })
  return {
    handle: {
      get exited() {
        return exited
      },
      pid,
      terminate: () => child.kill('SIGTERM'),
      waitForExit: async () => await exit,
    },
    startupFailure,
  }
}

async function startBackend(): Promise<string> {
  const dshHome = process.env.DSH_DESKTOP_HOME ?? join(app.getPath('userData'), 'dsh-home')
  const workspaceRoot = process.env.DSH_DESKTOP_WORKSPACE
    ?? join(app.getPath('documents'), 'DeepSeek Harness Workspace')
  await Promise.all([mkdir(dshHome, { recursive: true }), mkdir(workspaceRoot, { recursive: true })])

  const firstPort = parseFirstPort(process.env.DSH_DESKTOP_PORT)
  const attempts = Math.min(PORT_ATTEMPTS, 65_536 - firstPort)
  const port = await findAvailablePort(firstPort, attempts)
  const paths = resolveDesktopPaths({
    appPath: app.getAppPath(),
    developmentNodePath: process.env.DSH_DESKTOP_NODE ?? process.env.npm_node_execpath ?? 'node',
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  await access(paths.cliEntry)
  if (paths.nodeExecutable.includes('\\') || paths.nodeExecutable.includes('/')) await access(paths.nodeExecutable)

  const spec = createBackendSpawnSpec({
    baseEnv: process.env,
    cliEntry: paths.cliEntry,
    dshHome,
    nodeExecutable: paths.nodeExecutable,
    port,
    workspaceRoot,
  })
  const logsDirectory = join(app.getPath('userData'), 'logs')
  await mkdir(logsDirectory, { recursive: true })
  const log = createWriteStream(join(logsDirectory, 'desktop-backend.log'), { flags: 'a' })
  log.write(`\n[${new Date().toISOString()}] starting ${spec.command} ${spec.args.join(' ')}\n`)
  const child = spawn(spec.command, spec.args, spec.options)
  child.stdout?.pipe(log, { end: false })
  child.stderr?.pipe(log, { end: false })
  child.once('exit', () => log.end())
  const lifecycle = backendExitHandle(child)
  backend = lifecycle.handle
  const url = `http://127.0.0.1:${port}/`
  await Promise.race([
    waitForHttpReady(url, { timeoutMs: STARTUP_TIMEOUT_MS }),
    lifecycle.startupFailure,
  ])
  backendReady = true
  return url
}

async function startApplication(): Promise<void> {
  installApplicationMenu()
  const window = createWindow()
  await window.loadURL(startupPage())
  try {
    const url = await startBackend()
    window.webContents.on('will-navigate', (event, target) => {
      if (target.startsWith(url)) return
      event.preventDefault()
      if (target.startsWith('https://') || target.startsWith('http://')) void shell.openExternal(target)
    })
    await window.loadURL(url)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('DeepSeek Harness 启动失败', `${message}\n\n日志：${join(app.getPath('userData'), 'logs', 'desktop-backend.log')}`)
    app.quit()
  }
}

async function stopBackend(): Promise<void> {
  if (backend !== undefined) await stopProcessTree(backend)
  backend = undefined
}

app.setName('DeepSeek Harness')
const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) {
  app.quit()
} else {
  app.on('second-instance', focusWindow)
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (shutdownStarted || backend === undefined || backend.exited) return
    event.preventDefault()
    shutdownStarted = true
    void stopBackend().finally(() => app.exit(0))
  })
  void app.whenReady().then(startApplication)
}
