param(
    [string]$SourceRoot,
    [string]$UpstreamUrl = 'https://github.com/deepseek-ai/deepseek-harness.git',
    [string]$UpstreamRef,
    [switch]$Offline,
    [switch]$KeepWorkDirectory,
    [switch]$SkipTests,
    [switch]$AutoInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot

# 可选配置文件：可覆盖默认的上游仓库地址等设置。
# 优先级：命令行参数 > build.config.ps1 > 脚本内默认值。
$configPath = Join-Path $projectRoot 'build.config.ps1'
if (Test-Path -LiteralPath $configPath) {
    . $configPath
}

# 命令行显式传入的参数始终优先于配置文件。
if ($PSBoundParameters.ContainsKey('SourceRoot')) { $SourceRoot = $PSBoundParameters['SourceRoot'] }
if ($PSBoundParameters.ContainsKey('UpstreamUrl')) { $UpstreamUrl = $PSBoundParameters['UpstreamUrl'] }
if ($PSBoundParameters.ContainsKey('UpstreamRef')) { $UpstreamRef = $PSBoundParameters['UpstreamRef'] }
if ($PSBoundParameters.ContainsKey('Offline')) { $Offline = $PSBoundParameters['Offline'] }
if ($PSBoundParameters.ContainsKey('KeepWorkDirectory')) { $KeepWorkDirectory = $PSBoundParameters['KeepWorkDirectory'] }
if ($PSBoundParameters.ContainsKey('SkipTests')) { $SkipTests = $PSBoundParameters['SkipTests'] }
if ($PSBoundParameters.ContainsKey('AutoInstall')) { $AutoInstall = $PSBoundParameters['AutoInstall'] }
$overlayRoot = Join-Path $projectRoot 'overlay'
$cacheRoot = Join-Path $projectRoot '.cache'
$cacheRepository = Join-Path $cacheRoot 'upstream'
$distRoot = Join-Path $projectRoot 'dist'
$logsRoot = Join-Path $projectRoot 'logs'

. (Join-Path $PSScriptRoot 'Packager.Common.ps1')

$workContainer = Get-BuildWorkContainer
$buildId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$workingRoot = Join-Path $workContainer ([guid]::NewGuid().ToString('N').Substring(0, 8))
$logPath = Join-Path $logsRoot ("build-$buildId.log")

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory
    )

    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { Push-Location $WorkingDirectory }
    try {
        & $FilePath @ArgumentList | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { Pop-Location }
    }
}

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory
    )

    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { Push-Location $WorkingDirectory }
    try {
        $output = & $FilePath @ArgumentList 2>&1
        if ($LASTEXITCODE -ne 0) {
            $output | ForEach-Object { Write-Host $_ }
            throw "$FilePath failed with exit code $LASTEXITCODE."
        }
        return ($output | Out-String).Trim()
    }
    finally {
        if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { Pop-Location }
    }
}

