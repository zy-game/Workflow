$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA 'Programs\qingmei-desktop'
Get-Process -Name '青梅' -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name 'Qingmei' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
$exe = Join-Path $dest 'Qingmei.exe'
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop '青梅.lnk'
$shortcut = $ws.CreateShortcut($link)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $dest
$shortcut.Save()
Write-Host "Installed to $dest"
Write-Host "Shortcut: $link"
Start-Process -FilePath $exe
