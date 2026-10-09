import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { encryptSecret } from "../src/lib/crypto";

const script = resolve("scripts/doctor.mjs");
const owned: string[] = [];
const hash = `scrypt:cli-fixture-salt:${"cd".repeat(64)}`;
const guardSource = `import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const deny = () => { process.stderr.write('FORBIDDEN_SIDE_EFFECT'); throw new Error('Blocked by offline fixture'); };
for (const [name, functions] of Object.entries({http:['get','request'],https:['get','request'],dns:['lookup','resolve','resolve4','resolve6','resolveAny'],net:['connect','createConnection'],tls:['connect'],dgram:['createSocket'],child_process:['exec','execFile','spawn','fork','execSync','execFileSync','spawnSync']})) {
  const module = require('node:' + name); for (const fn of functions) module[fn] = deny;
  if (name === 'dns') for (const fn of ['lookup','resolve','resolve4','resolve6','resolveAny']) module.promises[fn] = deny;
  if (name === 'net') module.Socket.prototype.connect = deny;
}
globalThis.fetch = deny; syncBuiltinESMExports();`;
function fixture({ healthy = true, dataName = "data" } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "atlas-doctor-cli-")); owned.push(cwd);
  const data = join(cwd, dataName), guard = join(cwd, "deny-side-effects.mjs");
  writeFileSync(guard, guardSource);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
  for (const key of Object.keys(env)) if (/^RELAYDOCK_|^__NEXT_|^NODE_OPTIONS$/i.test(key)) delete env[key];
  env.NEXT_TELEMETRY_DISABLED = "1";
  env.RELAYDOCK_PUBLIC_URL = "http://127.0.0.1:3000";
  if (healthy) {
    mkdirSync(data);
    const key = randomBytes(32); writeFileSync(join(data, "vault.key"), key);
    const db = new Database(join(data, "atlas.sqlite"));
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,secret TEXT); CREATE TABLE snapshots(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,payload TEXT NOT NULL,at TEXT NOT NULL,at_ms INTEGER,record_order INTEGER); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE sessions(id TEXT PRIMARY KEY,expires INTEGER NOT NULL,csrf TEXT NOT NULL);");
    db.prepare("INSERT INTO meta VALUES('adminHash',?)").run(hash);
    db.prepare("INSERT INTO accounts VALUES('private-fixture-account','{}',?)").run(encryptSecret("private-fixture-credential", key));
    db.close();
  }
  return {
    cwd, data, env,
    run(args = ["--json"], overrides: Record<string, string> = {}) {
      return spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, script, ...args], { cwd, env: { ...env, ...overrides }, encoding: "utf8", timeout: 15000 });
    },
    writeEnv(name: string, contents: string) { writeFileSync(join(cwd, name), contents); },
  };
}
afterEach(() => {
  for (const path of owned.splice(0)) {
    expect(dirname(resolve(path))).toBe(resolve(tmpdir()));
    expect(basename(path)).toMatch(/^atlas-doctor-cli-[a-zA-Z0-9]{6}$/);
    rmSync(path, { recursive: true, force: true });
  }
});
function parse(result: ReturnType<ReturnType<typeof fixture>["run"]>) {
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toMatch(/FORBIDDEN_SIDE_EFFECT|private-fixture|cli-fixture-salt|atlas-doctor-cli-|Error:|\bat file:/);
  return JSON.parse(result.stdout) as { schemaVersion: number; status: string; exitCode: number; checks: Array<{ id: string; status: string; code: string }> };
}
function check(report: ReturnType<typeof parse>, id: string) { return report.checks.find((c) => c.id === id)!; }

