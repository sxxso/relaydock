import { expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanRuntimeEnv,
  copyIsolatedBuild,
} from "../scripts/isolated-runtime";
it("copies only production assets to a runtime without environment files or databases", () => {
  const temp = mkdtempSync(join(tmpdir(), "atlas-runtime-fixture-")),
    root = join(temp, "source"),
    runtime = join(temp, "runtime");
  try {
    mkdirSync(join(root, ".next", "server"), { recursive: true });
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, ".env.local"), "PRIVATE_SENTINEL=do-not-read");
    writeFileSync(join(root, ".next", "BUILD_ID"), "fixture-build");
    writeFileSync(
      join(root, ".next", "server", "page.js"),
      "production fixture",
    );
    writeFileSync(
      join(root, ".next", "server", ".env.local"),
      "PRIVATE_SENTINEL=do-not-copy",
    );
    writeFileSync(join(root, ".next", "server", "test.sqlite"), "do-not-copy");
    copyIsolatedBuild(root, runtime);
    expect(existsSync(join(runtime, ".next", "BUILD_ID"))).toBe(true);
    expect(existsSync(join(runtime, ".env.local"))).toBe(false);
    expect(existsSync(join(runtime, ".next", "server", ".env.local"))).toBe(
      false,
    );
    expect(existsSync(join(runtime, ".next", "server", "test.sqlite"))).toBe(
      false,
    );
  } finally {
    if (existsSync(join(runtime, "node_modules")))
      unlinkSync(join(runtime, "node_modules"));
    rmSync(temp, { recursive: true, force: true });
  }
});
it("whitelists process essentials, excluding secret overrides, proxies and NODE_OPTIONS", () => {
  const env = cleanRuntimeEnv({
    NODE_ENV: "development",
    Path: "fixture-path",
    TEMP: "fixture-temp",
    RELAYDOCK_DATA_DIR: "private-db",
    RELAYDOCK_VAULT_KEY: "secret",
    HTTPS_PROXY: "private-proxy",
    RELAYDOCK_QUERY_PROXY_URL: "http://private:secret@proxy.invalid:1",
    NODE_OPTIONS: "--import secret-hook",
  });
  expect(env).toEqual({
    NODE_ENV: "production",
    Path: "fixture-path",
    TEMP: "fixture-temp",
  });
});
