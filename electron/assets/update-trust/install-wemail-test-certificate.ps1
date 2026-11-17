param(
  [string]$WeMailExe = "",
  [string]$CertificatePath = ""
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Resolve-FirstExistingPath {
  param([string[]]$Paths)

  foreach ($candidate in $Paths) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return ""
}

Write-Step "Locating WeMail executable"
if (-not $WeMailExe) {
  $installedRootCandidate = Join-Path $PSScriptRoot "..\..\.."
  $WeMailExe = Resolve-FirstExistingPath @(
    (Join-Path $installedRootCandidate "WeMailDesktop.exe"),
    (Join-Path $installedRootCandidate "WeMail.exe"),
    (Join-Path $env:ProgramFiles "WeMail\WeMailDesktop.exe"),
    (Join-Path $env:ProgramFiles "WeMail\WeMail.exe"),
    "$env:LOCALAPPDATA\Programs\WeMail\WeMailDesktop.exe",
    "$env:LOCALAPPDATA\Programs\WeMail\WeMail.exe",
    "$env:LOCALAPPDATA\Programs\wemail\WeMailDesktop.exe",
    "$env:LOCALAPPDATA\Programs\wemail\WeMail.exe"
  )
}

if (-not $WeMailExe -or -not (Test-Path -LiteralPath $WeMailExe)) {
  throw "WeMailDesktop.exe was not found. Run this script with -WeMailExe `"C:\path\to\WeMailDesktop.exe`"."
}

Write-Host "Using WeMail executable: $WeMailExe"

Write-Step "Preparing certificate"
if (-not $CertificatePath) {
  $CertificatePath = Resolve-FirstExistingPath @(
    (Join-Path $PSScriptRoot "WeMail-Test.cer")
  )
}

if (-not $CertificatePath) {
  $signature = Get-AuthenticodeSignature -LiteralPath $WeMailExe
  if ($null -eq $signature.SignerCertificate) {
    throw "$WeMailExe does not contain a signer certificate."
  }

  $CertificatePath = Join-Path $env:TEMP "WeMail-Test.cer"
  Export-Certificate `
    -Cert $signature.SignerCertificate `
    -FilePath $CertificatePath `
    -Force | Out-Null
}

if (-not (Test-Path -LiteralPath $CertificatePath)) {
  throw "Certificate was not found at: $CertificatePath"
}

Write-Host "Using certificate: $CertificatePath"

Write-Step "Confirming test certificate trust"
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($CertificatePath)
Write-Host "Subject: $($certificate.Subject)"
Write-Host "Thumbprint: $($certificate.Thumbprint)"
Write-Warning "This adds the certificate to your current-user root and publisher trust stores. Only continue after independently verifying its thumbprint."
if ((Read-Host "Type TRUST to continue") -cne "TRUST") {
  throw "Certificate trust installation cancelled."
}

Write-Step "Installing certificate to CurrentUser stores"
foreach ($store in @("Root", "TrustedPublisher", "TrustedPeople")) {
  & certutil -user -addstore -f $store $CertificatePath
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to add certificate to $store (certutil exit code $LASTEXITCODE). Earlier stores may already have been modified."
  }
}

Write-Step "Clearing Electron updater cache"
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\wemail-updater" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\WeMail-updater" -ErrorAction SilentlyContinue

Write-Step "Verifying WeMail signature"
Get-AuthenticodeSignature -LiteralPath $WeMailExe |
  Select-Object Status, StatusMessage, @{n = "Subject"; e = { $_.SignerCertificate.Subject } } |
  Format-List

Write-Host ""
Write-Host "Done. Restart WeMail and try checking for updates again."