function Assert-Prerequisites {
    param([bool]$AutoInstall)

    $missing = @()
    foreach ($name in @('git', 'node', 'corepack')) {
        if ($null -eq (Get-Command $name -ErrorAction SilentlyContinue)) {
            $missing += $name
        }
    }

    if ($missing.Count -gt 0) {
        if ($AutoInstall) {
            Write-Host '检测到缺少依赖，尝试通过 winget 自动安装...' -ForegroundColor Yellow
            $winget = Get-Command winget -ErrorAction SilentlyContinue
            if ($null -eq $winget) {
                throw '未找到 winget，无法自动安装。请手动安装缺失的工具后重试。'
            }
            if ($missing -contains 'git') {
                Invoke-Native -FilePath 'winget' -ArgumentList @('install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
            }
            if ($missing -contains 'node' -or $missing -contains 'corepack') {
                Invoke-Native -FilePath 'winget' -ArgumentList @('install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
            }
            throw '依赖已尝试安装。新安装的程序不会加入当前命令行窗口的 PATH，请关闭并重新打开命令窗口（必要时重启电脑）后再次双击 build.cmd。'
        }

        Write-Host ''
        Write-Host '打包环境不满足，缺少以下工具：' -ForegroundColor Yellow
        if ($missing -contains 'git') {
            Write-Host '  - Git         下载：https://git-scm.com/download/win'
        }
        if ($missing -contains 'node' -or $missing -contains 'corepack') {
            Write-Host '  - Node.js 24+ 下载：https://nodejs.org/  （corepack 随 Node.js 一起安装）'
        }
        Write-Host ''
        Write-Host '安装完成后，重新打开命令窗口，再双击 build.cmd。'
        Write-Host '若系统已安装 winget，也可运行：.\build.cmd -AutoInstall'
        Write-Host ''
        throw 'Prerequisite check failed.'
    }

    $platform = Invoke-NativeCapture -FilePath 'node' -ArgumentList @('-p', 'process.platform')
    $architecture = Invoke-NativeCapture -FilePath 'node' -ArgumentList @('-p', 'process.arch')
    $nodeMajor = [int](Invoke-NativeCapture -FilePath 'node' -ArgumentList @('-p', "process.versions.node.split('.')[0]"))
    if ($platform -ne 'win32' -or $architecture -ne 'x64') {
        throw "本打包器只支持 Windows x64，当前环境为 $platform/$architecture。"
    }
    if ($nodeMajor -lt 24) {
        throw "当前 Node.js 主版本为 $nodeMajor，本打包器需要 Node.js 24 或更高版本。请升级：https://nodejs.org/ （或运行 .\build.cmd -AutoInstall 尝试自动升级）。"
    }
}

function Resolve-RemoteRef {
    param([string]$Repository, [string]$RequestedRef)

    if (-not [string]::IsNullOrWhiteSpace($RequestedRef)) {
        Invoke-NativeCapture -FilePath 'git' -ArgumentList @('-C', $Repository, 'rev-parse', '--verify', "${RequestedRef}^{commit}") | Out-Null
        return $RequestedRef
    }
    foreach ($candidate in @('origin/HEAD', 'origin/master', 'origin/main')) {
        try {
            Invoke-NativeCapture -FilePath 'git' -ArgumentList @('-C', $Repository, 'rev-parse', '--verify', "${candidate}^{commit}") | Out-Null
            return $candidate
        }
        catch {
            continue
        }
    }
    throw 'Could not determine the upstream default branch.'
}

function New-RemoteWorkingCopy {
    if (-not (Test-Path -LiteralPath (Join-Path $cacheRepository '.git'))) {
        if ($Offline) { throw 'The upstream cache is empty, so offline mode cannot continue.' }
        New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
        Invoke-Native -FilePath 'git' -ArgumentList @('clone', '--filter=blob:none', '--no-checkout', $UpstreamUrl, $cacheRepository)
    }
    else {
        $configuredUrl = Invoke-NativeCapture -FilePath 'git' -ArgumentList @('-C', $cacheRepository, 'remote', 'get-url', 'origin')
        if ($configuredUrl -ne $UpstreamUrl) {
            throw "Cached upstream URL is $configuredUrl, expected $UpstreamUrl. Remove .cache to switch repositories."
        }
    }
    if (-not $Offline) {
        Invoke-Native -FilePath 'git' -ArgumentList @('-C', $cacheRepository, 'fetch', '--prune', '--tags', 'origin')
    }
    $ref = Resolve-RemoteRef -Repository $cacheRepository -RequestedRef $UpstreamRef
    Invoke-Native -FilePath 'git' -ArgumentList @('-C', $cacheRepository, 'worktree', 'add', '--detach', $workingRoot, $ref)
    return [ordered]@{
        cleanupMode = 'worktree'
        commit = Invoke-NativeCapture -FilePath 'git' -ArgumentList @('-C', $workingRoot, 'rev-parse', 'HEAD')
        ref = $ref
        source = $UpstreamUrl
    }
}

function New-LocalWorkingCopy {
    $resolvedSource = [System.IO.Path]::GetFullPath($SourceRoot)
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedSource '.git'))) {
        throw "Local source is not a Git checkout: $resolvedSource"
    }
    $requestedRef = 'HEAD'
    if (-not [string]::IsNullOrWhiteSpace($UpstreamRef)) { $requestedRef = $UpstreamRef }
    $commit = Invoke-NativeCapture -FilePath 'git' -ArgumentList @('-C', $resolvedSource, 'rev-parse', '--verify', "${requestedRef}^{commit}")
    Invoke-Native -FilePath 'git' -ArgumentList @('clone', '--local', '--no-hardlinks', '--no-checkout', $resolvedSource, $workingRoot)
    Invoke-Native -FilePath 'git' -ArgumentList @('-C', $workingRoot, 'checkout', '--detach', $commit)
    return [ordered]@{
        cleanupMode = 'directory'
        commit = $commit
        ref = $requestedRef
        source = $resolvedSource
    }
}

