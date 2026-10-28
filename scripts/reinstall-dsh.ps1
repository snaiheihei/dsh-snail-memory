#Requires -Version 7.0

[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()]
  [string]$Profile = 'web',

  [string]$DshRepo
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Step {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$AllowedFailurePattern
  )

  Write-Host "`n==> $Name"
  $output = @()
  if ($PSBoundParameters.ContainsKey('AllowedFailurePattern')) {
    $output = @(& $FilePath @ArgumentList 2>&1)
    $output | ForEach-Object { Write-Host $_ }
  }
  else {
    & $FilePath @ArgumentList
  }
  if ($LASTEXITCODE -ne 0) {
    if ($PSBoundParameters.ContainsKey('AllowedFailurePattern') `
      -and (($output | Out-String) -match $AllowedFailurePattern)) {
      Write-Host "$Name did not find an installed dependency; continuing."
      return
    }
    throw "$Name failed with exit code $LASTEXITCODE."
  }
}

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($DshRepo)) {
  $DshRepo = Join-Path (Split-Path -Parent $RepoRoot) 'deepseek-harness'
}

$PackageJsonPath = Join-Path $RepoRoot 'package.json'
$DshBin = [IO.Path]::GetFullPath((Join-Path $DshRepo 'apps\cli\lib\bin.js'))
if (-not (Test-Path -LiteralPath $PackageJsonPath -PathType Leaf)) {
  throw "Plugin package.json not found: $PackageJsonPath"
}
if (-not (Test-Path -LiteralPath $DshBin -PathType Leaf)) {
  throw "dsh CLI not found: $DshBin. Pass -DshRepo with the deepseek-harness repository path."
}

$Package = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
$PackageName = [string]$Package.name
$PackageVersion = [string]$Package.version
if ([string]::IsNullOrWhiteSpace($PackageName) -or [string]::IsNullOrWhiteSpace($PackageVersion)) {
  throw 'Plugin package.json must contain name and version.'
}

$TarballName = ($PackageName -replace '^@', '' -replace '/', '-') + "-$PackageVersion.tgz"
$TarballPath = Join-Path $RepoRoot $TarballName

Push-Location $RepoRoot
try {
  Invoke-Step -Name "Remove $PackageName from dsh profile $Profile" `
    -FilePath 'node.exe' `
    -ArgumentList @($DshBin, 'plugin', '--profile', $Profile, 'remove', $PackageName) `
    -AllowedFailurePattern 'ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS'

  if (Test-Path -LiteralPath $TarballPath -PathType Leaf) {
    Remove-Item -LiteralPath $TarballPath -Force
  }
  Invoke-Step -Name 'Build and pack the plugin through npm prepack' `
    -FilePath 'npm.cmd' `
    -ArgumentList @('pack')
  if (-not (Test-Path -LiteralPath $TarballPath -PathType Leaf)) {
    throw "Expected tarball was not generated: $TarballPath"
  }

  Invoke-Step -Name "Install $TarballName into dsh profile $Profile" `
    -FilePath 'node.exe' `
    -ArgumentList @($DshBin, 'plugin', '--profile', $Profile, 'add', $TarballPath)

  Write-Host "`nInstalled $PackageName@$PackageVersion into dsh profile $Profile."
  Write-Host 'Restart dsh manually to load the new version.'
}
finally {
  Pop-Location
}
