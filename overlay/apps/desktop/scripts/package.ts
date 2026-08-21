import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, globSync } from 'node:fs'
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'
import { findAvailablePort, waitForHttpReady } from '../src/runtime.ts'

const CANONICAL_RUNTIME_MANIFEST = 'python/sdk-runtime/package.json'
const CANONICAL_RUNTIME_PACKAGE = 'dsh-jsonrpc-agent-pkg'

/** Supported host properties required by the Windows x64 installer. */
export interface DesktopBuildHost {
  arch: string
  nodeMajor: number
  platform: string
}

/** Generated directories owned exclusively by the desktop package build. */
export interface DesktopBuildPaths {
  appRoot: string
  outputRoot: string
  stageApp: string
  stageRoot: string
  stageRuntime: string
}

/** Package fields needed to compose the desktop runtime deploy closure. */
export interface RuntimeClosureManifest {
  [key: string]: unknown
  dependencies?: Record<string, string>
  name?: string
  private?: boolean
  type?: string
  version?: string
}

/** Workspace package metadata used to close required peer dependencies. */
export interface WorkspacePackageManifest {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/** A platform-compatible child process command. */
export interface CommandInvocation {
  args: string[]
  executable: string
}

/** Resolve generated directories from the repository root. */
export function desktopBuildPaths(repositoryRoot: string): DesktopBuildPaths {
  const appRoot = resolve(repositoryRoot, 'apps', 'desktop')
  const stageRoot = join(appRoot, '.stage')
  return {
    appRoot,
    outputRoot: join(appRoot, 'dist'),
    stageApp: join(stageRoot, 'app'),
    stageRoot,
    stageRuntime: join(stageRoot, 'runtime'),
  }
}

/** Merge the canonical agent closure with the desktop CLI and Web runtime roots. */
export function createRuntimeClosureManifest(
  canonicalManifest: RuntimeClosureManifest,
  desktopManifest: RuntimeClosureManifest,
): RuntimeClosureManifest {
  const dependencies = Object.fromEntries(Object.entries({
    ...canonicalManifest.dependencies,
    ...desktopManifest.dependencies,
  }).sort(([left], [right]) => left.localeCompare(right)))
  return {
    dependencies,
    name: 'dsh-desktop-runtime-closure',
    private: true,
    type: 'module',
    version: desktopManifest.version,
  }
}

/** Add every non-optional workspace peer reachable through the production dependency graph. */
export function expandWorkspacePeerDependencies(
  runtimeClosure: RuntimeClosureManifest,
  workspace: ReadonlyMap<string, WorkspacePackageManifest>,
): RuntimeClosureManifest {
  const dependencies = { ...runtimeClosure.dependencies }
  const queue = Object.keys(dependencies).filter(name => workspace.has(name))
  const visited = new Set<string>()
  for (let index = 0; index < queue.length; index += 1) {
    const packageName = queue[index]
    if (packageName === undefined || visited.has(packageName)) continue
    visited.add(packageName)
    const manifest = workspace.get(packageName)
    if (manifest === undefined) continue
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
      if (workspace.has(dependency) && !visited.has(dependency)) queue.push(dependency)
    }
    const peerMeta = manifest.peerDependenciesMeta ?? {}
    for (const [peer, version] of Object.entries(manifest.peerDependencies ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      if (!workspace.has(peer) || peerMeta[peer]?.optional === true) continue
      if (dependencies[peer] === undefined) dependencies[peer] = version
      if (!visited.has(peer)) queue.push(peer)
    }
  }
  return {
    ...runtimeClosure,
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))),
  }
}

async function loadWorkspacePackageManifests(repositoryRoot: string): Promise<Map<string, WorkspacePackageManifest>> {
  const paths = globSync([
    'apps/*/package.json',
    'packages/*/*/package.json',
    'vendor/*/package.json',
  ], { cwd: repositoryRoot }).sort()
  const workspace = new Map<string, WorkspacePackageManifest>()
  for (const path of paths) {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, path), 'utf8')) as WorkspacePackageManifest & { name?: string }
    if (manifest.name !== undefined) workspace.set(manifest.name, manifest)
  }
  return workspace
}

/** Expose every staged runtime root so electron-builder cannot prune closure-only packages. */
export function createPackagedDesktopManifest(
  desktopManifest: RuntimeClosureManifest,
  runtimeClosure: RuntimeClosureManifest,
): RuntimeClosureManifest {
  return {
    ...desktopManifest,
    dependencies: runtimeClosure.dependencies ?? {},
  }
}

/** Reject hosts that cannot produce the shipped Windows x64 runtime. */
export function assertWindowsBuildHost(host: DesktopBuildHost): void {
  if (host.platform !== 'win32' || host.arch !== 'x64') {
    throw new Error(`Desktop packaging requires Windows x64, got ${host.platform} ${host.arch}.`)
  }
  if (host.nodeMajor < 24) {
    throw new Error(`Desktop packaging requires Node 24 or newer, got Node ${host.nodeMajor}.`)
  }
}

