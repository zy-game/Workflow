param(
    [string]$SourceRoot,
    [string]$JsonlCommand,
    [string]$JsonlArgs = '',
    [string]$InstallRoot = "$env:ProgramData\WorkflowCore",
    [string]$CoreUrl = 'http://127.0.0.1:18710',
    [string]$WorkerId = "windows-$env:COMPUTERNAME",
    [string]$Capabilities = 'workflow-jsonl,windows,powershell',
    [int]$MaxConcurrency = 1,
    [int]$AdminPort = 0,
    [string]$TaskName = 'Workflow Core Worker',
    [string]$EnrollCode = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
# Enrollment code ("设备授权" on the Core console) trades for a worker token;
# otherwise the one-time worker token is read from standard input.
if (-not [string]::IsNullOrWhiteSpace($EnrollCode)) {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    $enroll = Invoke-RestMethod -Method POST -Uri ($CoreUrl.TrimEnd('/') + '/api/v1/enrollments/consume') -ContentType 'application/json' `
        -Body (@{ code = $EnrollCode.Trim(); worker_id = if ($WorkerId) { $WorkerId } else { 'windows-' + $env:COMPUTERNAME }; machine = $env:COMPUTERNAME } | ConvertTo-Json)
    $workerToken = [string]$enroll.token
    if ([string]::IsNullOrWhiteSpace($workerToken)) {
        throw 'Enrollment code was consumed but no token was returned. Check that the code is still pending.'
    }
} else {
    $workerToken = [Console]::In.ReadToEnd().Trim()
    if ([string]::IsNullOrWhiteSpace($workerToken)) {
        throw 'Worker token is required. Pass -EnrollCode from the Core console "设备授权" page, or pipe a token on standard input.'
    }
}
$runtime = Join-Path $InstallRoot 'runtime'
$secrets = Join-Path $InstallRoot 'secrets'
$startScript = Join-Path $runtime 'ops\windows\start-workflow-worker.ps1'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$jsonlCommand = if ([string]::IsNullOrWhiteSpace($JsonlCommand)) { $null } else { $JsonlCommand.Trim() }

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

$args = ($JsonlArgs -split '\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$capabilities = ($Capabilities -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$settings = @{
    coreUrl = $CoreUrl
    workerId = $WorkerId
    capabilities = $capabilities
    maxConcurrency = $MaxConcurrency
    jsonlCommand = $jsonlCommand
    jsonlArgs = $args
    adminPort = $AdminPort
    ompUserProfile = $env:USERPROFILE
    version = '0.2.0'
}
$settings | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $secrets 'worker-settings.json')
if ($LASTEXITCODE -ne 0) { throw 'Failed to write worker settings' }

robocopy $SourceRoot $runtime /MIR /XD node_modules .git /XF '*.log' | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Runtime copy failed with robocopy exit code $LASTEXITCODE" }

& npm.cmd ci --prefix $runtime --registry=https://registry.npmjs.org/ --fetch-retries=1 --fetch-timeout=60000 --no-audit --no-fund --omit=dev
if ($LASTEXITCODE -ne 0) { throw "Workflow runtime dependency install failed" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
# Runs as the installing user at logon: bun-based execution engines crash in
# the SYSTEM service context, and user-level tooling (OMP profile, codex auth)
# must be reachable.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$taskSettings = New-ScheduledTaskSettingsSet -RestartCount 12 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $taskSettings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Output "Installed and started $TaskName"
Write-Output "Runtime: $runtime"
Write-Output "State: $(Join-Path $InstallRoot 'state')"
Write-Output "Logs: $(Join-Path $InstallRoot 'logs')"
Write-Output "Core URL: $CoreUrl"
Write-Output "Admin UI: http://127.0.0.1:$AdminPort (port 0 = random; see $(Join-Path $InstallRoot 'state\admin.token'))"
if ($null -eq $jsonlCommand) {
    Write-Output "Execution engine: NOT configured. After startup, open the Admin UI and add the JSONL backend command on the Backends page (or set config.json backends[]), then restart the task."
} else {
    Write-Output "Execution engine: $jsonlCommand $($args -join ' ')"
}
