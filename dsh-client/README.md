# DSH terminal client

The client is a Windows terminal UI for the remote DSH gateway. It uses local Windows files only for attachments, exports, configuration, logs, and cache data; workspace paths are absolute paths on the remote Linux host.

## Run from source

Node.js 22 or newer is required. Install the controlled NeoTUI fork and launch from PowerShell:

```powershell
npm ci --ignore-scripts
node .\vendor\dsh-neotui\bin\dsh-tui.js
```

The default gateway is `https://139.155.78.241:8710/dsh`. Login happens in the terminal. Access tokens remain in memory and are cleared on exit or any `401`/`403` response.

Useful options:

```text
--base <url>          HTTPS URL with the exact /dsh path
--workspace <path>    Absolute workspace path on the remote Linux host
--resume <session>    Resume a server session
--cache <directory>   Override the local cache directory
--check               Probe the gateway without logging in
--version             Print the bundled client version
--help                Show all options
```

`--script <file>` and `--plain` remain available for scripted terminal testing. The legacy PowerShell launcher is also supported:

```powershell
.\Start-DshTui.ps1 -Check
```

The preflight validates HTTPS and the exact `/dsh` path, then makes a certificate-validating `HEAD` request without redirects, credentials, login, or mutation calls. Authentication responses (`401`/`403`) count as a reachable gateway; redirects, TLS failures, timeouts, and server failures are reported as errors.

## Windows data paths

Configuration is stored under `%APPDATA%\DshTui`. Cache, logs, and other rebuildable state are stored under `%LOCALAPPDATA%\DshTui`. Set `DSH_HOME` to override both roots or use `--cache`/`DSH_TUI_CACHE_HOME` to override only the cache.

Logical session exports are JSON files written to the current local directory. They contain complete paginated events and verified attachment data. Selecting a server workspace never exposes or translates a local Windows directory.

## Portable Windows release

The release build must run on 64-bit Windows with Node.js `24.15.0` exactly:

```powershell
npm ci --ignore-scripts
npm run release:windows
```

The build bundles the client version into the executable, creates a Node SEA executable, applies the Windows application manifest and version resources, and writes an unsigned portable ZIP, release JSON, and SHA-256 checksum file under `release\`. The output is intentionally unsigned; Windows may display a publisher or SmartScreen warning until an external signing step is added.
