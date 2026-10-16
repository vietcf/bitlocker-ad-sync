# Lab test of the Go worker on Windows: builds it, asks for the AD password at a hidden prompt
# (kept in this PowerShell process only), takes the ingest API key from server/.env, then runs
# `check` and one `run-once` (delta, or full with -Full) with config.json.
param([switch]$Full)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

go build -o bin/blk-sync.exe ./cmd/blk-sync
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$secure = Read-Host -AsSecureString 'AD password (EXAMPLE\sp_admin)'
$env:BLK_LDAP_PASSWORD = [Net.NetworkCredential]::new('', $secure).Password
$keyLine = Select-String -Path (Join-Path $root '..\server\.env') -Pattern '^INGEST_API_KEY=' | Select-Object -First 1
if (-not $keyLine) { throw 'INGEST_API_KEY not found in server/.env' }
$env:BLK_INGEST_API_KEY = $keyLine.Line.Split('=', 2)[1]

try {
    Write-Host "`n== check" -ForegroundColor Cyan
    & .\bin\blk-sync.exe check
    Write-Host "exit $LASTEXITCODE"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $mode = if ($Full) { 'full' } else { 'delta' }
    Write-Host "`n== run-once $mode" -ForegroundColor Cyan
    & .\bin\blk-sync.exe run-once $mode
    Write-Host "exit $LASTEXITCODE"
}
finally {
    Remove-Item Env:BLK_LDAP_PASSWORD, Env:BLK_INGEST_API_KEY -ErrorAction SilentlyContinue
}
