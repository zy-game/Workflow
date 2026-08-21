param(
    [string]$SourceRoot,
    [Parameter(Mandatory = $true)]
    [string]$DshRuntimeSource,
    [string]$InstallRoot = "$env:ProgramData\WorkflowCore",
    [string]$TaskName = 'Workflow Core Worker'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$workerToken = [Console]::In.ReadToEnd().Trim()
if ([string]::IsNullOrWhiteSpace($workerToken)) {
    throw 'Worker token is required on standard input'
}
$runtime = Join-Path $InstallRoot 'runtime'
$secrets = Join-Path $InstallRoot 'secrets'
$startScript = Join-Path $runtime 'ops\windows\start-workflow-worker.ps1'
$node = (Get-Command node.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $InstallRoot, $runtime, $secrets | Out-Null
& icacls.exe $InstallRoot /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to restrict ACLs on $InstallRoot" }

$plain = [Text.Encoding]::UTF8.GetBytes($workerToken)
try {
    $encrypted = [Security.Cryptography.ProtectedData]::Protect(
        $plain,
        $null,
        [Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    [Convert]::ToBase64String($encrypted) | Set-Content -NoNewline -Encoding Ascii (Join-Path $secrets 'worker-token.dpapi')
} finally {
    [Array]::Clear($plain, 0, $plain.Length)
    $workerToken = $null
}

robocopy $SourceRoot $runtime /MIR /XD node_modules .git /XF '*.log' | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Runtime copy failed with robocopy exit code $LASTEXITCODE" }

& npm.cmd ci --prefix $runtime --registry=https://registry.npmjs.org/ --fetch-retries=1 --fetch-timeout=60000 --no-audit --no-fund --omit=dev
if ($LASTEXITCODE -ne 0) { throw "Workflow runtime dependency install failed" }

$dshPackage = Join-Path $DshRuntimeSource 'node_modules\@deepseek-ai\dsh\package.json'
$dshLockPath = Join-Path $DshRuntimeSource 'package-lock.json'
if (-not (Test-Path $dshPackage)) { throw "DSH runtime is incomplete: $DshRuntimeSource" }
if (-not (Test-Path $dshLockPath)) { throw "DSH runtime lockfile is missing: $dshLockPath" }
$dshVersion = (Get-Content -Raw $dshPackage | ConvertFrom-Json).version
if ($dshVersion -ne '0.1.0-rc.8') { throw "Expected DSH 0.1.0-rc.8, got $dshVersion" }
$dshLock = Get-Content -Raw $dshLockPath | ConvertFrom-Json
$lockedDsh = $dshLock.packages.PSObject.Properties | Where-Object { $_.Name -like 'node_modules/@deepseek-ai/dsh*' }
if (-not $lockedDsh -or ($lockedDsh | Where-Object { $_.Value.version -ne '0.1.0-rc.8' })) {
    throw 'DSH lockfile must pin the complete @deepseek-ai/dsh package family to 0.1.0-rc.8'
}
robocopy (Join-Path $DshRuntimeSource 'node_modules') (Join-Path $runtime 'node_modules') /E | Out-Null
if ($LASTEXITCODE -ge 8) { throw "DSH runtime copy failed with robocopy exit code $LASTEXITCODE" }
Copy-Item -Force $dshLockPath (Join-Path $runtime 'dsh-package-lock.json')

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$startScript`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 12 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Output "Installed and started $TaskName"
Write-Output "Runtime: $runtime"
Write-Output "State: $(Join-Path $InstallRoot 'state')"
Write-Output "Logs: $(Join-Path $InstallRoot 'logs')"
