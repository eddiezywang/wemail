[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [int]$DesktopPid,
  [int]$DurationSeconds = 60,
  [int]$IntervalSeconds = 5,
  [string]$OutputPath = "workspace/reports/wemail-runtime-resource-sample.json"
)

$ErrorActionPreference = "Stop"
$startedAt = Get-Date
$logicalProcessors = [Environment]::ProcessorCount
$sampleCount = [Math]::Max(1, [Math]::Ceiling($DurationSeconds / $IntervalSeconds))
$previousCpu = @{}
$samples = [System.Collections.Generic.List[object]]::new()

function Get-DescendantProcesses([int]$RootPid, [object[]]$AllProcesses) {
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootPid)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($item in $AllProcesses) {
      if ($ids.Contains([int]$item.ParentProcessId) -and -not $ids.Contains([int]$item.ProcessId)) {
        [void]$ids.Add([int]$item.ProcessId)
        $changed = $true
      }
    }
  }
  return @($AllProcesses | Where-Object { $ids.Contains([int]$_.ProcessId) })
}

function Get-ProcessRole([int]$ProcessId, [int]$RootPid, [Nullable[int]]$MailCorePid, [string]$Name, [string]$CommandLine) {
  if ($ProcessId -eq $RootPid) { return "main" }
  if ($null -ne $MailCorePid -and $ProcessId -eq [int]$MailCorePid) { return "mailCore" }
  if ($Name -like "*crashpad*") { return "crashpad" }
  if ($CommandLine -match "--type=crashpad-handler") { return "crashpad" }
  if ($CommandLine -match "--type=renderer") { return "renderer" }
  if ($CommandLine -match "--type=gpu-process") { return "gpu" }
  if ($CommandLine -match "network\.mojom\.NetworkService") { return "network" }
  return "other"
}

function Get-Percentile([double[]]$Values, [double]$Quantile) {
  if (-not $Values -or $Values.Count -eq 0) { return 0 }
  $sorted = @($Values | Sort-Object)
  $index = [Math]::Min($sorted.Count - 1, [Math]::Floor($sorted.Count * $Quantile))
  return [double]$sorted[$index]
}

function Get-MetricSummary([object[]]$ProcessSamples) {
  $ws = [double[]]@($ProcessSamples | ForEach-Object { $_.workingSetBytes })
  $private = [double[]]@($ProcessSamples | ForEach-Object { $_.privateBytes })
  $cpu = [double[]]@($ProcessSamples | ForEach-Object { $_.cpuPercent })
  $threads = [double[]]@($ProcessSamples | ForEach-Object { $_.threadCount })
  $handles = [double[]]@($ProcessSamples | ForEach-Object { $_.handleCount })
  return [pscustomobject]@{
    sampleCount = $ProcessSamples.Count
    workingSetBytes = [pscustomobject]@{ p50 = Get-Percentile $ws 0.50; p95 = Get-Percentile $ws 0.95; max = ($ws | Measure-Object -Maximum).Maximum }
    privateBytes = [pscustomobject]@{ p50 = Get-Percentile $private 0.50; p95 = Get-Percentile $private 0.95; max = ($private | Measure-Object -Maximum).Maximum }
    cpuPercent = [pscustomobject]@{ average = ($cpu | Measure-Object -Average).Average; p95 = Get-Percentile $cpu 0.95; max = ($cpu | Measure-Object -Maximum).Maximum }
    threads = [pscustomobject]@{ p50 = Get-Percentile $threads 0.50; p95 = Get-Percentile $threads 0.95; max = ($threads | Measure-Object -Maximum).Maximum; growthPercent = Get-GrowthPercent $threads }
    handles = [pscustomobject]@{ p50 = Get-Percentile $handles 0.50; p95 = Get-Percentile $handles 0.95; max = ($handles | Measure-Object -Maximum).Maximum; growthPercent = Get-GrowthPercent $handles }
  }
}

function Get-GrowthPercent([double[]]$Values) {
  if (-not $Values -or $Values.Count -lt 2 -or $Values[0] -eq 0) { return 0 }
  return (($Values[-1] - $Values[0]) / $Values[0]) * 100
}