function command(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

/** Resolve a repository-installed executable independently of the caller's PATH. */
export function workspaceCommand(
  repositoryRoot: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(repositoryRoot, 'node_modules', '.bin', platform === 'win32' ? `${name}.cmd` : name)
}

/** Route Windows command shims through cmd.exe for Node 24 compatibility. */
export function resolveCommandInvocation(
  platform: string,
  executable: string,
  args: string[],
  comSpec = process.env.ComSpec ?? 'cmd.exe',
): CommandInvocation {
  if (platform === 'win32' && executable.toLowerCase().endsWith('.cmd')) {
    return { args: ['/d', '/s', '/c', executable, ...args], executable: comSpec }
  }
  return { args, executable }
}

/** Prepend the package-manager shim without changing the caller's environment. */
export function packagingEnvironment(
  platform: string,
  environment: NodeJS.ProcessEnv,
  shimDirectory: string,
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const separator = platform === 'win32' ? ';' : ':'
  const currentPath = environment[pathKey]
  return {
    ...environment,
    [pathKey]: currentPath ? `${shimDirectory}${separator}${currentPath}` : shimDirectory,
  }
}

async function run(
  cwd: string,
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  console.log(`desktop-package: ${executable} ${args.join(' ')}`)
  const invocation = resolveCommandInvocation(process.platform, executable, args)
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', rejectRun)
    child.once('exit', (code) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${executable} ${args.join(' ')} exited with code ${code ?? 'unknown'}.`))
    })
  })
}

async function installCorepackPnpmShim(stageRoot: string): Promise<string> {
  const shimDirectory = join(stageRoot, 'package-bin')
  await mkdir(shimDirectory, { recursive: true })
  await writeFile(join(shimDirectory, 'pnpm.cmd'), '@echo off\r\ncorepack pnpm %*\r\n', 'utf8')
  return shimDirectory
}

async function findLink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findLink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function materializeLinks(nodeModules: string): Promise<void> {
  let link = await findLink(nodeModules)
  while (link !== undefined) {
    const relativeSegments = link.slice(nodeModules.length + 1).split(sep)
    const binIndex = relativeSegments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...relativeSegments.slice(0, binIndex + 1)), { force: true, recursive: true })
      link = await findLink(nodeModules)
      continue
    }
    const source = await realpath(link)
    const sourceMetadata = await stat(source)
    await unlink(link)
    if (sourceMetadata.isDirectory()) {
      const nestedNodeModules = join(source, 'node_modules')
      await cp(source, link, {
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
        recursive: true,
      })
    } else {
      await copyFile(source, link)
    }
    link = await findLink(nodeModules)
  }
}

async function restoreLegacyHoists(staging: string, sourceNodeModules: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as RuntimeClosureManifest
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort()
  const restored: string[] = []
  for (const dependency of dependencies) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(`Desktop runtime dependency ${dependency} is absent from both ${destination} and ${source}.`)
    }
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      recursive: true,
    })
    restored.push(dependency)
  }
  const missing = dependencies.filter(dependency => !existsSync(join(staging, 'node_modules', dependency)))
  if (missing.length > 0) throw new Error(`Desktop runtime dependencies remain missing: ${missing.join(', ')}.`)
  if (restored.length > 0) console.log(`desktop-package: restored legacy deploy hoists: ${restored.join(', ')}`)
}

async function copyMissingPackage(source: string, destination: string): Promise<void> {
  if (existsSync(destination)) return
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { dereference: true, recursive: true })
}

/** Add packages supplied only by the canonical closure without recopying pnpm hard links. */
export async function mergeCanonicalRuntime(stageRuntime: string, stageApp: string): Promise<void> {
  const sourceNodeModules = join(stageRuntime, 'node_modules')
  const destinationNodeModules = join(stageApp, 'node_modules')
  for (const entry of await readdir(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const source = join(sourceNodeModules, entry.name)
    const destination = join(destinationNodeModules, entry.name)
    if (!entry.name.startsWith('@')) {
      await copyMissingPackage(source, destination)
      continue
    }
    for (const scopedEntry of await readdir(source, { withFileTypes: true })) {
      await copyMissingPackage(join(source, scopedEntry.name), join(destination, scopedEntry.name))
    }
  }
  await materializeLinks(join(stageApp, 'node_modules'))
}

async function stopPreflightProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return
  await new Promise<void>((resolveStop) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.once('error', () => {
      child.kill()
      resolveStop()
    })
    killer.once('exit', () => resolveStop())
  })
  if (child.exitCode !== null) return
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => {
      child.kill()
      resolveExit()
    }, 10_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolveExit()
    })
  })
}

async function preflightWebRuntime(paths: DesktopBuildPaths): Promise<void> {
  const port = await findAvailablePort(31_080, 100)
  const dshHome = join(paths.stageRoot, 'preflight-home')
  const workspace = join(paths.stageRoot, 'preflight-workspace')
  const logPath = join(paths.stageRoot, 'preflight-web.log')
  await Promise.all([mkdir(dshHome, { recursive: true }), mkdir(workspace, { recursive: true })])
  const nodeExecutable = join(paths.stageApp, 'node-runtime', 'node.exe')
  const cliEntry = join(paths.stageApp, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const log = createWriteStream(logPath, { flags: 'w' })
  const child = spawn(nodeExecutable, [cliEntry, 'web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      NODE_USE_ENV_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.pipe(log, { end: false })
  child.stderr?.pipe(log, { end: false })
  const earlyExit = new Promise<never>((_resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      const detail = signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`
      reject(new Error(`Deployed DeepSeek Harness Web runtime stopped during preflight (${detail}); see ${logPath}.`))
    })
  })
  try {
    await Promise.race([
      waitForHttpReady(`http://127.0.0.1:${port}/`, { timeoutMs: 45_000 }),
      earlyExit,
    ])
    console.log(`desktop-package: deployed Web runtime passed HTTP preflight on port ${port}`)
  } finally {
    await stopPreflightProcess(child)
    log.end()
  }
}

