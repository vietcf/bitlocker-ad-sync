<#
.SYNOPSIS
  Installs (or updates) the BitlockerSync Windows Service.

.DESCRIPTION
  Run as a local administrator on the worker server, from the folder produced by
  `dotnet publish` (it must contain BitlockerSync.Worker.exe and appsettings.json).

  -Account, one of:
    - a gMSA ("CORP\gmsa-blk$", recommended; the server must be allowed to retrieve its
      password: Install-ADServiceAccount gmsa-blk);
    - a regular domain account ("CORP\svc-blk"): you are prompted for its password, and it needs
      the "Log on as a service" right on this server;
    - the service's virtual account ("NT SERVICE\BitlockerSync"): no password; use it when LDAP
      signs in with Ldap:Username / Ldap:Password from appsettings.json.

.EXAMPLE
  .\install-service.ps1 -Account 'CORP\gmsa-blk$'
.EXAMPLE
  .\install-service.ps1 -Account 'CORP\svc-blk'
.EXAMPLE
  .\install-service.ps1 -Account 'NT SERVICE\BitlockerSync'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Account,
    [string] $InstallDir = (Split-Path -Parent $PSScriptRoot),
    [string] $ServiceName = 'BitlockerSync'
)

$ErrorActionPreference = 'Stop'
$exe = Join-Path $InstallDir 'BitlockerSync.Worker.exe'
if (-not (Test-Path $exe)) { throw "Not found: $exe (run from the published folder or pass -InstallDir)." }

# Event log source for the service's logs (Application log).
if (-not [System.Diagnostics.EventLog]::SourceExists($ServiceName)) {
    New-EventLog -LogName Application -Source $ServiceName
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-Service $ServiceName -ErrorAction SilentlyContinue
    sc.exe config $ServiceName binPath= "`"$exe`"" | Out-Null
} else {
    sc.exe create $ServiceName binPath= "`"$exe`"" start= delayed-auto DisplayName= "BitLocker Key Sync" | Out-Null
}

if ($Account.EndsWith('$') -or $Account -like 'NT SERVICE\*') {
    # gMSA (Windows fetches its password from AD) or virtual account: no password.
    sc.exe config $ServiceName obj= $Account password= '' | Out-Null
} else {
    $cred = Get-Credential -UserName $Account -Message "Password for $Account"
    sc.exe config $ServiceName obj= $Account password= $cred.GetNetworkCredential().Password | Out-Null
}

sc.exe description $ServiceName "Syncs BitLocker recovery keys from Active Directory to the key management app." | Out-Null
# Restart after 1 minute on any crash (design doc: Windows Service recovery).
sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null

# appsettings.json holds the secrets (Ldap:Password, Ingest:ApiKey) in plain text:
# only administrators, SYSTEM and the service account may read it.
$settings = Join-Path $InstallDir 'appsettings.json'
icacls $settings /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' "${Account}:R" | Out-Null

# The state file folder (no secrets) must be writable by the service account.
$stateDir = Join-Path $env:ProgramData 'BitlockerSync'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
icacls $stateDir /grant "${Account}:(OI)(CI)M" | Out-Null

Write-Host "Checking configuration and LDAP access as the current user (the service will use $Account)..."
& $exe check
Write-Host "Installed. Start with: Start-Service $ServiceName  (logs: Event Viewer > Application > source $ServiceName)"
