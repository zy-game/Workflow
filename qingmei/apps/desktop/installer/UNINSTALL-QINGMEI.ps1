$ErrorActionPreference = 'Stop'
Get-Process -Name '青梅' -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name 'Qingmei' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
$dest = Join-Path $env:LOCALAPPDATA 'Programs\qingmei-desktop'
$link = Join-Path ([Environment]::GetFolderPath('Desktop')) '青梅.lnk'
if (Test-Path $link) { Remove-Item $link -Force }
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Write-Host 'Uninstalled (data kept at %LOCALAPPDATA%\qingmei-desktop)'
