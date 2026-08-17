$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $projectRoot 'scripts\Packager.Common.ps1')

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw "$Message Expected <$Expected>, got <$Actual>."
    }
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-packager-test-" + [guid]::NewGuid().ToString('N'))
$sourceRoot = Join-Path $testRoot 'source'
$workingRoot = Join-Path $testRoot 'working'

try {
    New-Item -ItemType Directory -Force -Path $sourceRoot, $workingRoot | Out-Null
    Write-Utf8File -Path (Join-Path $sourceRoot 'package.json') -Lines @(
        '{',
        '  "name": "fixture",',
        '  "version": "9.8.7",',
        '  "packageManager": "pnpm@11.7.0"',
        '}'
    )
    Write-Utf8File -Path (Join-Path $sourceRoot 'pnpm-workspace.yaml') -Lines @(
        'packages:',
        '  - apps/*',
        '',
        'overrides:',
        "  '@deepseek-ai/cosmokit': 'link:vendor/cosmokit'",
        '',
        'allowBuilds:',
        '  esbuild: true'
    )
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json'), (Join-Path $sourceRoot 'pnpm-workspace.yaml') -Destination $workingRoot -Force
    $sourcePackageHash = Get-Sha256Hex -Path (Join-Path $sourceRoot 'package.json')
    $sourceWorkspaceHash = Get-Sha256Hex -Path (Join-Path $sourceRoot 'pnpm-workspace.yaml')

    $version = Prepare-UpstreamSource -OverlayRoot (Join-Path $projectRoot 'overlay') -WorkingRoot $workingRoot
    Assert-Equal '9.8.7' $version 'The upstream version was not returned.'
    $desktopManifest = Get-Content -LiteralPath (Join-Path $workingRoot 'apps\desktop\package.json') -Raw | ConvertFrom-Json
    Assert-Equal '9.8.7' $desktopManifest.version 'The desktop version was not synchronized.'
    Assert-True (Test-Path -LiteralPath (Join-Path $workingRoot 'apps\desktop\src\main.ts')) 'The desktop overlay was not installed.'
    Assert-True (Test-Path -LiteralPath (Join-Path $workingRoot 'apps\desktop\bin\dsh.cmd')) 'The dsh command shim was not installed.'
    Assert-True (Test-Path -LiteralPath (Join-Path $workingRoot 'apps\desktop\bin\pnpm.cmd')) 'The bundled pnpm command shim was not installed.'

    $buildWorkContainer = Get-BuildWorkContainer
    Assert-True ($buildWorkContainer.StartsWith([System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()), [System.StringComparison]::OrdinalIgnoreCase)) 'The build work container is not under the system temporary directory.'
    Assert-True ($buildWorkContainer.Length -lt 100) 'The build work container is too long for deeply nested Node.js dependencies.'

    Prepare-UpstreamSource -OverlayRoot (Join-Path $projectRoot 'overlay') -WorkingRoot $workingRoot | Out-Null
    $workspace = Get-Content -LiteralPath (Join-Path $workingRoot 'pnpm-workspace.yaml') -Raw
    Assert-Equal 1 ([regex]::Matches($workspace, "(?m)^  '@electron/get':").Count) 'The Electron override is not idempotent.'
    Assert-Equal 1 ([regex]::Matches($workspace, '(?m)^  electron:').Count) 'The Electron build permission is not idempotent.'
    Assert-Equal 1 ([regex]::Matches($workspace, '(?m)^  electron-winstaller:').Count) 'The installer build permission is not idempotent.'

    Assert-Equal $sourcePackageHash (Get-Sha256Hex -Path (Join-Path $sourceRoot 'package.json')) 'The source package.json was modified.'
    Assert-Equal $sourceWorkspaceHash (Get-Sha256Hex -Path (Join-Path $sourceRoot 'pnpm-workspace.yaml')) 'The source workspace config was modified.'
    Assert-SourceInfo -SourceInfo ([ordered]@{
        cleanupMode = 'worktree'
        commit = '0123456789abcdef'
        ref = 'origin/master'
        source = 'https://example.invalid/upstream.git'
    })
    $invalidSourceInfoRejected = $false
    try { Assert-SourceInfo -SourceInfo ([ordered]@{ commit = '0123456789abcdef' }) }
    catch { $invalidSourceInfoRejected = $true }
    Assert-True $invalidSourceInfoRejected 'Incomplete source information was accepted.'
    Write-Host 'PASS: overlay injection, version synchronization, idempotency, and source isolation'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
