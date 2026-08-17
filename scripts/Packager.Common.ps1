Set-StrictMode -Version Latest

function Write-Utf8File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Path, $Lines, $encoding)
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try { return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose() }
    }
    finally { $algorithm.Dispose() }
}

function Get-BuildWorkContainer {
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    return Join-Path $tempRoot 'dsh-build'
}

function Add-YamlMappingEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Section,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.AddRange([string[]][System.IO.File]::ReadAllLines($Path))
    $sectionIndex = -1
    for ($index = 0; $index -lt $lines.Count; $index += 1) {
        if ($lines[$index] -match ('^' + [regex]::Escape($Section) + ':\s*$')) {
            $sectionIndex = $index
            break
        }
    }

    if ($sectionIndex -lt 0) {
        if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -ne '') {
            $lines.Add('')
        }
        $lines.Add("${Section}:")
        $lines.Add("  ${Key}: ${Value}")
        Write-Utf8File -Path $Path -Lines $lines.ToArray()
        return
    }

    $sectionEnd = $lines.Count
    for ($index = $sectionIndex + 1; $index -lt $lines.Count; $index += 1) {
        if ($lines[$index] -match '^[^\s#][^:]*:\s*(?:#.*)?$') {
            $sectionEnd = $index
            break
        }
    }

    $entryPattern = '^\s{2}' + [regex]::Escape($Key) + ':\s*'
    for ($index = $sectionIndex + 1; $index -lt $sectionEnd; $index += 1) {
        if ($lines[$index] -match $entryPattern) {
            $lines[$index] = "  ${Key}: ${Value}"
            Write-Utf8File -Path $Path -Lines $lines.ToArray()
            return
        }
    }

    $lines.Insert($sectionEnd, "  ${Key}: ${Value}")
    Write-Utf8File -Path $Path -Lines $lines.ToArray()
}

function Set-JsonVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Version
    )

    $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $manifest.version = $Version
    $json = $manifest | ConvertTo-Json -Depth 100
    Write-Utf8File -Path $Path -Lines @($json)
}

function Install-DesktopOverlay {
    param(
        [Parameter(Mandatory = $true)][string]$OverlayRoot,
        [Parameter(Mandatory = $true)][string]$WorkingRoot
    )

    $source = Join-Path $OverlayRoot 'apps\desktop'
    $destination = Join-Path $WorkingRoot 'apps\desktop'
    if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json'))) {
        throw "Desktop overlay is incomplete: $source"
    }
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

function Prepare-UpstreamSource {
    param(
        [Parameter(Mandatory = $true)][string]$OverlayRoot,
        [Parameter(Mandatory = $true)][string]$WorkingRoot
    )

    $rootManifestPath = Join-Path $WorkingRoot 'package.json'
    $workspacePath = Join-Path $WorkingRoot 'pnpm-workspace.yaml'
    if (-not (Test-Path -LiteralPath $rootManifestPath)) {
        throw "Upstream package.json was not found: $rootManifestPath"
    }
    if (-not (Test-Path -LiteralPath $workspacePath)) {
        throw "Upstream pnpm-workspace.yaml was not found: $workspacePath"
    }

    $rootManifest = Get-Content -LiteralPath $rootManifestPath -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$rootManifest.version)) {
        throw 'The upstream root package has no version.'
    }

    Install-DesktopOverlay -OverlayRoot $OverlayRoot -WorkingRoot $WorkingRoot
    Set-JsonVersion -Path (Join-Path $WorkingRoot 'apps\desktop\package.json') -Version ([string]$rootManifest.version)
    Add-YamlMappingEntry -Path $workspacePath -Section 'overrides' -Key "'@electron/get'" -Value "'5.1.0'"
    Add-YamlMappingEntry -Path $workspacePath -Section 'allowBuilds' -Key 'electron' -Value 'true'
    Add-YamlMappingEntry -Path $workspacePath -Section 'allowBuilds' -Key 'electron-winstaller' -Value 'true'

    return [string]$rootManifest.version
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )

    $parentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $childPath = [System.IO.Path]::GetFullPath($Child).TrimEnd('\') + '\'
    if (-not $childPath.StartsWith($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside $parentPath`: $childPath"
    }
}

function Assert-SourceInfo {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$SourceInfo
    )

    foreach ($key in @('cleanupMode', 'commit', 'ref', 'source')) {
        if (-not $SourceInfo.Contains($key) -or [string]::IsNullOrWhiteSpace([string]$SourceInfo[$key])) {
            throw "Build source information is missing $key."
        }
    }
}
