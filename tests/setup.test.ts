import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { hashPassword, verifyPassword } from "../src/lib/crypto";

const setupScript = resolve("scripts/setup.mjs");
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "atlas-setup-test-"));
  const fileDir = join(directory, "custom storage");
  const shellDir = join(directory, "shell storage");
  const oldHash = hashPassword("old-fixture-password");
  function database(path: string) {
    mkdirSync(path, { recursive: true });
    const db = new Database(join(path, "atlas.sqlite"));
    db.exec(
      "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE sessions(id TEXT PRIMARY KEY);",
    );
    db.prepare("INSERT INTO meta VALUES('adminHash', ?)").run(oldHash);
    db.exec("INSERT INTO sessions VALUES('old-session')");
    db.close();
  }
  database(fileDir);
  database(shellDir);
  const config =
    'RELAYDOCK_DATA_DIR="' +
    fileDir +
    '"\nRELAYDOCK_ADMIN_PASSWORD_HASH=' +
    oldHash +
    "\nNEXT_TELEMETRY_DISABLED=1\n";
  writeFileSync(join(directory, ".env.local"), config);
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.toUpperCase().startsWith("RELAYDOCK_")) delete env[key];
  return {
    directory,
    fileDir,
    shellDir,
    oldHash,
    config,
    run(overrides: Record<string, string> = {}) {
      return spawnSync(
        process.execPath,
        [setupScript, "--reset-password", "--generate"],
        {
          cwd: directory,
          env: { ...env, ...overrides },
          encoding: "utf8",
          timeout: 15000,
        },
      );
    },
    inspect(path: string) {
      const db = new Database(join(path, "atlas.sqlite"));
      try {
        return {
          hash: (
            db
              .prepare("SELECT value FROM meta WHERE key='adminHash'")
              .get() as { value: string }
          ).value,
          sessions: (
            db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {
              n: number;
            }
          ).n,
        };
      } finally {
        db.close();
      }
    },
    cleanup() {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
        throw new Error("Unsafe fixture cleanup");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("setup password reset", () => {
  it("uses the .env.local data directory and invalidates existing sessions", () => {
    const f = fixture();
    try {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      const password = result.stdout.match(/：([A-Za-z0-9_-]{24})/)?.[1];
      expect(password).toBeDefined();
      const state = f.inspect(f.fileDir);
      expect(verifyPassword(password!, state.hash)).toBe(true);
      expect(state.sessions).toBe(0);
      expect(readFileSync(join(f.directory, ".env.local"), "utf8")).toContain(
        state.hash,
      );
      expect(f.inspect(f.shellDir)).toEqual({ hash: f.oldHash, sessions: 1 });
    } finally {
      f.cleanup();
    }
  });
  it("keeps shell data-directory precedence over .env.local", () => {
    const f = fixture();
    try {
      const result = f.run({ RELAYDOCK_DATA_DIR: f.shellDir });
      expect(result.status, result.stderr).toBe(0);
      expect(f.inspect(f.shellDir).hash).not.toBe(f.oldHash);
      expect(f.inspect(f.shellDir).sessions).toBe(0);
      expect(f.inspect(f.fileDir)).toEqual({ hash: f.oldHash, sessions: 1 });
    } finally {
      f.cleanup();
    }
  });
  it("does not rewrite config or claim success when the intended database update fails", () => {
    const f = fixture();
    try {
      const db = new Database(join(f.fileDir, "atlas.sqlite"));
      db.exec("DROP TABLE sessions");
      db.close();
      const result = f.run({ RELAYDOCK_DATA_DIR: f.fileDir });
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(f.directory, ".env.local"), "utf8")).toBe(
        f.config,
      );
      expect(result.stdout).not.toContain("管理员密码哈希已写入");
      const check = new Database(join(f.fileDir, "atlas.sqlite"));
      try {
        expect(
          (
            check
              .prepare("SELECT value FROM meta WHERE key='adminHash'")
              .get() as { value: string }
          ).value,
        ).toBe(f.oldHash);
      } finally {
        check.close();
      }
    } finally {
      f.cleanup();
    }
  });
});
