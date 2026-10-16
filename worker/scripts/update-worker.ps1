<#
.SYNOPSIS
  Updates an installed BitlockerSync worker to a new build, keeping its configuration.

.DESCRIPTION
  Run as a local administrator on the worker server.
  1. Backs up the install folder to <InstallDir>.bak-<timestamp>.
  2. Stops the service and copies the new build over the install folder, except appsettings.json
     (it holds this server's settings and dpapi: secrets) and appsettings.Development.json.
  3. Runs `check`, then starts the service again.
  The new build's appsettings.json is saved as appsettings.new.json so new settings can be
  compared and copied over by hand. The sync state (C:\ProgramData\BitlockerSync) is not touched.

  Roll back: Stop-Service BitlockerSync, copy the .bak-<timestamp> folder back, Start-Service.

.EXAMPLE
  .\update-worker.ps1 -Source D:\drop\BitlockerSync-1.1
#>
[CmdletBinding()]
param(
    # Folder produced by `dotnet publish` for the new version.
    [Parameter(Mandatory)] [string] $Source,
    [string] $InstallDir = (Split-Path -Parent $PSScriptRoot),
    [string] $ServiceName = 'BitlockerSync'
)

$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path $Source).Path
$InstallDir = (Resolve-Path $InstallDir).Path
if ($Source -eq $InstallDir) { throw 'Source must be the new build, not the install folder.' }
if (-not (Test-Path (Join-Path $Source 'BitlockerSync.Worker.exe'))) { throw "Not a published worker folder: $Source" }
if (-not (Test-Path (Join-Path $InstallDir 'appsettings.json'))) { throw "No appsettings.json in ${InstallDir}: install first (install-service.ps1)." }

$backup = "$InstallDir.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Write-Host "Backing up $InstallDir to $backup"
Copy-Item $InstallDir $backup -Recurse

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Stopping $ServiceName (a run in progress is closed as failed and repeated later)"
    Stop-Service $ServiceName
    $service.WaitForStatus('Stopped', [TimeSpan]::FromMinutes(2))
}

$keep = @('appsettings.json', 'appsettings.Development.json')
Get-ChildItem $Source -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($Source.Length).TrimStart('\')
    if ($keep -contains $relative) { return }
    $target = Join-Path $InstallDir $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item $_.FullName $target -Force
}
Copy-Item (Join-Path $Source 'appsettings.json') (Join-Path $InstallDir 'appsettings.new.json') -Force

Write-Host 'Checking configuration and LDAP access with the new build...'
& (Join-Path $InstallDir 'BitlockerSync.Worker.exe') check
if ($LASTEXITCODE -ne 0) {
    Write-Warning "check failed (exit $LASTEXITCODE). The service is left stopped. Fix the settings, or roll back from $backup."
    exit 1
}

if ($service) {
    Start-Service $ServiceName
    Write-Host "Updated and started $ServiceName. Compare appsettings.new.json with appsettings.json for new settings."
} else {
    Write-Host 'Files updated. The service is not installed: run install-service.ps1.'
}
