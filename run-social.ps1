# Runs the social pipeline locally.
#
# Use this instead of typing `npm run ...` directly, because PowerShell blocks
# npm.ps1 under the default execution policy. This script calls npm.cmd, which
# is not blocked.
#
#   powershell -ExecutionPolicy Bypass -File run-social.ps1            full run
#   powershell -ExecutionPolicy Bypass -File run-social.ps1 dry        select only
#   powershell -ExecutionPolicy Bypass -File run-social.ps1 images     render only
#   powershell -ExecutionPolicy Bypass -File run-social.ps1 all        both variants

$ErrorActionPreference = 'Stop'

# Node installs to C:\Program Files\nodejs but a shell that was open before the
# install will not have it on PATH, so add it defensively.
$nodeDir = 'C:\Program Files\nodejs'
if (Test-Path $nodeDir) { $env:PATH = "$nodeDir;$env:PATH" }

$npm = 'npm.cmd'
$mode = if ($args.Count -gt 0) { $args[0] } else { 'full' }

function Invoke-Npm([string]$name, [string[]]$extra) {
  Write-Host ""
  Write-Host "--- $name ---" -ForegroundColor Cyan
  & $npm run $name @extra
  if ($LASTEXITCODE -ne 0) { throw "$name failed with exit code $LASTEXITCODE" }
}

switch ($mode) {
  'dry' {
    # Preview both variants regardless of today's weekday.
    Invoke-Npm 'select:dry:all' @()
  }
  'select' {
    Invoke-Npm 'select' @()
  }
  'images' {
    Invoke-Npm 'images' @()
  }
  'all' {
    Invoke-Npm 'select:all' @()
  }
  'record' {
    Invoke-Npm 'record' @()
  }
  default {
    Write-Host "Select, render, record." -ForegroundColor Green
    Invoke-Npm 'select' @()
    Invoke-Npm 'images' @()
    Invoke-Npm 'record' @()
  }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green