async function installNodeRuntime(stageApp: string): Promise<void> {
  const runtimeDirectory = join(stageApp, 'node-runtime')
  await mkdir(runtimeDirectory, { recursive: true })
  await copyFile(process.execPath, join(runtimeDirectory, 'node.exe'))
  const licenseRef = process.version
  const licenseSources = [
    `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
    `https://api.github.com/repos/nodejs/node/contents/LICENSE?ref=${licenseRef}`,
  ]
  const failures: string[] = []
  let licenseText: string | undefined
  for (const licenseUrl of licenseSources) {
    try {
      const response = await fetch(licenseUrl, { headers: { 'user-agent': 'deepseek-harness-packager' } })
      if (!response.ok) {
        failures.push(`${licenseUrl}: HTTP ${response.status}`)
        continue
      }
      if (licenseUrl.includes('api.github.com')) {
        const payload = await response.json() as { content?: string; encoding?: string }
        if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
          failures.push(`${licenseUrl}: unexpected GitHub API response`)
          continue
        }
        licenseText = Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8')
      } else {
        licenseText = await response.text()
      }
      break
    } catch (error) {
      failures.push(`${licenseUrl}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (licenseText === undefined) {
    throw new Error(`Unable to download the Node.js license for ${process.version}. ${failures.join('; ')}`)
  }
  await writeFile(join(runtimeDirectory, 'LICENSE'), licenseText, 'utf8')
  await writeFile(join(runtimeDirectory, 'VERSION'), `${process.version}\n`, 'utf8')
}

async function generateIcons(repositoryRoot: string, stageApp: string): Promise<void> {
  const source = join(repositoryRoot, 'apps', 'web', 'public', 'favicon.svg')
  const sourceSvg = await readFile(source)
  const iconDirectory = join(stageApp, 'assets')
  await mkdir(iconDirectory, { recursive: true })
  const mark = await sharp(sourceSvg, { density: 384 })
    .resize(184, 184, { fit: 'contain' })
    .negate({ alpha: false })
    .png()
    .toBuffer()
  const base = sharp({
    create: {
      background: '#4d6bfe',
      channels: 4,
      height: 256,
      width: 256,
    },
  }).composite([{ gravity: 'centre', input: mark }])
  const png = await base.clone().png().toBuffer()
  await writeFile(join(iconDirectory, 'icon.png'), png)
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const icoImages = await Promise.all(sizes.map(async size => await sharp(png).resize(size, size).png().toBuffer()))
  await writeFile(join(iconDirectory, 'icon.ico'), await pngToIco(icoImages))
}

/** Stage the PATH shim and the NSIS include that electron-builder reads beside the app. */
export async function stageInstallerResources(appRoot: string, stageApp: string): Promise<void> {
  await mkdir(join(stageApp, 'bin'), { recursive: true })
  await mkdir(join(stageApp, 'build'), { recursive: true })
  await copyFile(join(appRoot, 'bin', 'dsh.cmd'), join(stageApp, 'bin', 'dsh.cmd'))
  await copyFile(join(appRoot, 'bin', 'pnpm.cmd'), join(stageApp, 'bin', 'pnpm.cmd'))
  await copyFile(join(appRoot, 'build', 'installer.nsh'), join(stageApp, 'build', 'installer.nsh'))
}

async function copyProducts(stageApp: string, outputRoot: string): Promise<string[]> {
  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(outputRoot, { recursive: true })
  const stageOutput = join(stageApp, 'dist')
  const products: string[] = []
  for (const entry of await readdir(stageOutput, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.exe')) continue
    const destination = join(outputRoot, entry.name)
    await copyFile(join(stageOutput, entry.name), destination)
    products.push(destination)
  }
  if (products.length === 0) throw new Error(`electron-builder produced no installer in ${stageOutput}.`)
  return products
}

/** Build the production runtime closure and Windows NSIS installer. */
export async function packageWindowsDesktop(repositoryRoot: string): Promise<string[]> {
  assertWindowsBuildHost({
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    platform: process.platform,
  })
  const paths = desktopBuildPaths(repositoryRoot)
  if (!paths.stageRoot.startsWith(paths.appRoot + sep)) {
    throw new Error(`Refusing to clear desktop staging outside ${paths.appRoot}: ${paths.stageRoot}.`)
  }

  await run(repositoryRoot, command('npm'), ['run', 'build:lib'])
  await run(repositoryRoot, command('corepack'), ['pnpm', '--filter', '@deepseek-ai/dsh-web-frontend', 'run', 'build'])
  await run(repositoryRoot, command('corepack'), ['pnpm', '--filter', '@deepseek-ai/dsh-desktop', 'run', 'build'])
  await rm(paths.stageRoot, { force: true, recursive: true })
  await mkdir(paths.stageRoot, { recursive: true })
  const canonicalManifestPath = join(repositoryRoot, CANONICAL_RUNTIME_MANIFEST)
  const canonicalManifestContent = await readFile(canonicalManifestPath, 'utf8')
  const canonicalManifest = JSON.parse(canonicalManifestContent) as RuntimeClosureManifest
  const desktopManifest = JSON.parse(await readFile(join(paths.appRoot, 'package.json'), 'utf8')) as RuntimeClosureManifest
  const runtimeClosure = expandWorkspacePeerDependencies(
    createRuntimeClosureManifest(canonicalManifest, desktopManifest),
    await loadWorkspacePackageManifests(repositoryRoot),
  )
  const closureManifestPath = join(paths.stageRoot, 'runtime-closure.package.json')
  await writeFile(closureManifestPath, `${JSON.stringify(runtimeClosure, null, 2)}\n`)
  await run(repositoryRoot, workspaceCommand(repositoryRoot, 'tsx'), [
    'scripts/verify-runtime-closure.ts',
    '--manifest',
    closureManifestPath,
  ])
  await writeFile(canonicalManifestPath, `${JSON.stringify({ ...canonicalManifest, dependencies: runtimeClosure.dependencies }, null, 2)}\n`)
  try {
    await run(repositoryRoot, command('corepack'), [
      'pnpm',
      '--filter',
      CANONICAL_RUNTIME_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      paths.stageRuntime,
    ])
  } finally {
    await writeFile(canonicalManifestPath, canonicalManifestContent)
  }
  await restoreLegacyHoists(paths.stageRuntime, join(repositoryRoot, 'python', 'sdk-runtime', 'node_modules'))
  await materializeLinks(join(paths.stageRuntime, 'node_modules'))
  await run(repositoryRoot, command('corepack'), [
    'pnpm',
    '--filter',
    '@deepseek-ai/dsh-desktop',
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    paths.stageApp,
  ])
  await restoreLegacyHoists(paths.stageApp, join(paths.appRoot, 'node_modules'))
  await mergeCanonicalRuntime(paths.stageRuntime, paths.stageApp)
  const deployedDesktopManifest = JSON.parse(await readFile(join(paths.stageApp, 'package.json'), 'utf8')) as RuntimeClosureManifest
  await writeFile(
    join(paths.stageApp, 'package.json'),
    `${JSON.stringify(createPackagedDesktopManifest(deployedDesktopManifest, runtimeClosure), null, 2)}\n`,
  )
  await installNodeRuntime(paths.stageApp)
  await preflightWebRuntime(paths)
  await generateIcons(repositoryRoot, paths.stageApp)
  await stageInstallerResources(paths.appRoot, paths.stageApp)
  const packageManagerBin = await installCorepackPnpmShim(paths.stageRoot)
  await run(repositoryRoot, workspaceCommand(paths.appRoot, 'electron-builder'), [
    '--projectDir',
    paths.stageApp,
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
  ], packagingEnvironment(process.platform, process.env, packageManagerBin))
  return await copyProducts(paths.stageApp, paths.outputRoot)
}

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  packageWindowsDesktop(repositoryRoot).then(
    (products) => {
      for (const product of products) console.log(`desktop-package: wrote ${product}`)
    },
    (error) => {
      console.error(`desktop-package: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      process.exitCode = 1
    },
  )
}
