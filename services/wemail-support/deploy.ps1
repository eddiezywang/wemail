param(
  [string]$HermesHome = "$env:LOCALAPPDATA\hermes",
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SuperAdminUserId,
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SuperAdminName,
  [switch]$ReplaceUnbaselinedKnowledge
)

$ErrorActionPreference = "Stop"
$sourceRoot = $PSScriptRoot
$pluginTarget = Join-Path $HermesHome "plugins\wemail-support-runtime"
$skillTarget = Join-Path $HermesHome "skills\wemail-support"
$soulTarget = Join-Path $HermesHome "SOUL.md"
$runtimeRoot = Join-Path $HermesHome "wemail-support"
$publishedTarget = Join-Path $runtimeRoot "knowledge\published"
$seedManifestPath = Join-Path $runtimeRoot "knowledge\seed-manifest.json"
$seedBackupRoot = Join-Path $runtimeRoot "knowledge\pre-seed-sync-backup"
$runtimeBaselinePath = Join-Path $runtimeRoot "product-baseline.json"
$configPath = Join-Path $HermesHome "config.yaml"
$pythonPath = Join-Path $HermesHome "hermes-agent\venv\Scripts\python.exe"
$hermesAgentRoot = Join-Path $HermesHome "hermes-agent"
$streamingPatch = Join-Path $sourceRoot "hermes-patches\wecom-native-streaming.patch"
$mediaDnsPatch = Join-Path $sourceRoot "hermes-patches\wecom-media-private-dns.patch"
$imageSniffingPatch = Join-Path $sourceRoot "hermes-patches\wecom-inbound-image-sniffing.patch"

# Reject missing prerequisites before changing plugin, knowledge or admin data.
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Hermes config not found: $configPath" }
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) { throw "Hermes Python not found: $pythonPath" }

# Detect malformed metadata and all unbaselined conflicts before writing any
# files. The subsequent synchronization still rechecks each source and target.
$preflightHashes = @{}
if (Test-Path -LiteralPath $seedManifestPath) {
  try {
    $preflightManifest = Get-Content -Raw -LiteralPath $seedManifestPath | ConvertFrom-Json
    foreach ($property in $preflightManifest.documents.PSObject.Properties) {
      $preflightHashes[$property.Name] = [string]$property.Value
    }
  } catch { throw "Knowledge seed manifest is invalid: $seedManifestPath" }
}
$adminPath = Join-Path $runtimeRoot "admins.json"
if (Test-Path -LiteralPath $adminPath) {
  try { $null = Get-Content -Raw -LiteralPath $adminPath | ConvertFrom-Json }
  catch { throw "Existing administrator configuration is invalid: $adminPath" }
}
$null = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot "product-baseline.json") | ConvertFrom-Json
if (-not $ReplaceUnbaselinedKnowledge) {
  Get-ChildItem -LiteralPath (Join-Path $sourceRoot "knowledge-seed") -Filter "*.md" | ForEach-Object {
    $destination = Join-Path $publishedTarget $_.Name
    if ((Test-Path -LiteralPath $destination) -and -not $preflightHashes[$_.Name]) {
      $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
      $runtimeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
      if ($sourceHash -ne $runtimeHash) {
        throw "Published knowledge differs from the repository seed and has no deployment baseline: $($_.Name). Review it, or explicitly use -ReplaceUnbaselinedKnowledge for the one-time migration."
      }
    }
  }
}

New-Item -ItemType Directory -Force -Path $pluginTarget,$skillTarget,$publishedTarget | Out-Null
Copy-Item -Force (Join-Path $sourceRoot "hermes-plugin\__init__.py") $pluginTarget
Copy-Item -Force (Join-Path $sourceRoot "hermes-plugin\runtime.py") $pluginTarget
Copy-Item -Force (Join-Path $sourceRoot "hermes-plugin\plugin.yaml") $pluginTarget
Copy-Item -Force (Join-Path $sourceRoot "hermes-skill\SKILL.md") $skillTarget
if (Test-Path $soulTarget) {
  Copy-Item -LiteralPath $soulTarget -Destination "$soulTarget.wemail-support.bak" -Force
  # Existing installations may have SOUL.md hard-linked to the skill file.
  # Remove the link before copying so persona and workflow remain independent.
  Remove-Item -LiteralPath $soulTarget -Force
}
Copy-Item -Force (Join-Path $sourceRoot "hermes-skill\SOUL.md") $soulTarget

