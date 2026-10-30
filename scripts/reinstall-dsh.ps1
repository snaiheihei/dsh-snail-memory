#Requires -Version 7.0
<#
.SYNOPSIS
  Rebuild, reinstall and repackage this plugin from the repository root.

.DESCRIPTION
  Safe to run from the project root or from anywhere else: every path is resolved
  from this script's location. The script runs these steps in order:

    0. verify the toolchain (node, npm, dsh CLI, package.json)
    1. create the target dsh profile from a template when it does not exist yet
    2. optionally run typecheck and vitest (-RunTests)
    3. uninstall the plugin from the profile (tolerates "not installed")
    4. npm pack, whose prepack rebuilds dist/ from src/
    5. install the tarball back into the profile
    6. verify the composed profile actually lists the bundle
    7. build dsh-snail-memory-<version>.zip for the plugin market and check it

  Nothing is published and no git state is touched.

.PARAMETER Profile
  Target dsh profile. Default: web.

.PARAMETER DshRepo
  deepseek-harness checkout. Default: the sibling directory ../deepseek-harness.

.PARAMETER DshHome
  Isolated DSH_HOME for this run. Also sets DSH_AGENTS_HOME=<DshHome>/agents and
  restores both after the run. Use it to test without touching the real profile.

.PARAMETER Template
  Profile template used when the profile does not exist yet. Default: web.

.PARAMETER RunTests
  Run npm run typecheck and npm test before packing.

.PARAMETER SkipInstall
  Only build, pack and zip. Leaves the profile untouched.

.EXAMPLE
  ./scripts/reinstall-dsh.ps1

.EXAMPLE
  ./scripts/reinstall-dsh.ps1 -Profile web -RunTests

.EXAMPLE
  ./scripts/reinstall-dsh.ps1 -DshHome "$env:TEMP\dsh-sandbox" -Profile sandbox
#>
[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()]
  [string]$Profile = 'web',

  [string]$DshRepo,

  [string]$DshHome,

  [ValidateNotNullOrEmpty()]
  [string]$Template = 'web',

  [switch]$RunTests,

  [switch]$SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Text)
  Write-Host "`n==> $Text" -ForegroundColor Cyan
}

function Assert-LastExit {
  param([string]$Name)
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE."
  }
}

function Format-Size {
  param([long]$Bytes)
  if ($Bytes -ge 1MB) { return '{0:N2} MB' -f ($Bytes / 1MB) }
  return '{0:N1} KB' -f ($Bytes / 1KB)
}

# ---------------------------------------------------------------- toolchain ---

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PackageJsonPath = Join-Path $RepoRoot 'package.json'
if (-not (Test-Path -LiteralPath $PackageJsonPath -PathType Leaf)) {
  throw "Plugin package.json not found: $PackageJsonPath"
}

$package = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
$PackageName = [string]$package.name
$PackageVersion = [string]$package.version
if ([string]::IsNullOrWhiteSpace($PackageName) -or [string]::IsNullOrWhiteSpace($PackageVersion)) {
  throw 'package.json must declare name and version.'
}

$slug = ($PackageName -replace '^@', '') -replace '/', '-'
$TarballPath = Join-Path $RepoRoot "$slug-$PackageVersion.tgz"
$ZipPath = Join-Path $RepoRoot "$slug-$PackageVersion.zip"

if ([string]::IsNullOrWhiteSpace($DshRepo)) {
  $DshRepo = Join-Path (Split-Path -Parent $RepoRoot) 'deepseek-harness'
}
$DshBin = [IO.Path]::GetFullPath((Join-Path $DshRepo 'apps\cli\lib\bin.js'))
if (-not (Test-Path -LiteralPath $DshBin -PathType Leaf)) {
  throw "dsh CLI not found: $DshBin. Pass -DshRepo with the deepseek-harness checkout."
}

$Node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($Node)) {
  throw 'node.exe was not found on PATH.'
}
$Npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($Npm)) {
  throw 'npm.cmd was not found on PATH.'
}