for ($index = 0; $index -lt $sampleCount; $index += 1) {
  $sampleStartedAt = Get-Date
  $allProcesses = @(Get-CimInstance Win32_Process)
  $descendants = @(Get-DescendantProcesses $DesktopPid $allProcesses)
  $mailCorePid = $null
  $startupLog = Join-Path $env:APPDATA "wemail\data\startup.log"
  if (Test-Path -LiteralPath $startupLog) {
    $spawnLine = Get-Content -LiteralPath $startupLog | Where-Object { $_ -like '*"phase":"mail-core-spawned"*' } | Select-Object -Last 1
    if ($spawnLine) {
      try { $mailCorePid = [int](($spawnLine | ConvertFrom-Json).pid) } catch { $mailCorePid = $null }
    }
  }
  $processes = foreach ($item in $descendants) {
    $id = [int]$item.ProcessId
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $cpuTotal = [double]($process.CPU ?? 0)
    $prior = $previousCpu[$id]
    $cpuPercent = if ($null -eq $prior) { 0 } else {
      [Math]::Max(0, (($cpuTotal - [double]$prior) / $IntervalSeconds) * 100 / $logicalProcessors)
    }
    $previousCpu[$id] = $cpuTotal
    $role = Get-ProcessRole $id $DesktopPid $mailCorePid ([string]$item.Name) ([string]$item.CommandLine)
    [pscustomobject]@{
      pid = $id
      parentPid = [int]$item.ParentProcessId
      name = $process.ProcessName
      role = $role
      workingSetBytes = [long]$process.WorkingSet64
      privateBytes = [long]$process.PrivateMemorySize64
      cpuPercent = $cpuPercent
      threadCount = @($process.Threads).Count
      handleCount = [int]$process.HandleCount
    }
  }
  $mailCore = $processes | Where-Object { $_.pid -eq $mailCorePid } | Select-Object -First 1
  $roleTotals = foreach ($roleGroup in @($processes | Group-Object role)) {
    [pscustomobject]@{
      role = $roleGroup.Name
      workingSetBytes = [long](($roleGroup.Group | Measure-Object workingSetBytes -Sum).Sum ?? 0)
      privateBytes = [long](($roleGroup.Group | Measure-Object privateBytes -Sum).Sum ?? 0)
      cpuPercent = [double](($roleGroup.Group | Measure-Object cpuPercent -Sum).Sum ?? 0)
      threadCount = [int](($roleGroup.Group | Measure-Object threadCount -Sum).Sum ?? 0)
      handleCount = [int](($roleGroup.Group | Measure-Object handleCount -Sum).Sum ?? 0)
      processCount = $roleGroup.Count
    }
  }
  $samples.Add([pscustomobject]@{
    at = (Get-Date).ToUniversalTime().ToString("o")
    processes = @($processes)
    roles = @($roleTotals)
    mailCore = $mailCore
    electron = [pscustomobject]@{
      workingSetBytes = [long](($processes | Measure-Object workingSetBytes -Sum).Sum ?? 0)
      privateBytes = [long](($processes | Measure-Object privateBytes -Sum).Sum ?? 0)
      cpuPercent = [double](($processes | Measure-Object cpuPercent -Sum).Sum ?? 0)
      threadCount = [int](($processes | Measure-Object threadCount -Sum).Sum ?? 0)
      handleCount = [int](($processes | Measure-Object handleCount -Sum).Sum ?? 0)
      processCount = @($processes).Count
    }
  })
  $elapsed = ((Get-Date) - $sampleStartedAt).TotalMilliseconds
  $sleepMs = [Math]::Max(0, $IntervalSeconds * 1000 - $elapsed)
  if ($index + 1 -lt $sampleCount -and $sleepMs -gt 0) { Start-Sleep -Milliseconds $sleepMs }
}

$mailCoreSamples = @($samples | Where-Object { $_.mailCore })
$allRoleSamples = @($samples | ForEach-Object { $_.roles })
$roles = [ordered]@{}
foreach ($role in @("main", "mailCore", "renderer", "gpu", "network", "crashpad", "other")) {
  $roleSamples = @($allRoleSamples | Where-Object { $_.role -eq $role })
  if ($roleSamples.Count -gt 0) { $roles[$role] = Get-MetricSummary $roleSamples }
}
$totalSamples = @($samples | ForEach-Object { $_.electron })
$summary = [pscustomobject]@{
  total = Get-MetricSummary $totalSamples
  mailCore = if ($mailCoreSamples.Count -gt 0) { Get-MetricSummary @($mailCoreSamples | ForEach-Object { $_.mailCore }) } else { $null }
  roles = [pscustomobject]$roles
}
$report = [pscustomobject]@{
  version = 2
  startedAt = $startedAt.ToUniversalTime().ToString("o")
  completedAt = (Get-Date).ToUniversalTime().ToString("o")
  durationSeconds = $DurationSeconds
  intervalSeconds = $IntervalSeconds
  desktopPid = $DesktopPid
  logicalProcessors = $logicalProcessors
  sampleCount = $samples.Count
  mailCoreSampleCount = $mailCoreSamples.Count
  summary = $summary
  samples = $samples
}
$absoluteOutput = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputPath))
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($absoluteOutput)) | Out-Null
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $absoluteOutput -Encoding utf8
Write-Output $absoluteOutput
