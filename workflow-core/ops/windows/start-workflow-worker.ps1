param(
    [string]$InstallRoot = "$env:ProgramData\WorkflowCore",
    [string]$WorkerId = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$runtime = Join-Path $InstallRoot 'runtime'
$state = Join-Path $InstallRoot 'state'
$logs = Join-Path $InstallRoot 'logs'
$secrets = Join-Path $InstallRoot 'secrets'
$tokenFile = Join-Path $secrets 'worker-token.dpapi'
$settingsFile = Join-Path $secrets 'worker-settings.json'
$entrypoint = Join-Path $runtime 'packages\worker\src\index.js'

if (-not (Test-Path $tokenFile)) { throw "Worker token is missing: $tokenFile. Run install-workflow-worker.ps1 with the token on standard input." }
if (-not (Test-Path $settingsFile)) { throw "Worker settings are missing: $settingsFile. Re-run install-workflow-worker.ps1 so it writes worker-settings.json." }
if (-not (Test-Path $entrypoint)) { throw "Worker entrypoint is missing: $entrypoint" }

$settings = Get-Content -Raw $settingsFile | ConvertFrom-Json

$encrypted = [Convert]::FromBase64String((Get-Content -Raw $tokenFile).Trim())
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
    $encrypted,
    $null,
    [Security.Cryptography.DataProtectionScope]::LocalMachine
)
$env:WFC_WORKER_TOKEN = [Text.Encoding]::UTF8.GetString($plain)
[Array]::Clear($plain, 0, $plain.Length)

$env:WFC_CORE_URL = $settings.coreUrl
$env:WFC_WORKER_ID = if ($WorkerId) { $WorkerId } else { $settings.workerId }
$env:WFC_WORKER_CAPABILITIES = $settings.capabilities -join ','
$env:WFC_WORKER_MAX_CONCURRENCY = [string]$settings.maxConcurrency
$env:WFC_WORKER_STATE_DIR = $state
$env:WFC_JSONL_COMMAND = $settings.jsonlCommand
$env:WFC_JSONL_ARGS = ($settings.jsonlArgs -join '|')
$env:WFC_ADMIN_PORT = [string]$settings.adminPort
if ($settings.ompUserProfile) { $env:WFC_OMP_USER_PROFILE = $settings.ompUserProfile }
if ($settings.ompProvider) { $env:WFC_OMP_PROVIDER = $settings.ompProvider }
if ($settings.ompModel) { $env:WFC_OMP_MODEL = $settings.ompModel }

New-Item -ItemType Directory -Force -Path $state, $logs | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $logs "worker-$stamp.log"
$stderr = Join-Path $logs "worker-$stamp.err.log"

try {
    $process = Start-Process -FilePath (Get-Command node.exe -ErrorAction Stop).Source -ArgumentList @($entrypoint) `
        -WorkingDirectory $runtime -WindowStyle Hidden -PassThru -Wait `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    exit $process.ExitCode
} finally {
    Remove-Item Env:WFC_WORKER_TOKEN -ErrorAction SilentlyContinue
}