Write-Step "Plugin $PackageName@$PackageVersion"
Write-Host "  repository : $RepoRoot"
Write-Host "  dsh CLI    : $DshBin"
Write-Host "  profile    : $Profile$(if ($SkipInstall) { ' (install skipped)' } else { '' })"

$previousDshHome = $env:DSH_HOME
$previousAgentsHome = $env:DSH_AGENTS_HOME

Push-Location -LiteralPath $RepoRoot
try {
  if (-not [string]::IsNullOrWhiteSpace($DshHome)) {
    $env:DSH_HOME = [IO.Path]::GetFullPath($DshHome)
    $env:DSH_AGENTS_HOME = Join-Path $env:DSH_HOME 'agents'
    New-Item -ItemType Directory -Force -Path $env:DSH_HOME, $env:DSH_AGENTS_HOME | Out-Null
    Write-Host "  DSH_HOME   : $env:DSH_HOME (isolated for this run)"
  }

  $resolvedHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    Join-Path $env:USERPROFILE '.dsh'
  }
  else {
    $env:DSH_HOME
  }
  $profileDir = Join-Path $resolvedHome (Join-Path 'profiles' $Profile)

  # 1. profile -------------------------------------------------------------
  if (-not (Test-Path -LiteralPath $profileDir -PathType Container)) {
    Write-Step "Create profile '$Profile' from template '$Template'"
    & $Node $DshBin --profile $Profile --from-default-profile $Template --help | Out-Null
    Assert-LastExit 'profile creation'
    if (-not (Test-Path -LiteralPath $profileDir -PathType Container)) {
      throw "Profile '$Profile' was not created at $profileDir."
    }
    Write-Host "  created $profileDir"
  }

  # 2. tests ---------------------------------------------------------------
  if ($RunTests) {
    Write-Step 'Typecheck'
    & $Npm run typecheck
    Assert-LastExit 'npm run typecheck'

    Write-Step 'Tests'
    & $Npm test
    Assert-LastExit 'npm test'
  }

  # 3. uninstall -----------------------------------------------------------
  if (-not $SkipInstall) {
    Write-Step "Uninstall $PackageName from profile '$Profile'"
    $removeOutput = @(& $Node $DshBin plugin --profile $Profile remove $PackageName 2>&1)
    $removeExit = $LASTEXITCODE
    $removeText = $removeOutput | Out-String
    if ($removeExit -eq 0) {
      $removeOutput | ForEach-Object { Write-Host "  $_" }
    }
    elseif ($removeText -match 'CANNOT_REMOVE_MISSING_DEPS|not in the dependencies|No package found') {
      Write-Host '  not installed; continuing.'
    }
    else {
      $removeOutput | ForEach-Object { Write-Host "  $_" }
      throw "Uninstall failed with exit code $removeExit."
    }

    # 4. pack --------------------------------------------------------------
    Write-Step 'Build and pack (npm prepack rebuilds dist/)'
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules') -PathType Container)) {
      Write-Host '  node_modules missing; installing dependencies with --legacy-peer-deps'
      & $Npm install --no-audit --no-fund --legacy-peer-deps
      Assert-LastExit 'npm install'
    }
    if (Test-Path -LiteralPath $TarballPath -PathType Leaf) {
      Remove-Item -LiteralPath $TarballPath -Force
    }
    & $Npm pack
    Assert-LastExit 'npm pack'
    if (-not (Test-Path -LiteralPath $TarballPath -PathType Leaf)) {
      throw "Expected tarball was not generated: $TarballPath"
    }

    # 5. install -----------------------------------------------------------
    Write-Step "Install $([IO.Path]::GetFileName($TarballPath)) into profile '$Profile'"
    & $Node $DshBin plugin --profile $Profile add $TarballPath
    Assert-LastExit 'plugin add'

    # 6. verify ------------------------------------------------------------
    Write-Step 'Verify the composed profile'
    $config = @(& $Node $DshBin --profile $Profile --dump-config 2>&1)
    Assert-LastExit 'dump-config'
    if (($config | Out-String) -notmatch [regex]::Escape($PackageName)) {
      throw "The composed profile does not list '$PackageName'."
    }
    Write-Host "  '$PackageName' appears in the composed profile."
  }

  # 7. market zip ----------------------------------------------------------
  Write-Step "Build market ZIP $([IO.Path]::GetFileName($ZipPath))"
  $zipSources = @('package.json', 'cordis.patch.yml', 'plugin.json', 'dsh.plugin.json', 'README.md', 'LICENSE', 'dist')
  $missingSources = @($zipSources | Where-Object { -not (Test-Path -LiteralPath (Join-Path $RepoRoot $_) ) })
  if ($missingSources.Count -gt 0) {
    throw "ZIP source is missing: $($missingSources -join ', ')"
  }
  foreach ($file in 'dist/index.js', 'dist/client.js') {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $file) -PathType Leaf)) {
      throw "Build output is missing: $file. Run the build before packing."
    }
  }
  if (Test-Path -LiteralPath $ZipPath -PathType Leaf) {
    Remove-Item -LiteralPath $ZipPath -Force
  }
  $zipInputs = @($zipSources | ForEach-Object { Join-Path $RepoRoot $_ })
  Compress-Archive -Path $zipInputs -DestinationPath $ZipPath -CompressionLevel Optimal

  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName })
  }
  finally {
    $archive.Dispose()
  }

  $requiredEntries = @(
    'package.json', 'cordis.patch.yml', 'plugin.json', 'dsh.plugin.json',
    'README.md', 'LICENSE', 'dist/index.js', 'dist/client.js'
  )
  $missingEntries = @($requiredEntries | Where-Object { $entries -notcontains $_ })
  if ($missingEntries.Count -gt 0) {
    throw "ZIP misses required entries: $($missingEntries -join ', ')"
  }
  $devEntries = @($entries | Where-Object { $_ -match '^(node_modules/|src/|tests/|demo-data/|\.git/|\.qoder/|package-lock|pnpm-lock)' })
  if ($devEntries.Count -gt 0) {
    throw "ZIP contains development files: $($devEntries -join ', ')"
  }
  Write-Host "  $($entries.Count) entries, required files present, no development files."

  # summary ---------------------------------------------------------------
  Write-Step 'Summary'
  $tarballSize = if (Test-Path -LiteralPath $TarballPath) { (Get-Item -LiteralPath $TarballPath).Length } else { 0 }
  $zipSize = (Get-Item -LiteralPath $ZipPath).Length
  Write-Host ("  tarball : {0}  ({1})" -f $TarballPath, (Format-Size $tarballSize))
  Write-Host ("  zip     : {0}  ({1})" -f $ZipPath, (Format-Size $zipSize))
  Write-Host ("  zip sha : {0}" -f (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash)
  if (-not $SkipInstall) {
    Write-Host ''
    Write-Host "  Installed $PackageName@$PackageVersion into profile '$Profile'."
    Write-Host "  Restart dsh to load the new version: dsh --profile $Profile"
  }
  else {
    Write-Host ''
    Write-Host "  Profile '$Profile' was left untouched (-SkipInstall)."
  }

  $staleUploads = @(Get-ChildItem -LiteralPath $RepoRoot -Filter "$slug-*.zip" -File |
    Where-Object { $_.FullName -ne $ZipPath } | Sort-Object Name)
  if ($staleUploads.Count -gt 0) {
    Write-Host "  older ZIPs are still in the repository root; upload $([IO.Path]::GetFileName($ZipPath)):"
    $staleUploads | ForEach-Object { Write-Host "    - $($_.Name)" }
  }
}
finally {
  Pop-Location
  if (-not [string]::IsNullOrWhiteSpace($DshHome)) {
    $env:DSH_HOME = $previousDshHome
    $env:DSH_AGENTS_HOME = $previousAgentsHome
  }
}
