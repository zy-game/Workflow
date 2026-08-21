import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { configRoot, editorCommand, openExternal, restartProcess, stateRoot } from "../vendor/dsh-neotui/src/platform.js";

test("Windows config and state use stable roaming and local application data roots", () => {
  const env = { APPDATA: "C:/Users/test/AppData/Roaming", LOCALAPPDATA: "C:/Users/test/AppData/Local" };
  assert.equal(configRoot(env, "win32"), join(env.APPDATA, "DshTui"));
  assert.equal(stateRoot(env, "win32"), join(env.LOCALAPPDATA, "DshTui"));
  assert.throws(() => configRoot({}, "win32"), /APPDATA/);
  assert.throws(() => stateRoot({}, "win32"), /LOCALAPPDATA/);
});

test("Windows shell helpers use native executable invocation without cmd quoting", () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() { calls.at(-1).unref = true; } };
  };
  openExternal("C:/file with spaces.txt", { platform: "win32", run });
  restartProcess(["--resume", "s1"], { X: "1" }, { platform: "win32", execPath: "C:/dsh-client.exe", run });
  assert.equal(calls[0].command, "explorer.exe");
  assert.deepEqual(calls[0].args, ["C:/file with spaces.txt"]);
  assert.equal(calls[1].command, "C:/dsh-client.exe");
  assert.deepEqual(calls[1].args, ["--resume", "s1"]);
  assert.equal(calls[1].options.detached, true);
});

test("editor command has a Windows fallback and handles quoted executable paths", () => {
  assert.deepEqual(editorCommand("", "win32"), { command: "notepad.exe", args: [] });
  assert.deepEqual(editorCommand('"C:/Program Files/Editor/editor.exe" --wait', "win32"), {
    command: "C:/Program Files/Editor/editor.exe",
    args: ["--wait"],
  });
});
