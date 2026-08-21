export const DEFAULT_BASE = "https://139.155.78.241:8710/dsh";
export const DEFAULT_WORKSPACE = "/home/ubuntu/workspaces/default";

const VALUE_OPTIONS = new Map([
  ["--base", "base"],
  ["--workspace", "workspace"],
  ["--resume", "resume"],
  ["--cache", "cache"],
  ["--script", "script"],
]);
const FLAG_OPTIONS = new Map([
  ["--check", "check"],
  ["--version", "version"],
  ["-v", "version"],
  ["--help", "help"],
  ["-h", "help"],
  ["--plain", "plain"],
]);

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function validateBase(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new CliUsageError(`--base must be an absolute HTTPS URL with the exact /dsh path: ${value}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/dsh" || url.search || url.hash) {
    throw new CliUsageError(`--base must be an absolute HTTPS URL with the exact /dsh path and no credentials, query, or fragment: ${value}`);
  }
  return url.href;
}

export function validateWorkspace(value) {
  if (!value.startsWith("/") || value.includes("\0")) {
    throw new CliUsageError(`--workspace must be an absolute path on the remote Linux host: ${value}`);
  }
  return value;
}

export function parseCli(argv, env = process.env) {
  const options = {
    base: env.DSH_URL || env.DSH_WEB_URL || DEFAULT_BASE,
    workspace: env.DSH_TUI_WORKSPACE || DEFAULT_WORKSPACE,
    resume: env.DSH_TUI_RESUME_SESSION || null,
    cache: env.DSH_TUI_CACHE_HOME || null,
    script: null,
    check: false,
    version: false,
    help: false,
    plain: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (VALUE_OPTIONS.has(token)) {
      const key = VALUE_OPTIONS.get(token);
      if (seen.has(key)) throw new CliUsageError(`${token} may only be specified once`);
      const value = argv[++index];
      if (value === undefined || value === "" || value.startsWith("-")) throw new CliUsageError(`${token} requires a value`);
      options[key] = value;
      seen.add(key);
      continue;
    }
    if (FLAG_OPTIONS.has(token)) {
      const key = FLAG_OPTIONS.get(token);
      if (seen.has(key)) throw new CliUsageError(`${token} may only be specified once`);
      options[key] = true;
      seen.add(key);
      continue;
    }
    if (token === "--attach") throw new CliUsageError("--attach is no longer supported; use --base");
    throw new CliUsageError(`unknown option: ${token}`);
  }
  options.base = validateBase(options.base);
  options.workspace = validateWorkspace(options.workspace);
  if (options.plain && !options.script) throw new CliUsageError("--plain requires --script");
  return options;
}

export async function gatewayPreflight(base, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const url = validateBase(base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    const detail = error?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error?.message ?? String(error);
    throw new Error(`gateway preflight could not reach ${url}: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`gateway preflight refused redirect HTTP ${response.status} to ${response.headers?.get?.("location") ?? "an unknown location"}`);
  }
  if (response.status >= 500) throw new Error(`gateway preflight failed: gateway returned HTTP ${response.status}`);
  return {
    ok: true,
    base: url,
    status: response.status,
    reachable: true,
    authenticationRequired: response.status === 401 || response.status === 403,
  };
}

export function helpText(version) {
  return `DSH terminal client ${version}\n\nUsage: dsh-client [options]\n\nOptions:\n  --base <url>          HTTPS gateway URL with the exact /dsh path\n  --workspace <path>    Absolute workspace path on the remote Linux host\n  --resume <session-id> Resume a server session\n  --cache <directory>   Override the local cache directory\n  --check               Validate configuration and probe the gateway without login\n  --version, -v         Print the client version\n  --help, -h            Show this help\n  --script <file>       Run the existing scripted test mode\n  --plain               Print plain frames in scripted mode\n`;
}
