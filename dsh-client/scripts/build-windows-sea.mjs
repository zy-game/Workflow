import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import esbuild from "esbuild";
import { inject } from "postject";
import { rcedit } from "rcedit";
import yazl from "yazl";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const buildDir = join(root, "build");
const releaseDir = join(root, "release");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const nodeVersion = process.versions.node;
const arch = process.arch;
const platform = process.platform;
const product = `dsh-client-${version}-windows-${arch}`;
const exeName = "dsh-client.exe";
const exePath = join(buildDir, exeName);
const bundlePath = join(buildDir, "sea-bundle.cjs");
const blobPath = join(buildDir, "sea-prep.blob");
const zipPath = join(releaseDir, `${product}.zip`);
const manifestPath = join(releaseDir, `${product}.json`);
const checksumPath = join(releaseDir, `${product}.sha256`);

if (platform !== "win32") throw new Error(`Windows SEA release must run on Windows, found ${platform}`);
if (nodeVersion !== "24.15.0") throw new Error(`Windows SEA release requires Node.js 24.15.0 exactly, found ${nodeVersion}`);
if (arch !== "x64" && arch !== "arm64") throw new Error(`unsupported Windows architecture: ${arch}`);

await rm(buildDir, { recursive: true, force: true });
await rm(releaseDir, { recursive: true, force: true });
await mkdir(buildDir, { recursive: true });
await mkdir(releaseDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "vendor", "dsh-neotui", "bin", "dsh-tui.js")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  define: { __DSH_CLIENT_VERSION__: JSON.stringify(version) },
  legalComments: "none",
  logLevel: "info",
});

await execFileAsync(process.execPath, ["--experimental-sea-config", join(root, "sea-config.json")], { cwd: root });
await copyFile(process.execPath, exePath);

await rcedit(exePath, {
  "application-manifest": join(root, "windows.manifest"),
  "file-version": version,
  "product-version": version,
  "version-string": {
    CompanyName: "DSH",
    FileDescription: "DSH terminal client",
    InternalName: "dsh-client",
    OriginalFilename: exeName,
    ProductName: "DSH terminal client",
  },
});

await inject(exePath, "NODE_SEA_BLOB", await readFile(blobPath), { sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2" });

const smokeVersion = (await execFileAsync(exePath, ["--version"], { cwd: root, timeout: 15000 })).stdout.trim();
if (smokeVersion !== version) throw new Error(`SEA version smoke check returned ${JSON.stringify(smokeVersion)}, expected ${version}`);
const smokeHelp = (await execFileAsync(exePath, ["--help"], { cwd: root, timeout: 15000 })).stdout;
if (!smokeHelp.includes("Usage: dsh-client [options]")) throw new Error("SEA help smoke check did not return the client usage text");

const exeHash = await sha256(exePath);
await makeZip(zipPath, [
  { path: exePath, name: exeName },
  { path: join(root, "README.md"), name: "README.md" },
]);
const zipHash = await sha256(zipPath);
const exeStats = await stat(exePath);
const zipStats = await stat(zipPath);
const releaseManifest = {
  schemaVersion: 1,
  name: packageJson.name,
  version,
  platform: "win32",
  arch,
  node: nodeVersion,
  unsigned: true,
  executable: { file: exeName, bytes: exeStats.size, sha256: exeHash },
  archive: { file: basename(zipPath), bytes: zipStats.size, sha256: zipHash },
  tools: { esbuild: "0.28.2", postject: "1.0.0-alpha.6", rcedit: "5.0.2", yazl: "3.3.1" },
};
await writeFile(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`);
await writeFile(checksumPath, `${zipHash}  ${basename(zipPath)}\n${exeHash}  ${exeName}\n`);
process.stdout.write(`${JSON.stringify({ exePath, zipPath, manifestPath, checksumPath, unsigned: true }, null, 2)}\n`);

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function makeZip(output, entries) {
  const zip = new yazl.ZipFile();
  for (const entry of entries) zip.addFile(entry.path, entry.name, { mtime: new Date("2026-01-01T00:00:00.000Z"), mode: 0o100755 });
  zip.end();
  await new Promise((resolvePromise, reject) => {
    const outputStream = createWriteStream(output);
    zip.outputStream.on("error", reject);
    outputStream.on("error", reject);
    outputStream.on("close", resolvePromise);
    zip.outputStream.pipe(outputStream);
  });
}
