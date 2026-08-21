import { readFileSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertWindowsBuildHost,
  createPackagedDesktopManifest,
  createRuntimeClosureManifest,
  desktopBuildPaths,
  expandWorkspacePeerDependencies,
  mergeCanonicalRuntime,
  packagingEnvironment,
  resolveCommandInvocation,
  stageInstallerResources,
  workspaceCommand,
} from '../scripts/package.ts'

describe('desktop package build', () => {
  it('ships runtime peers and overridden vendor dependencies', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/cordis-plugin-group': 'workspace:^',
      '@deepseek-ai/cosmokit': 'workspace:^',
      '@deepseek-ai/schemastery': 'workspace:^',
      pnpm: '11.7.0',
    })
  })

  it('copies the materialized runtime without electron-builder dependency pruning', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.build.extraResources).toContainEqual({
      filter: ['**/*', '!.bin{,/**/*}', '!.pnpm{,/**/*}'],
      from: 'node_modules',
      to: 'app/node_modules',
    })
  })

  it('ships the dsh and pnpm command shims beside the bundled runtime', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.build.extraResources).toContainEqual({
      from: 'bin',
      to: 'bin',
    })
    expect(manifest.build.nsis.warningsAsErrors).toBe(false)
  })

  it('keeps staging and generated products below the desktop application', () => {
    expect(desktopBuildPaths('D:\\repo')).toEqual({
      appRoot: 'D:\\repo\\apps\\desktop',
      outputRoot: 'D:\\repo\\apps\\desktop\\dist',
      stageApp: 'D:\\repo\\apps\\desktop\\.stage\\app',
      stageRuntime: 'D:\\repo\\apps\\desktop\\.stage\\runtime',
      stageRoot: 'D:\\repo\\apps\\desktop\\.stage',
    })
  })

  it('combines the canonical SDK closure with desktop Web runtime dependencies', () => {
    expect(createRuntimeClosureManifest(
      {
        dependencies: {
          '@deepseek-ai/dsh-timeout': 'workspace:^',
          '@deepseek-ai/schemastery': 'workspace:^',
        },
      },
      {
        dependencies: {
          '@deepseek-ai/dsh': 'workspace:^',
          '@deepseek-ai/dsh-session-title-llm': 'workspace:^',
        },
        version: '0.1.0-rc.5',
      },
    )).toEqual({
      dependencies: {
        '@deepseek-ai/dsh': 'workspace:^',
        '@deepseek-ai/dsh-session-title-llm': 'workspace:^',
        '@deepseek-ai/dsh-timeout': 'workspace:^',
        '@deepseek-ai/schemastery': 'workspace:^',
      },
      name: 'dsh-desktop-runtime-closure',
      private: true,
      type: 'module',
      version: '0.1.0-rc.5',
    })
  })

  it('publishes the complete runtime closure to electron-builder dependency discovery', () => {
    expect(createPackagedDesktopManifest(
      {
        build: { productName: 'DeepSeek Harness' },
        dependencies: { '@deepseek-ai/dsh': 'workspace:^' },
        name: '@deepseek-ai/dsh-desktop',
      },
      {
        dependencies: {
          '@deepseek-ai/dsh': 'workspace:^',
          '@deepseek-ai/dsh-timeout': 'workspace:^',
        },
      },
    )).toMatchObject({
      build: { productName: 'DeepSeek Harness' },
      dependencies: {
        '@deepseek-ai/dsh': 'workspace:^',
        '@deepseek-ai/dsh-timeout': 'workspace:^',
      },
      name: '@deepseek-ai/dsh-desktop',
    })
  })

  it('adds required workspace peers to the deploy root', () => {
    const closure = createRuntimeClosureManifest(
      { dependencies: { '@deepseek-ai/dsh-settings': 'workspace:^' } },
      { dependencies: {} },
    )
    const workspace = new Map([
      ['@deepseek-ai/dsh-settings', {
        dependencies: { '@deepseek-ai/dsh-settings-file': 'workspace:^' },
      }],
      ['@deepseek-ai/dsh-settings-file', {
        peerDependencies: { '@deepseek-ai/dsh-atomic-write': 'workspace:^' },
      }],
      ['@deepseek-ai/dsh-atomic-write', {}],
    ])

    expect(expandWorkspacePeerDependencies(closure, workspace).dependencies).toMatchObject({
      '@deepseek-ai/dsh-atomic-write': 'workspace:^',
      '@deepseek-ai/dsh-settings': 'workspace:^',
    })
  })

  it('adds missing canonical packages without recopying pnpm hard-linked packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-runtime-'))
    const stageRuntime = join(root, 'runtime')
    const stageApp = join(root, 'app')
    const canonicalShared = join(stageRuntime, 'node_modules', 'shared', 'package.json')
    const desktopShared = join(stageApp, 'node_modules', 'shared', 'package.json')
    const canonicalOnly = join(stageRuntime, 'node_modules', 'canonical-only', 'package.json')
    try {
      await Promise.all([
        mkdir(join(stageRuntime, 'node_modules', 'shared'), { recursive: true }),
        mkdir(join(stageRuntime, 'node_modules', 'canonical-only'), { recursive: true }),
        mkdir(join(stageApp, 'node_modules', 'shared'), { recursive: true }),
      ])
      await writeFile(canonicalShared, '{"name":"shared"}\n')
      await link(canonicalShared, desktopShared)
      await writeFile(canonicalOnly, '{"name":"canonical-only"}\n')

      await expect(mergeCanonicalRuntime(stageRuntime, stageApp)).resolves.toBeUndefined()
      await expect(readFile(join(stageApp, 'node_modules', 'canonical-only', 'package.json'), 'utf8'))
        .resolves.toContain('canonical-only')
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('stages the CLI shim and the NSIS include beside the app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-stage-'))
    const appRoot = join(root, 'src')
    const stageApp = join(root, 'stage')
    try {
      await Promise.all([
        mkdir(join(appRoot, 'bin'), { recursive: true }),
        mkdir(join(appRoot, 'build'), { recursive: true }),
        mkdir(stageApp, { recursive: true }),
      ])
      await writeFile(join(appRoot, 'bin', 'dsh.cmd'), '@echo off\r\n')
      await writeFile(join(appRoot, 'bin', 'pnpm.cmd'), '@echo off\r\n')
      await writeFile(join(appRoot, 'build', 'installer.nsh'), '!macro customInstall\n!macroend\n')

      await expect(stageInstallerResources(appRoot, stageApp)).resolves.toBeUndefined()
      await expect(readFile(join(stageApp, 'bin', 'dsh.cmd'), 'utf8')).resolves.toContain('echo off')
      await expect(readFile(join(stageApp, 'bin', 'pnpm.cmd'), 'utf8')).resolves.toContain('echo off')
      await expect(readFile(join(stageApp, 'build', 'installer.nsh'), 'utf8')).resolves.toContain('customInstall')
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('accepts the supported Windows x64 Node runtime', () => {
    expect(() => assertWindowsBuildHost({ arch: 'x64', nodeMajor: 24, platform: 'win32' })).not.toThrow()
  })

  it('runs Windows command shims through ComSpec', () => {
    expect(resolveCommandInvocation('win32', 'npm.cmd', ['run', 'build:lib'], 'C:\\Windows\\System32\\cmd.exe')).toEqual({
      args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'build:lib'],
      executable: 'C:\\Windows\\System32\\cmd.exe',
    })
  })

  it('starts native executables directly', () => {
    expect(resolveCommandInvocation('win32', 'node.exe', ['--version'], 'cmd.exe')).toEqual({
      args: ['--version'],
      executable: 'node.exe',
    })
  })

  it('resolves workspace tools without relying on the inherited PATH', () => {
    expect(workspaceCommand('D:\\repo', 'tsx', 'win32')).toBe('D:\\repo\\node_modules\\.bin\\tsx.cmd')
  })

  it('prepends the Corepack shim directory for packaging subprocesses', () => {
    expect(packagingEnvironment('win32', { PATH: 'C:\\Windows\\System32', TEST_VALUE: 'kept' }, 'D:\\stage\\bin')).toEqual({
      PATH: 'D:\\stage\\bin;C:\\Windows\\System32',
      TEST_VALUE: 'kept',
    })
  })

  it.each([
    [{ arch: 'arm64', nodeMajor: 24, platform: 'win32' }, 'Windows x64'],
    [{ arch: 'x64', nodeMajor: 24, platform: 'linux' }, 'Windows x64'],
    [{ arch: 'x64', nodeMajor: 22, platform: 'win32' }, 'Node 24 or newer'],
  ] as const)('rejects unsupported build host %j', (host, expected) => {
    expect(() => assertWindowsBuildHost(host)).toThrow(expected)
  })
})