describe("doctor CLI in isolated offline deployments", () => {
  it("prints one whitelisted JSON report and returns 0 for a healthy closed database", () => {
    const f = fixture(); const result = f.run(); const report = parse(result);
    expect(report).toMatchObject({ schemaVersion: 1, status: "PASS", exitCode: 0 });
    expect(result.status).toBe(0);
    expect(check(report, "vault").code).toBe("VAULT_READY");
  });
  it("returns 1 for an uninitialized deployment without writing database, key or directory", () => {
    const f = fixture({ healthy: false }); f.writeEnv(".env.local", `RELAYDOCK_ADMIN_PASSWORD_HASH=${hash}\n`);
    const before = readdirSync(f.cwd).sort(), config = readFileSync(join(f.cwd, ".env.local"));
    const result = f.run(), report = parse(result);
    expect(report.status).toBe("WARN"); expect(result.status).toBe(1);
    expect(check(report, "database").code).toBe("DATABASE_UNINITIALIZED");
    expect(readdirSync(f.cwd).sort()).toEqual(before);
    expect(readFileSync(join(f.cwd, ".env.local"))).toEqual(config);
  });
  it("returns 2 for a missing initial admin configuration", () => {
    const f = fixture({ healthy: false }); const result = f.run(), report = parse(result);
    expect(check(report, "admin").status).toBe("FAIL"); expect(result.status).toBe(2);
  });
  it("uses shell configuration ahead of all env files without outputting configuration values", () => {
    const f = fixture(); f.writeEnv(".env.production.local", "RELAYDOCK_DNS_MODE=bad-file-secret\n");
    const result = f.run(["--json"], { RELAYDOCK_DNS_MODE: "system" });
    expect(parse(result).status).toBe("PASS"); expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("bad-file-secret");
  });
  it("uses production.local ahead of .env.local, production and .env", () => {
    const f = fixture();
    for (const file of [".env.local", ".env.production", ".env"]) f.writeEnv(file, "RELAYDOCK_DNS_MODE=bad-file-secret\n");
    f.writeEnv(".env.production.local", "RELAYDOCK_DNS_MODE=system\n");
    const result = f.run(); expect(parse(result).status).toBe("PASS"); expect(result.status).toBe(0);
  });
  it("checks the requested development mode rather than production files", () => {
    const f = fixture();
    f.writeEnv(".env.production", "RELAYDOCK_DNS_MODE=bad-production-secret\n");
    f.writeEnv(".env.development", "RELAYDOCK_DNS_MODE=system\n");
    const production = f.run(), development = f.run(["--json", "--development"]);
    expect(check(parse(production), "dns").status).toBe("FAIL"); expect(production.status).toBe(2);
    expect(parse(development).status).toBe("PASS"); expect(development.status).toBe(0);
  });
  it("expands env variables and quoted custom data paths the same way as Next", () => {
    const f = fixture({ dataName: "private-fixture-storage" });
    f.writeEnv(".env.local", 'ATLAS_FIXTURE_STORAGE=private-fixture-storage\nRELAYDOCK_DATA_DIR="${ATLAS_FIXTURE_STORAGE}"\n');
    const result = f.run(); expect(parse(result).status).toBe("PASS"); expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("private-fixture-storage");
  });
  it("does not require an env file when the existing database has authentication", () => {
    const f = fixture(); const result = f.run();
    expect(check(parse(result), "admin").code).toBe("ADMIN_DATABASE_READY");
    expect(result.status).toBe(0);
  });
  it("prints human-readable statuses and actions without revealing secrets", () => {
    const f = fixture({ healthy: false });
    const result = f.run([], { RELAYDOCK_QUERY_PROXY_URL: "socks5://secret-user:secret-password@private.invalid" });
    expect(result.status).toBe(2); expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/FAIL/); expect(result.stdout).toMatch(/WARN/);
    expect(result.stdout).toContain("npm run setup");
    expect(result.stdout).not.toMatch(/secret-user|secret-password|private\.invalid|FORBIDDEN_SIDE_EFFECT/);
  });
  it("rejects unknown arguments without echoing them", () => {
    const f = fixture(); const result = f.run(["--json", "--secret-token=private-fixture-credential"]);
    const report = parse(result); expect(report.status).toBe("FAIL"); expect(result.status).toBe(2);
    expect(check(report, "cli").code).toBe("CLI_ARGUMENT_INVALID");
  });
  it("does not read env or database files for --help", () => {
    const f = fixture(); mkdirSync(join(f.cwd, ".env.local"));
    const result = f.run(["--help"]); expect(result.status).toBe(0);
    expect(result.stdout).toContain("--json"); expect(result.stderr).toBe("");
  });
  it("reports non-regular env sources instead of blocking or silently treating them as configured", () => {
    const f = fixture(); mkdirSync(join(f.cwd, ".env.local"));
    const result = f.run(), report = parse(result);
    expect(check(report, "environment").code).toBe("ENVIRONMENT_LOAD_FAILED"); expect(result.status).toBe(2);
  });
  it("limits env file size before parsing and suppresses raw env errors", () => {
    const f = fixture(); f.writeEnv(".env.local", `#private-fixture-config-secret\n${"x".repeat(1024 * 1024)}`);
    const result = f.run(), report = parse(result);
    expect(check(report, "environment").code).toBe("ENVIRONMENT_LOAD_FAILED"); expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("private-fixture-config-secret");
  });
  it("returns a warning instead of certifying a database with unmerged WAL", () => {
    const f = fixture(); const db = new Database(join(f.data, "atlas.sqlite"));
    db.pragma("journal_mode = WAL"); db.exec("INSERT INTO meta VALUES('fixturePending','private-fixture-wal-secret')");
    try {
      const before = readFileSync(join(f.data, "atlas.sqlite-wal"));
      const result = f.run(), report = parse(result);
      expect(check(report, "database").code).toBe("DATABASE_WAL_PENDING"); expect(result.status).toBe(1);
      expect(readFileSync(join(f.data, "atlas.sqlite-wal"))).toEqual(before);
    } finally { db.close(); }
  });
  it("runs the real npm doctor entrypoint against synthetic configuration only", () => {
    const f = fixture();
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    writeFileSync(join(f.cwd, "package.json"), JSON.stringify({ name: "atlas-doctor-npm-fixture", version: "0.0.0", private: true, scripts: { doctor: manifest.scripts.doctor } }));
    mkdirSync(join(f.cwd, "scripts"));
    for (const name of ["doctor.mjs", "doctor-lib.mjs"]) writeFileSync(join(f.cwd, "scripts", name), readFileSync(resolve("scripts", name)));
    symlinkSync(resolve("node_modules"), join(f.cwd, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const npmCli = process.env.npm_execpath;
    expect(npmCli).toBeTruthy();
    const result = spawnSync(process.execPath, [npmCli!, "run", "--silent", "doctor", "--", "--json"], { cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 15000 });
    expect(parse(result).status).toBe("PASS"); expect(result.status).toBe(0);
  });  it("fails an incomplete recovery with an orphaned real WAL instead of advising empty initialization", () => {
    const source = fixture(), target = fixture({ healthy: false });
    const db = new Database(join(source.data, "atlas.sqlite"));
    db.pragma("journal_mode = WAL"); db.exec("INSERT INTO meta VALUES('pendingOrphan','private-fixture-pending')");
    try {
      mkdirSync(target.data);
      const wal = readFileSync(join(source.data, "atlas.sqlite-wal")); expect(wal.length).toBeGreaterThan(0);
      writeFileSync(join(target.data, "atlas.sqlite-wal"), wal);
      writeFileSync(join(target.data, "vault.key"), readFileSync(join(source.data, "vault.key")));
      const result = target.run(["--json"], { RELAYDOCK_ADMIN_PASSWORD_HASH: hash }), report = parse(result);
      expect(check(report, "database").code).toBe("DATABASE_RECOVERY_INCOMPLETE");
      expect(check(report, "admin").status).toBe("WARN"); expect(check(report, "vault").status).toBe("WARN");
      expect(result.status).toBe(2);
      expect(readdirSync(target.data).sort()).toEqual(["atlas.sqlite-wal", "vault.key"]);
      expect(readFileSync(join(target.data, "atlas.sqlite-wal"))).toEqual(wal);
    } finally { db.close(); }
  });
  it("does not certify uncommitted pages in a static database with a hot rollback journal", () => {
    const source = fixture(), target = fixture({ healthy: false });
    const db = new Database(join(source.data, "atlas.sqlite"));
    db.pragma("journal_mode = DELETE"); db.pragma("synchronous = OFF"); db.pragma("cache_size = 1"); db.pragma("cache_spill = ON");
    db.prepare("UPDATE meta SET value=? WHERE key='adminHash'").run(hash.replace("scrypt:", "broken:"));
    db.prepare("UPDATE accounts SET payload=?").run(JSON.stringify({ pad: "a".repeat(3500) }));
    const insert = db.prepare("INSERT INTO accounts VALUES(?,?,NULL)");
    db.transaction(() => { for(let i=0;i<80;i++) insert.run(`fixture-${i}`, JSON.stringify({ pad: "a".repeat(3500) })); })();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE meta SET value=? WHERE key='adminHash'").run(hash);
      db.prepare("UPDATE accounts SET payload=?").run(JSON.stringify({ pad: "b".repeat(3500) }));
      mkdirSync(target.data);
      const copies = ["atlas.sqlite", "atlas.sqlite-journal", "vault.key"].map((name) => [name, readFileSync(join(source.data, name))] as const);
      expect(copies[1][1].length).toBeGreaterThan(0);
      // Independently prove that the main file contains valid but uncommitted
      // admin pages; this fixture must keep catching the old false-PASS branch.
      const unrecovered = new Database(copies[0][1], { readonly: true });
      try {
        expect(unrecovered.pragma("quick_check(1)", { simple: true })).toBe("ok");
        expect((unrecovered.prepare("SELECT value FROM meta WHERE key='adminHash'").get() as { value: string }).value).toBe(hash);
      } finally { unrecovered.close(); }
      for(const [name, bytes] of copies) writeFileSync(join(target.data, name), bytes);
      const result = target.run(), report = parse(result);
      expect(check(report, "database").code).toBe("DATABASE_JOURNAL_PENDING");
      expect(check(report, "admin").status).toBe("WARN"); expect(check(report, "vault").status).toBe("WARN");
      expect(result.status).toBe(1);
      for(const [name, bytes] of copies) expect(readFileSync(join(target.data, name))).toEqual(bytes);
    } finally { db.exec("ROLLBACK"); db.close(); }
  }, 15000);});








