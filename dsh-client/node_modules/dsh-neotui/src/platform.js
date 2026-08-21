import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

export function configRoot(env = process.env, platform = process.platform) {
  if (env.DSH_HOME) return env.DSH_HOME;
  if (platform === "win32") {
    if (!env.APPDATA) throw new Error("APPDATA is required for DSH TUI configuration");
    return join(env.APPDATA, "DshTui");
  }
  return env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "dsh-tui") : join(env.HOME ?? ".", ".config", "dsh-tui");
}

export function stateRoot(env = process.env, platform = process.platform) {
  if (env.DSH_HOME) return env.DSH_HOME;
  if (platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required for DSH TUI state");
    return join(env.LOCALAPPDATA, "DshTui");
  }
  return env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "dsh-tui") : join(env.HOME ?? ".", ".local", "state", "dsh-tui");
}

export function openExternal(path, { platform = process.platform, run = spawn } = {}) {
  const command = platform === "win32" ? "explorer.exe" : platform === "darwin" ? "open" : "xdg-open";
  const child = run(command, [path], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref?.();
  return child;
}

export function restartProcess(argv, env, { platform = process.platform, execPath = process.execPath, run = spawn } = {}) {
  const command = platform === "win32" ? execPath : "sh";
  const args = platform === "win32" ? argv : ["-c", 'sleep 1; exec "$@"', "sh", ...argv];
  const child = run(command, args, { detached: true, stdio: "inherit", env, windowsHide: false });
  child.unref?.();
  return child;
}

export function editorCommand(editor, platform = process.platform) {
  const configured = String(editor ?? "").trim();
  if (configured) {
    const match = configured.match(/^(?:"([^"]+)"|(\S+))(?:\s+(.*))?$/);
    if (!match) throw new Error(`invalid editor command: ${configured}`);
    return { command: match[1] || match[2], args: match[3]?.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [] };
  }
  return platform === "win32" ? { command: "notepad.exe", args: [] } : { command: "vi", args: [] };
}

export function runEditor(file, editor, { platform = process.platform, run = spawnSync } = {}) {
  const { command, args } = editorCommand(editor, platform);
  const result = run(command, [...args, file], { stdio: "inherit", windowsHide: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

export function copyImageFromClipboard({ platform = process.platform, runSync = spawnSync } = {}) {
  if (platform === "win32") {
    const file = join(tmpdir(), `dsh-tui-paste-${process.pid}-${Date.now()}.png`);
    const escaped = file.replace(/'/g, "''");
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }; $image=[System.Windows.Forms.Clipboard]::GetImage(); try { $image.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }`;
    const result = runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { stdio: "ignore", windowsHide: true });
    if (result.status === 3) return null;
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`PowerShell clipboard helper exited with code ${result.status}`);
    try { return readFileSync(file); } finally { try { unlinkSync(file); } catch {} }
  }
  if (platform === "darwin") return null;
  const types = runSync("wl-paste", ["--list-types"], { encoding: "utf8" });
  if (types.status !== 0) return null;
  const mediaType = String(types.stdout ?? "").split(/\r?\n/).find((type) => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type));
  if (!mediaType) return null;
  const image = runSync("wl-paste", ["--no-newline", "--type", mediaType], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
  return image.status === 0 && image.stdout?.length ? image.stdout : null;
}

export function detectImageType(data, advertised = "image/png") {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data.slice(0, 4).toString() === "RIFF" && data.slice(8, 12).toString() === "WEBP") return "image/webp";
  if (data.slice(0, 3).toString() === "GIF") return "image/gif";
  return advertised;
}

export function copyImageToClipboard(data, mediaType, { platform = process.platform, run = spawn, runSync = spawnSync } = {}) {
  if (platform === "win32") {
    if (mediaType !== "image/png") throw new Error("Windows image clipboard currently requires PNG data");
    const file = join(tmpdir(), `dsh-tui-clipboard-${process.pid}-${Date.now()}.png`);
    writeFileSync(file, data);
    const escaped = file.replace(/'/g, "''");
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image=[System.Drawing.Image]::FromFile('${escaped}'); try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }`;
    const result = runSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { stdio: "ignore", windowsHide: true });
    try { unlinkSync(file); } catch {}
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`PowerShell clipboard helper exited with code ${result.status}`);
    return;
  }
  if (platform === "darwin") throw new Error("image clipboard is not supported on macOS by this client");
  const child = run("wl-copy", ["--type", mediaType], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.on?.("error", () => {});
  child.stdin.end(data);
}

export function ensureParent(file) {
  mkdirSync(dirname(file), { recursive: true });
  return file;
}