$previousSeedHashes = @{}
if (Test-Path $seedManifestPath) {
  try {
    $manifest = Get-Content -Raw $seedManifestPath | ConvertFrom-Json
    foreach ($property in $manifest.documents.PSObject.Properties) {
      $previousSeedHashes[$property.Name] = [string]$property.Value
    }
  } catch {
    throw "Knowledge seed manifest is invalid: $seedManifestPath"
  }
}
$nextSeedHashes = @{}
Get-ChildItem (Join-Path $sourceRoot "knowledge-seed") -Filter "*.md" | ForEach-Object {
  $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
  $destination = Join-Path $publishedTarget $_.Name
  $canSync = -not (Test-Path $destination)
  if (-not $canSync) {
    $runtimeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
    $previousHash = [string]$previousSeedHashes[$_.Name]
    # Update a document only when it is still the previously deployed seed.
    # A reviewed runtime publication must not be silently overwritten.
    $canSync = ($runtimeHash -eq $sourceHash) -or ($previousHash -and $runtimeHash -eq $previousHash)
    if (-not $canSync -and -not $previousHash) {
      if (-not $ReplaceUnbaselinedKnowledge) {
        throw "Published knowledge differs from the repository seed and has no deployment baseline: $($_.Name). Review it, or explicitly use -ReplaceUnbaselinedKnowledge for the one-time migration."
      }
      New-Item -ItemType Directory -Force -Path $seedBackupRoot | Out-Null
      Copy-Item -LiteralPath $destination -Destination (Join-Path $seedBackupRoot $_.Name) -Force
      $canSync = $true
    }
  }
  if ($canSync) {
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    $nextSeedHashes[$_.Name] = $sourceHash
  } else {
    $nextSeedHashes[$_.Name] = [string]$previousSeedHashes[$_.Name]
  }
}
$productBaseline = Get-Content -Raw (Join-Path $sourceRoot "product-baseline.json") | ConvertFrom-Json
Copy-Item -LiteralPath (Join-Path $sourceRoot "product-baseline.json") -Destination $runtimeBaselinePath -Force
@{
  schema_version = 1
  deployed_at = [DateTimeOffset]::UtcNow.ToString("o")
  product_baseline = $productBaseline
  documents = $nextSeedHashes
} | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $seedManifestPath

$existingAdmins = @()
if (Test-Path $adminPath) {
  try {
    $existingAdmins = @((Get-Content -Raw $adminPath | ConvertFrom-Json).admins) |
      Where-Object { $_ -and $_.user_id -ne $SuperAdminUserId }
  } catch {
    throw "Existing administrator configuration is invalid: $adminPath"
  }
}
$superAdmin = [pscustomobject]@{
  user_id = $SuperAdminUserId
  display_name = $SuperAdminName
  role = "super_admin"
  modules = @("*")
  notification_target = "wecom:$SuperAdminUserId"
}
@{ admins = @($existingAdmins) + @($superAdmin) } |
  ConvertTo-Json -Depth 5 |
  Set-Content -Encoding utf8 $adminPath

Copy-Item -LiteralPath $configPath -Destination "$configPath.wemail-support.bak" -Force

$configure = @'
import pathlib, sys, yaml
path = pathlib.Path(sys.argv[1])
data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
plugins = data.setdefault("plugins", {})
enabled = plugins.setdefault("enabled", [])
if "wemail-support-runtime" not in enabled:
    enabled.append("wemail-support-runtime")
toolsets = data.setdefault("platform_toolsets", {}).setdefault("wecom", [])
if "wemail_support" not in toolsets:
    toolsets.append("wemail_support")
# This is a dedicated support agent with a small, fixed tool surface. Hermes'
# progressive tool disclosure adds tool_search/tool_describe/tool_call round
# trips and leaks those internal bridge names into WeCom's activity stream.
# Keep the support schemas directly available to the model instead.
data.setdefault("tools", {}).setdefault("tool_search", {})["enabled"] = "off"
# Internal retrieval and case-management calls are implementation details.
# Keep native text streaming, but never render tool names/arguments in WeCom.
wecom_display = data.setdefault("display", {}).setdefault("platforms", {}).setdefault("wecom", {})
wecom_display["tool_progress"] = "off"
wecom_display["streaming"] = True
data.setdefault("streaming", {})["enabled"] = True
# Codex transports can expose the same answer once as an interim commentary
# item and again as the final answer.  Keep native token streaming, but only
# deliver the final-answer channel so WeCom users see one reply.
data.setdefault("display", {})["interim_assistant_messages"] = False
path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
'@
& $pythonPath -c $configure $configPath
if ($LASTEXITCODE -ne 0) { throw "Failed to update Hermes configuration (Python exit code $LASTEXITCODE). Backup: $configPath.wemail-support.bak" }

if (Test-Path (Join-Path $hermesAgentRoot ".git")) {
  Push-Location $hermesAgentRoot
  try {
    foreach ($patch in @($streamingPatch, $mediaDnsPatch, $imageSniffingPatch)) {
      & git apply --reverse --check --ignore-space-change $patch 2>$null
      if ($LASTEXITCODE -ne 0) {
        & git apply --check --ignore-space-change $patch
        if ($LASTEXITCODE -ne 0) { throw "Hermes patch is incompatible with this version: $patch" }
        & git apply --ignore-space-change $patch
        if ($LASTEXITCODE -ne 0) { throw "Failed to apply Hermes patch: $patch" }
      }
    }
  } finally {
    Pop-Location
  }
}

Write-Output "WeMail support runtime deployed. Hermes Gateway restart is required to load it."
Write-Output "Backup: $configPath.wemail-support.bak"
