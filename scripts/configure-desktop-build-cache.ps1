param([string]$ProjectRoot, [string]$CacheRoot = $env:WEMAIL_BUILD_CACHE)
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($CacheRoot)) { $CacheRoot = if (Test-Path "E:\") { "E:\wemail-build-cache" } else { Join-Path $ProjectRoot "workspace\cache\desktop" } }
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
if ([IO.Path]::GetPathRoot($CacheRoot) -eq "C:\") { throw "Desktop build cache must not use C: $CacheRoot" }
$electronCache = Join-Path $CacheRoot "electron\downloads"; New-Item -ItemType Directory -Path $electronCache -Force | Out-Null
@{ electron_config_cache=$electronCache; ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" }.GetEnumerator() | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Key, $_.Value, "User") }
Write-Host "[wemail-build] cache configured at $CacheRoot"
