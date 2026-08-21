import { Term, detectKitty } from "./term.js";
import { Screen } from "./screen.js";
import { Api } from "./api.js";
import { App } from "./views.js";
import { promptLogin } from "./login.js";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./platform.js";

export function launchTui(opts = {}) {
  const log = opts.log ?? ((...a) => console.error("[dsh-tui]", ...a));
  if (typeof process.stdin.isTTY === "function" && !process.stdin.isTTY && process.env.DSH_TUI_NO_TTY !== "1") {
    console.error("dsh-tui: stdin is not a terminal; run inside a real terminal");
    process.exit(1);
  }
  const screen = new Screen(process.stdout.columns || 80, process.stdout.rows || 24);
  const api = new Api({ base: opts.base, log, onFrame: () => {}, onHostFrame: () => {} });
  let handler = () => {};
  let app = null;
  const term = new Term({
    output: process.stdout,
    kitty: detectKitty(),
    onEvent: (event) => handler(event),
    onResize: (w, h) => { screen.resize(w, h); app?.resize(w, h); },
  });
  screen.resize(term.w, term.h);
  term.start();
  const crashLog = (kind, value) => {
    try {
      const root = stateRoot();
      mkdirSync(root, { recursive: true });
      appendFileSync(join(root, "tui-error.log"), `${new Date().toISOString()} ${kind}\n${value?.stack ?? value}\n`);
    } catch {}
  };
  process.on("unhandledRejection", (reason) => crashLog("unhandledRejection", reason));
  process.on("uncaughtExceptionMonitor", (error) => crashLog("uncaughtException", error));

  const start = async () => {
    if (opts.getBase) api.base = await opts.getBase();
    await promptLogin({ api, screen, term, setEventHandler: (next) => { handler = next; } });
    app = new App({ screen, term, api, log });
    const current = app;
    current.onAuthRequired = async () => {
      app = null;
      api.closed = false;
      term.start();
      await start();
    };
    api.onAuthRequired = () => { current.stop(false); current.onAuthRequired(); };
    handler = (event) => current.onEvent(event);
    current.resize(term.w, term.h);
    if (!await current.init()) return;
    if (opts.resume) await current.openSession(opts.resume);
    app.redraw();
    app.run();
  };
  start().catch((error) => {
    log("fatal:", error);
    try { console.error("[dsh-tui] fatal:", error?.message ?? error); } catch {}
    term.stop();
    process.exit(1);
  });
  process.on("SIGINT", () => app?.stop());
  process.on("SIGTERM", () => app?.stop());
  return () => app?.stop();
}

export { Term, Screen, Api, App, detectKitty };
