param(
  [ValidateSet('nsis', 'msi', 'nsis,msi')]
  [string]$Bundles = 'nsis',
  [switch]$SkipInstall,
  [switch]$NoClean,
  [string]$VsDevCmd = "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
  throw 'Windows local packaging must run on Windows.'
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$desktopDir = Join-Path $repoRoot 'desktop'
$tauriDir = Join-Path $desktopDir 'src-tauri'
$tauriConfig = Join-Path $tauriDir 'tauri.conf.json'
$distIndex = Join-Path $repoRoot 'third_party\perfetto\ui\out\dist\index.html'

if (-not (Test-Path -LiteralPath $distIndex)) {
  throw @"
Missing Perfetto UI dist at:
  $distIndex

Windows cannot build upstream Perfetto UI directly. Prepare it first by
extracting a Linux/macOS-built perfetto-ui-dist artifact into:
  third_party\perfetto\ui\out\dist

Then re-run:
  powershell -ExecutionPolicy Bypass -File scripts\package-windows-local.ps1
"@
}

if (-not (Test-Path -LiteralPath $VsDevCmd)) {
  throw "Visual Studio Developer Command Prompt was not found: $VsDevCmd"
}

$configArg = '{\"build\":{\"beforeBuildCommand\":null}}'
$cmdParts = @(
  "call `"$VsDevCmd`" -arch=x64 -host_arch=x64",
  "cd /d `"$desktopDir`""
)

if (-not $SkipInstall) {
  $cmdParts += 'corepack pnpm install --frozen-lockfile'
}

if (-not $NoClean) {
  $cmdParts += "cd /d `"$tauriDir`""
  $cmdParts += 'cargo clean -p perfetto-desktop'
  $cmdParts += "cd /d `"$desktopDir`""
}

$cmdParts += "corepack pnpm tauri build --verbose --bundles $Bundles -c `"$configArg`""
$cmdLine = $cmdParts -join ' && '

cmd.exe /d /s /c $cmdLine
if ($LASTEXITCODE -ne 0) {
  throw "Windows packaging failed with exit code $LASTEXITCODE"
}

$bundleRoot = Join-Path $tauriDir 'target\release\bundle'
$appVersion = (Get-Content -LiteralPath $tauriConfig -Raw | ConvertFrom-Json).version
Write-Host ''
Write-Host 'Windows package artifacts:'
Get-ChildItem -Path $bundleRoot -Recurse -File -Include '*.exe', '*.msi' |
  Where-Object { $_.Name -like "*_$($appVersion)_*" } |
  Sort-Object FullName |
  Select-Object FullName, Length, LastWriteTime
