#!/usr/bin/env node
import { Term, detectKitty } from "../src/term.js";
import { Screen } from "../src/screen.js";
import { Api } from "../src/api.js";
import { App } from "../src/views.js";
import { promptLogin } from "../src/login.js";
import { CliUsageError, gatewayPreflight, helpText, parseCli } from "../src/cli.js";
import { readFileSync } from "node:fs";

const VERSION = typeof __DSH_CLIENT_VERSION__ === "string" ? __DSH_CLIENT_VERSION__ : "development";
const log = (...a) => console.error("[dsh-tui]", ...a);
let activeTerm = null;

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText(VERSION));
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  process.env.DSH_URL = options.base;
  process.env.DSH_TUI_WORKSPACE = options.workspace;
  if (options.cache) process.env.DSH_TUI_CACHE_HOME = options.cache;
  if (options.resume) process.env.DSH_TUI_RESUME_SESSION = options.resume;
  if (options.check) {
    const result = await gatewayPreflight(options.base);
    process.stdout.write(`${JSON.stringify({ ...result, workspace: options.workspace, cache: options.cache ?? "default", authenticationAttempted: false }, null, 2)}\n`);
    return;
  }
  if (options.script) {
    await runScripted(options.script, options.plain, options.base);
    return;
  }
  const screen = new Screen(process.stdout.columns || 80, process.stdout.rows || 24);
  const api = new Api({ base: options.base, log, onFrame: () => {}, onHostFrame: () => {} });
  let handler = () => {};
  const term = new Term({
    output: process.stdout,
    kitty: detectKitty(),
    onEvent: (ev) => handler(ev),
    onResize: (w, h) => { screen.resize(w, h); currentApp?.resize(w, h); },
  });
  let currentApp = null;
  activeTerm = term;
  screen.resize(term.w, term.h);
  term.start();

  const startAuthenticatedApp = async () => {
    await promptLogin({ api, screen, term, setEventHandler: (next) => { handler = next; } });
    const app = new App({ screen, term, api, log });
    currentApp = app;
    app.onAuthRequired = async () => {
      currentApp = null;
      api.closed = false;
      term.start();
      await startAuthenticatedApp();
    };
    api.onAuthRequired = () => { app.stop(false); app.onAuthRequired(); };
    handler = (ev) => app.onEvent(ev);
    app.resize(term.w, term.h);
    if (!await app.init()) return;
    app.redraw();
    app.run();
  };

  process.on("SIGINT", () => currentApp?.stop());
  process.on("SIGTERM", () => currentApp?.stop());
  await startAuthenticatedApp();
}

class FakeOutput {
  constructor() { this.chunks = []; this.columns = 100; this.rows = 30; }
  write(s) { this.chunks.push(s); return true; }
  toString() { return this.chunks.join(""); }
}

async function runScripted(scriptFile, plain, base) {
  const out = new FakeOutput();
  const screen = new Screen(100, 30);
  const api = new Api({ base, log, onFrame: () => {}, onHostFrame: () => {} });
  const app = new App({ screen, term: { output: out, write: (s) => out.write(s) }, api, log });
  const events = readFileSync(scriptFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (!api.auth.authenticated) throw new Error("scripted mode requires an authenticated Api test harness");
  await app.init();
  app.renderFrame();
  dump(app, plain);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let quit = false;
  for (const line of events) {
    if (quit) break;
    const [cmd, ...rest] = line.split(/\s+/);
    switch (cmd) {
      case "wait": await sleep(Number(rest[0] ?? 100)); break;
      case "quit": quit = true; break;
      case "key": {
        const [name, mods] = rest;
        const ev = { type: "key", name, ctrl: false, alt: false, shift: false, key: name, text: name };
        if (mods?.includes("c")) { ev.ctrl = true; ev.key = name; ev.text = name; }
        app.onEvent(ev);
        break;
      }
      case "text": app.onEvent({ type: "text", text: line.slice(5) }); break;
      case "space": app.onEvent({ type: "text", text: " " }); break;
      case "mouse": {
        const [kind, btn, x, y] = rest;
        app.onEvent({ type: "mouse", kind, button: Number(btn ?? 0), x: Number(x ?? 0), y: Number(y ?? 0), ctrl: false, shift: false, alt: false, motion: false });
        break;
      }
      case "resize": {
        const [w, h] = rest.map(Number);
        app.resize(w, h);
        break;
      }
      case "frame": app.injectFrame(JSON.parse(line.slice(6))); break;
      default: log(`unknown script cmd: ${cmd}`);
    }
    await sleep(30);
    app.renderFrame();
    dump(app, plain);
  }
  api.close();
  await sleep(100);
  process.exit(0);
}

function dump(app, plain) {
  const screen = app.screen;
  const out = app.term.output;
  if (plain) {
    console.log("───── frame ─────");
    console.log(screen.toPlain());
  } else {
    console.log("───── frame ─────");
    console.log(out.toString().replace(/\x1b/g, "<ESC>"));
  }
  out.chunks.length = 0;
}

main().catch((error) => {
  if (error instanceof CliUsageError) {
    console.error(`dsh-client: ${error.message}\nRun dsh-client --help for usage.`);
  } else {
    log("fatal:", error?.message ?? error);
  }
  try { activeTerm?.stop(); } catch {}
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
});
