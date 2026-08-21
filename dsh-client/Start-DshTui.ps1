[CmdletBinding()]
param(
    [string]$BaseUrl = "https://139.155.78.241:8710/dsh",
    [string]$Workspace = "/home/ubuntu/workspaces/default",
    [string]$ResumeSession,
    [string]$CacheRoot,
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$tui = Join-Path $root "node_modules\dsh-neotui\bin\dsh-tui.js"
$expectedFork = Join-Path $root "vendor\dsh-neotui"
$expectedVersion = "0.3.0-dsh.1"
$oldResume = $env:DSH_TUI_RESUME_SESSION
$oldWorkspace = $env:DSH_TUI_WORKSPACE
$oldCacheHome = $env:DSH_TUI_CACHE_HOME
$oldUrl = $env:DSH_URL

function Test-LauncherSyntax {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $MyInvocation.ScriptName,
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null
    if ($errors.Count -gt 0) {
        throw "Launcher syntax check failed: $($errors[0].Message)"
    }
}

function Test-ControlledFork {
    param([Parameter(Mandatory = $true)][string]$NodePath)

    $probe = @'
const path = require('node:path');
const root = process.argv[1];
const expectedRoot = process.argv[2];
const expectedVersion = process.argv[3];
const resolved = require.resolve('dsh-neotui/package.json', { paths: [root] });
const pkg = require(resolved);
const normalizedResolved = path.resolve(resolved).toLowerCase();
const normalizedRoot = path.resolve(expectedRoot).toLowerCase() + path.sep;
if (pkg.version !== expectedVersion) throw new Error(`version ${pkg.version}, expected ${expectedVersion}`);
if (!normalizedResolved.startsWith(normalizedRoot)) throw new Error(`resolved outside controlled fork: ${resolved}`);
process.stdout.write(JSON.stringify({ version: pkg.version, resolved }));
'@
    $result = & $NodePath -e $probe $root $expectedFork $expectedVersion
    if ($LASTEXITCODE -ne 0) {
        throw "Controlled NeoTUI fork check failed"
    }
    return $result | ConvertFrom-Json
}

function Get-ValidatedBaseUri {
    try {
        $uri = [Uri]$BaseUrl
    } catch {
        throw "BaseUrl is not a valid absolute URI: $BaseUrl"
    }
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne "https") {
        throw "BaseUrl must use HTTPS: $BaseUrl"
    }
    if ($uri.AbsolutePath.TrimEnd("/") -ne "/dsh" -or $uri.Query -or $uri.Fragment) {
        throw "BaseUrl must have the exact /dsh path and no query or fragment: $BaseUrl"
    }
    return $uri
}

function Test-TlsEndpoint {
    param([Parameter(Mandatory = $true)][Uri]$Uri)

    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head, $Uri)
    $client.Timeout = [TimeSpan]::FromSeconds(10)
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        if ($status -ge 300 -and $status -lt 400) {
            throw "Gateway preflight refused HTTP redirect $status to $($response.Headers.Location)"
        }
        if ($status -ge 500) {
            throw "Gateway preflight failed: server returned HTTP $status"
        }
        return $status
    } catch {
        throw "TLS preflight failed for $Uri. Certificate trust, SAN, or reachability is invalid: $($_.Exception.Message)"
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $request.Dispose()
        $client.Dispose()
        $handler.Dispose()
    }
}

try {
    Test-LauncherSyntax
    if (-not (Test-Path -LiteralPath $tui -PathType Leaf)) {
        throw "NeoTUI is not installed. Run: npm ci --ignore-scripts"
    }
    if (-not $Workspace.StartsWith("/")) {
        throw "Workspace must be an absolute path on the Linux server: $Workspace"
    }

    $node = Get-Command node.exe -ErrorAction Stop
    $nodeMajor = [int]((& $node.Source --version).TrimStart("v").Split(".")[0])
    if ($nodeMajor -lt 22) {
        throw "NeoTUI requires Node.js 22 or newer; found Node.js $nodeMajor"
    }
    $fork = Test-ControlledFork -NodePath $node.Source
    $baseUri = Get-ValidatedBaseUri

    if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            throw "LOCALAPPDATA is unavailable; provide -CacheRoot explicitly"
        }
        $CacheRoot = Join-Path $env:LOCALAPPDATA "DshTui"
    }
    $CacheRoot = [IO.Path]::GetFullPath($CacheRoot)

    if ($Check) {
        $status = Test-TlsEndpoint -Uri $baseUri
        [pscustomobject]@{
            Ok = $true
            Node = (& $node.Source --version)
            NeoTuiVersion = $fork.version
            NeoTuiPath = $fork.resolved
            BaseUrl = $baseUri.AbsoluteUri.TrimEnd("/")
            TlsHeadStatus = $status
            CacheDb = Join-Path $CacheRoot "cache.db"
            AuthenticationAttempted = $false
        } | Format-List
        return
    }

    $env:DSH_URL = $baseUri.AbsoluteUri.TrimEnd("/")
    $env:DSH_TUI_WORKSPACE = $Workspace
    $env:DSH_TUI_CACHE_HOME = $CacheRoot
    if ([string]::IsNullOrWhiteSpace($ResumeSession)) {
        Remove-Item Env:DSH_TUI_RESUME_SESSION -ErrorAction SilentlyContinue
    } else {
        $env:DSH_TUI_RESUME_SESSION = $ResumeSession
    }

    $tuiArgs = @("--base", $env:DSH_URL, "--workspace", $Workspace, "--cache", $CacheRoot)
    if (-not [string]::IsNullOrWhiteSpace($ResumeSession)) {
        $tuiArgs += @("--resume", $ResumeSession)
    }
    & $node.Source $tui @tuiArgs
    if ($LASTEXITCODE -ne 0) {
        throw "NeoTUI exited with code $LASTEXITCODE"
    }
} finally {
    $env:DSH_TUI_RESUME_SESSION = $oldResume
    $env:DSH_TUI_WORKSPACE = $oldWorkspace
    $env:DSH_TUI_CACHE_HOME = $oldCacheHome
    $env:DSH_URL = $oldUrl
}