function Remove-WorkingCopy {
    param([string]$Mode)

    if (-not (Test-Path -LiteralPath $workingRoot)) { return }
    Assert-ChildPath -Parent $workContainer -Child $workingRoot
    if ($Mode -eq 'worktree') {
        try {
            Invoke-Native -FilePath 'git' -ArgumentList @('-C', $cacheRepository, 'worktree', 'remove', '--force', $workingRoot)
        }
        catch {
            if (Test-Path -LiteralPath $workingRoot) {
                Remove-Item -LiteralPath ("\\?\" + $workingRoot) -Recurse -Force
            }
        }
        Invoke-Native -FilePath 'git' -ArgumentList @('-C', $cacheRepository, 'worktree', 'prune')
        return
    }
    Remove-Item -LiteralPath ("\\?\" + $workingRoot) -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $workContainer, $distRoot, $logsRoot | Out-Null
Start-Transcript -LiteralPath $logPath -Force | Out-Null
$sourceInfo = $null

try {
    Write-Host "Build log: $logPath"
    Assert-Prerequisites -AutoInstall:$AutoInstall
    if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
        Write-Host 'Preparing the latest official upstream revision...'
        $sourceInfo = New-RemoteWorkingCopy
    }
    else {
        Write-Host "Preparing local committed source from $SourceRoot..."
        $sourceInfo = New-LocalWorkingCopy
    }
    Assert-SourceInfo -SourceInfo $sourceInfo

    Write-Host "Injecting the desktop overlay into temporary source $workingRoot..."
    $version = Prepare-UpstreamSource -OverlayRoot $overlayRoot -WorkingRoot $workingRoot
    $packageManager = (Get-Content -LiteralPath (Join-Path $workingRoot 'package.json') -Raw | ConvertFrom-Json).packageManager
    if ([string]::IsNullOrWhiteSpace([string]$packageManager) -or -not ([string]$packageManager).StartsWith('pnpm@')) {
        throw "The upstream project does not pin pnpm through packageManager: $packageManager"
    }

    Write-Host "Installing dependencies with upstream $packageManager..."
    Invoke-Native -FilePath 'corepack' -ArgumentList @(
        'pnpm', 'install',
        '--filter', '.',
        '--filter', './**',
        '--filter', '!@deepseek-ai/dsh-subagent-codex',
        '--no-frozen-lockfile'
    ) -WorkingDirectory $workingRoot

    if (-not $SkipTests) {
        Write-Host 'Running focused desktop tests...'
        Invoke-Native -FilePath 'corepack' -ArgumentList @(
            'pnpm', 'exec', 'vitest', 'run',
            'apps/desktop/tests/runtime.spec.ts',
            'apps/desktop/tests/ui-compatibility.spec.ts',
            'apps/desktop/tests/package.spec.ts'
        ) -WorkingDirectory $workingRoot
    }

    Write-Host 'Building the Windows x64 NSIS installer...'
    Invoke-Native -FilePath 'corepack' -ArgumentList @(
        'pnpm', '--filter', '@deepseek-ai/dsh-desktop', 'run', 'package:win'
    ) -WorkingDirectory $workingRoot

    $installerName = "DeepSeek-Harness-Setup-$version-x64.exe"
    $sourceInstaller = Join-Path $workingRoot ("apps\desktop\dist\$installerName")
    if (-not (Test-Path -LiteralPath $sourceInstaller)) {
        throw "Expected installer was not produced: $sourceInstaller"
    }
    $destinationInstaller = Join-Path $distRoot $installerName
    Copy-Item -LiteralPath $sourceInstaller -Destination $destinationInstaller -Force
    $hash = Get-Sha256Hex -Path $destinationInstaller
    $metadata = [ordered]@{
        artifact = $installerName
        builtAt = (Get-Date).ToUniversalTime().ToString('o')
        desktopVersion = $version
        sha256 = $hash
        upstreamCommit = $sourceInfo.commit
        upstreamRef = $sourceInfo.ref
        upstreamSource = $sourceInfo.source
    }
    $metadataPath = Join-Path $distRoot ("DeepSeek-Harness-Setup-$version-x64.json")
    Write-Utf8File -Path $metadataPath -Lines @(($metadata | ConvertTo-Json -Depth 10))

    Write-Host ''
    Write-Host "Installer: $destinationInstaller"
    Write-Host "SHA-256:  $hash"
}
catch {
    Write-Error $_
    exit 1
}
finally {
    if ($null -ne $sourceInfo -and -not $KeepWorkDirectory) {
        try { Remove-WorkingCopy -Mode $sourceInfo.cleanupMode }
        catch { Write-Warning "Could not remove temporary build source: $_" }
    }
    elseif ($KeepWorkDirectory -and (Test-Path -LiteralPath $workingRoot)) {
        Write-Host "Temporary build source retained at $workingRoot"
    }
    Stop-Transcript | Out-Null
}
