import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BASE, CliUsageError, gatewayPreflight, parseCli, validateBase } from "../vendor/dsh-neotui/src/cli.js";

test("strict CLI parser accepts the supported Windows launcher options", () => {
  assert.deepEqual(parseCli([
    "--base", "https://example.com:8710/dsh",
    "--workspace", "/srv/work tree",
    "--resume", "session-1",
    "--cache", "C:/cache path",
    "--check",
  ], {}), {
    base: "https://example.com:8710/dsh",
    workspace: "/srv/work tree",
    resume: "session-1",
    cache: "C:/cache path",
    script: null,
    check: true,
    version: false,
    help: false,
    plain: false,
  });
});

test("script and plain flags remain supported", () => {
  const parsed = parseCli(["--script", "smoke.script", "--plain"], {});
  assert.equal(parsed.script, "smoke.script");
  assert.equal(parsed.plain, true);
  assert.equal(parsed.base, DEFAULT_BASE);
});

test("CLI parser rejects unknown, duplicate, missing, and contradictory options", () => {
  assert.throws(() => parseCli(["--wat"], {}), CliUsageError);
  assert.throws(() => parseCli(["--base"], {}), /requires a value/);
  assert.throws(() => parseCli(["--check", "--check"], {}), /only be specified once/);
  assert.throws(() => parseCli(["--plain"], {}), /requires --script/);
  assert.throws(() => parseCli(["--attach", "https:\/\/example.com\/dsh"], {}), /no longer supported/);
  assert.throws(() => parseCli(["--workspace", "C:/local"], {}), /remote Linux host/);
});

test("gateway base requires HTTPS and the exact /dsh path", () => {
  assert.equal(validateBase("https://example.com/dsh"), "https://example.com/dsh");
  for (const value of [
    "http://example.com/dsh",
    "https://example.com/dsh/",
    "https://example.com/Dsh",
    "https://example.com/dsh?x=1",
    "https://user@example.com/dsh",
    "https://example.com/other",
  ]) assert.throws(() => validateBase(value), /exact \/dsh path/);
});

test("gateway preflight reports auth challenges as reachable without authenticating", async () => {
  let init;
  const result = await gatewayPreflight("https://example.com/dsh", {
    fetchImpl: async (_url, value) => {
      init = value;
      return { status: 401, headers: new Headers() };
    },
  });
  assert.equal(init.method, "HEAD");
  assert.equal(init.redirect, "manual");
  assert.equal(result.reachable, true);
  assert.equal(result.authenticationRequired, true);
});

test("gateway preflight rejects redirects and gateway failures with useful errors", async () => {
  await assert.rejects(gatewayPreflight("https://example.com/dsh", {
    fetchImpl: async () => ({ status: 302, headers: new Headers({ location: "https://other.example/dsh" }) }),
  }), /refused redirect HTTP 302/);
  await assert.rejects(gatewayPreflight("https://example.com/dsh", {
    fetchImpl: async () => { throw new Error("certificate verify failed"); },
  }), /certificate verify failed/);
});
