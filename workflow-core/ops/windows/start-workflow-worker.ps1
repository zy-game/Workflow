param(
    [string]$InstallRoot = "$env:ProgramData\WorkflowCore",
    [string]$WorkerId = "windows-$env:COMPUTERNAME"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$runtime = Join-Path $InstallRoot 'runtime'
$state = Join-Path $InstallRoot 'state'
$dshHome = Join-Path $InstallRoot 'dsh-home'
$logs = Join-Path $InstallRoot 'logs'
$tokenFile = Join-Path $InstallRoot 'secrets\worker-token.dpapi'
$entrypoint = Join-Path $runtime 'packages\worker\src\index.js'
$dshEntrypoint = Join-Path $runtime 'node_modules\@deepseek-ai\dsh\lib\bin.js'

if (-not (Test-Path $tokenFile)) { throw "Worker token is missing: $tokenFile" }
if (-not (Test-Path $entrypoint)) { throw "Worker entrypoint is missing: $entrypoint" }
if (-not (Test-Path $dshEntrypoint)) { throw "DSH entrypoint is missing: $dshEntrypoint" }

$encrypted = [Convert]::FromBase64String((Get-Content -Raw $tokenFile).Trim())
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
    $encrypted,
    $null,
    [Security.Cryptography.DataProtectionScope]::LocalMachine
)
$env:WFC_WORKER_TOKEN = [Text.Encoding]::UTF8.GetString($plain)
[Array]::Clear($plain, 0, $plain.Length)

$env:WFC_CORE_URL = 'https://139.155.78.241:8710'
$env:WFC_WORKER_ID = $WorkerId
$env:WFC_WORKER_CAPABILITIES = 'dsh,windows,powershell'
$env:WFC_WORKER_MAX_CONCURRENCY = '1'
$env:WFC_WORKER_STATE_DIR = $state
$env:WFC_WORKER_WORKSPACE = 'E:\Workflow'
$env:WFC_DSH_NODE = (Get-Command node.exe -ErrorAction Stop).Source
$env:WFC_DSH_BIN = $dshEntrypoint
$env:WFC_DSH_HOME = $dshHome

New-Item -ItemType Directory -Force -Path $state, $dshHome, $logs | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $logs "worker-$stamp.log"
$stderr = Join-Path $logs "worker-$stamp.err.log"

try {
    $process = Start-Process -FilePath $env:WFC_DSH_NODE -ArgumentList @($entrypoint) `
        -WorkingDirectory $runtime -NoNewWindow -PassThru -Wait `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    exit $process.ExitCode
} finally {
    Remove-Item Env:WFC_WORKER_TOKEN -ErrorAction SilentlyContinue
}
