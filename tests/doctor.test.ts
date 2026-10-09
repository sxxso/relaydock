import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { encryptSecret } from "../src/lib/crypto";

const helper = () => import("../scripts/doctor-lib.mjs");
const owned: string[] = [];
const hash = `scrypt:fixture-salt:${"ab".repeat(64)}`;
function fixture() {
  const cwd = fs.mkdtempSync(join(tmpdir(), "atlas-doctor-test-"));
  owned.push(cwd);
  const data = join(cwd, "data");
  const key = randomBytes(32);
  const env: Record<string, string> = {
    RELAYDOCK_ADMIN_PASSWORD_HASH: hash,
    RELAYDOCK_PUBLIC_URL: "http://127.0.0.1:3000",
  };
  function database({ legacy = false, secrets = [encryptSecret("fixture-token-never-print", key)], admin = hash } = {}) {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(join(data, "vault.key"), key);
    const db = new Database(join(data, "atlas.sqlite"));
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,secret TEXT);
      CREATE TABLE snapshots(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,payload TEXT NOT NULL,at TEXT NOT NULL${legacy ? "" : ",at_ms INTEGER,record_order INTEGER"});
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,expires INTEGER NOT NULL,csrf TEXT NOT NULL);`);
    secrets.forEach((secret, i) => db.prepare("INSERT INTO accounts VALUES(?,?,?)").run(String(i), '{"name":"private-account-do-not-print"}', secret));
    if (admin) db.prepare("INSERT INTO meta VALUES('adminHash',?)").run(admin);
    return db;
  }
  return { cwd, data, key, env, database };
}
afterEach(() => {
  for (const path of owned.splice(0)) {
    expect(dirname(resolve(path))).toBe(resolve(tmpdir()));
    expect(basename(path)).toMatch(/^atlas-doctor-test-[a-zA-Z0-9]{6}$/);
    fs.rmSync(path, { recursive: true, force: true });
  }
});
function get(report: { checks: Array<{ id: string; status: string; code: string }> }, id: string) {
  const check = report.checks.find((c) => c.id === id);
  expect(check, id).toBeDefined();
  return check!;
}
function inventory(path: string): Record<string, { bytes: string; mtimeMs: number }> {
  if (!fs.existsSync(path)) return {};
  return Object.fromEntries(fs.readdirSync(path).map((name) => {
    const file = join(path, name);
    return [name, { bytes: fs.readFileSync(file).toString("hex"), mtimeMs: fs.statSync(file).mtimeMs }];
  }));
}

describe("offline deployment doctor", () => {
  it.each([
    ["v22.19.9", false], ["22.20.0", true], ["22.21.0", true],
    ["23.0.0", true], ["24.0.0", true], ["20.99.0", false], ["bogus-secret", false],
  ])("checks the declared Node floor: %s", async (version, expected) => {
    expect((await helper()).checkNodeVersion(version)).toBe(expected);
  });
  it.each([
    ["public_url", { RELAYDOCK_PUBLIC_URL: "https://atlas.example" }, "PASS"],
    ["public_url", {}, "WARN"],
    ["public_url", { RELAYDOCK_PUBLIC_URL: "http://atlas.example" }, "FAIL"],
    ["public_url", { RELAYDOCK_PUBLIC_URL: "https://user:secret@atlas.example" }, "FAIL"],
    ["public_url", { RELAYDOCK_PUBLIC_URL: "https://atlas.example/path?q=secret" }, "FAIL"],
    ["public_url", { RELAYDOCK_PUBLIC_URL: "file:///secret" }, "FAIL"],
    ["dns", {}, "PASS"], ["dns", { RELAYDOCK_DNS_MODE: "cloudflare" }, "PASS"],
    ["dns", { RELAYDOCK_DNS_MODE: "automatic-secret" }, "FAIL"],
    ["query_proxy", {}, "PASS"],
    ["query_proxy", { RELAYDOCK_QUERY_PROXY_URL: "https://user:password@proxy.invalid:8443" }, "PASS"],
    ["query_proxy", { RELAYDOCK_QUERY_PROXY_URL: "socks5://secret@proxy.invalid" }, "FAIL"],
    ["query_proxy", { RELAYDOCK_QUERY_PROXY_URL: "https://user:%0Asecret@proxy.invalid" }, "FAIL"],
    ["query_proxy", { RELAYDOCK_QUERY_PROXY_URL: "http://proxy.invalid:0" }, "FAIL"],
    ["query_proxy", { RELAYDOCK_QUERY_PROXY_URL: "http://proxy.invalid/path" }, "FAIL"],
    ["private_hosts", {}, "PASS"],
    ["private_hosts", { RELAYDOCK_PRIVATE_HOSTS: "relay.internal.example, second.internal.example" }, "PASS"],
    ["private_hosts", { RELAYDOCK_PRIVATE_HOSTS: "*.internal.example" }, "FAIL"],
    ["private_hosts", { RELAYDOCK_PRIVATE_HOSTS: "https://secret.example" }, "FAIL"],
    ["private_hosts", { RELAYDOCK_PRIVATE_HOSTS: "relay.internal.example:8080" }, "FAIL"],
  ])("checks %s locally without echoing values", async (id, env, expected) => {
    const checks = (await helper()).checkConfiguration(env);
    expect(get({ checks }, id).status).toBe(expected);
    expect(JSON.stringify(checks)).not.toMatch(/automatic-secret|user:password|q=secret|\.invalid|\.example/);
  });
  it("reports first-start warnings without creating any data or key", async () => {
    const f = fixture();
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(report).toMatchObject({ schemaVersion: 1, status: "WARN", exitCode: 1 });
    expect(get(report, "database").code).toBe("DATABASE_UNINITIALIZED");
    expect(get(report, "vault").code).toBe("VAULT_UNINITIALIZED");
    expect(get(report, "data_dir").status).toBe("WARN");
    expect(get(report, "admin").status).toBe("PASS");
    expect(fs.readdirSync(f.cwd)).toEqual([]);
  });
  it("fails missing or malformed first-start authentication instead of claiming readiness", async () => {
    const f = fixture();
    for (const auth of [{}, { RELAYDOCK_ADMIN_PASSWORD: "short" }, { RELAYDOCK_ADMIN_PASSWORD_HASH: "scrypt:secret:bad" }]) {
      const report = await (await helper()).runDoctor({ cwd: f.cwd, env: { RELAYDOCK_PUBLIC_URL: f.env.RELAYDOCK_PUBLIC_URL, ...auth } });
      expect(get(report, "admin").status).toBe("FAIL");
      expect(report.exitCode).toBe(2);
      expect(JSON.stringify(report)).not.toContain("scrypt:secret");
    }
  });
  it("accepts the minimum initialization password without printing it", async () => {
    const f = fixture(), secret = "safe-fixture-password";
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: { RELAYDOCK_ADMIN_PASSWORD: secret } });
    expect(get(report, "admin").status).toBe("PASS");
    expect(JSON.stringify(report)).not.toContain(secret);
  });
  it("checks a closed WAL-mode database in memory, preserving source files and timestamps", async () => {
    const f = fixture(); f.database().close();
    const before = inventory(f.data);
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: { RELAYDOCK_PUBLIC_URL: f.env.RELAYDOCK_PUBLIC_URL } });
    expect(report).toMatchObject({ status: "PASS", exitCode: 0 });
    expect(get(report, "database").code).toBe("DATABASE_HEALTHY");
    expect(get(report, "vault").code).toBe("VAULT_READY");
    expect(get(report, "admin").code).toBe("ADMIN_DATABASE_READY");
    expect(inventory(f.data)).toEqual(before);
    expect(JSON.stringify(report)).not.toContain(hash);
    expect(JSON.stringify(report)).not.toMatch(/private-account|fixture-token|atlas-doctor-test-/);
    for (const check of report.checks) expect(Object.keys(check).sort()).toEqual(["advice", "code", "id", "message", "status"]);
  });
  it("does not replace a lost key even when the database has no encrypted accounts", async () => {
    const f = fixture(); f.database({ secrets: [] }).close();
    fs.unlinkSync(join(f.data, "vault.key"));
    const before = inventory(f.data);
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(get(report, "vault").code).toBe("VAULT_MISSING");
    expect(report.exitCode).toBe(2);
    expect(inventory(f.data)).toEqual(before);
  });
  it("rejects an incorrect but correctly sized key by authenticating encrypted credentials", async () => {
    const f = fixture(); f.database().close();
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: { ...f.env, RELAYDOCK_VAULT_KEY: randomBytes(32).toString("hex") } });
    expect(get(report, "vault").code).toBe("VAULT_CREDENTIALS_MISMATCH");
    expect(report.exitCode).toBe(2);
  });
  it("checks all encrypted accounts, not only the first successfully decryptable row", async () => {
    const f = fixture();
    f.database({ secrets: [encryptSecret("first-secret", f.key), encryptSecret("second-secret", randomBytes(32))] }).close();
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(get(report, "vault").code).toBe("VAULT_CREDENTIALS_MISMATCH");
    expect(JSON.stringify(report)).not.toMatch(/first-secret|second-secret/);
  });
  it.each(["a".repeat(63), "a".repeat(65), "g".repeat(64)])("rejects noncanonical master keys", async (key) => {
    const f = fixture();
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: { ...f.env, RELAYDOCK_VAULT_KEY: key } });
    expect(get(report, "vault").code).toBe("VAULT_ENV_INVALID");
  });
  it("rejects corrupted key files without exposing their bytes", async () => {
    const f = fixture(); f.database().close();
    fs.writeFileSync(join(f.data, "vault.key"), "fixture-broken-key");
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(get(report, "vault").code).toBe("VAULT_FILE_INVALID");
    expect(JSON.stringify(report)).not.toContain("fixture-broken-key");
  });
  it("checks source permissions without write probes, including ancestors of a missing data directory", async () => {
    const f = fixture();
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: { ...f.env, RELAYDOCK_DATA_DIR: "missing/nested" }, fs: { ...fs, accessSync(path, mode) { if (mode && (mode & fs.constants.W_OK)) throw new Error("permission-secret"); fs.accessSync(path, mode); } } });
    expect(get(report, "data_dir").code).toBe("DATA_DIR_PERMISSION_DENIED");
    expect(JSON.stringify(report)).not.toContain("permission-secret");
    expect(fs.readdirSync(f.cwd)).toEqual([]);
  });
  it("rejects a data path that is a regular file", async () => {
    const f = fixture(); fs.writeFileSync(f.data, "path-secret");
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(get(report, "data_dir").status).toBe("FAIL");
    expect(fs.readFileSync(f.data, "utf8")).toBe("path-secret");
  });
  it("reports corruption safely without an SQLite error, path or database content", async () => {
    const f = fixture(); fs.mkdirSync(f.data); fs.writeFileSync(join(f.data, "atlas.sqlite"), "private-corrupt-content");
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(get(report, "database").status).toBe("FAIL");
    expect(JSON.stringify(report)).not.toMatch(/private-corrupt-content|SQLITE_(?:NOTADB|CORRUPT|CANTOPEN)|atlas-doctor-test-/);
  });
  it("rejects missing application tables without creating or migrating them", async () => {
    const f = fixture(); f.database().close();
    const db = new Database(join(f.data, "atlas.sqlite")); db.exec("DROP TABLE sessions"); db.close();
    const before = inventory(f.data);
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(get(report, "database").code).toBe("DATABASE_SCHEMA_INVALID");
    expect(inventory(f.data)).toEqual(before);
  });
  it("warns on known legacy ordering columns without performing the startup migration", async () => {
    const f = fixture(); f.database({ legacy: true }).close();
    const before = inventory(f.data);
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(get(report, "database").code).toBe("DATABASE_SCHEMA_LEGACY");
    expect(report.exitCode).toBe(1);
    expect(inventory(f.data)).toEqual(before);
  });
  it("does not read a stale main database while a nonempty WAL exists", async () => {
    const f = fixture(), db = f.database();
    try {
      const before = inventory(f.data);
      const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
      expect(get(report, "database").code).toBe("DATABASE_WAL_PENDING");
      expect(get(report, "vault").status).toBe("WARN");
      expect(report.exitCode).toBe(1);
      expect(inventory(f.data)).toEqual(before);
    } finally { db.close(); }
  });
  it("bounds memory usage and reports unverified rather than silently passing a large database", async () => {
    const f = fixture(); f.database().close();
    fs.truncateSync(join(f.data, "atlas.sqlite"), 64 * 1024 * 1024 + 1);
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(get(report, "database").code).toBe("DATABASE_TOO_LARGE");
    expect(get(report, "vault").status).toBe("WARN");
    expect(report.exitCode).toBe(1);
  });
  it("detects a changing source rather than certifying a non-atomic snapshot", async () => {
    const f = fixture(); f.database().close(); let reads = 0;
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env, fs: { ...fs, fstatSync: ((fd: number, options?: fs.StatOptions) => { const stat = fs.fstatSync(fd, options); if (typeof stat.mtimeMs === "number" && Number(stat.size) > 32 && ++reads >= 2) Object.assign(stat, { mtimeMs: stat.mtimeMs + 1 }); return stat; }) as typeof fs.fstatSync } });
    expect(get(report, "database").code).toBe("DATABASE_CHANGED");
    expect(report.exitCode).toBe(1);
  });
  it("honors persisted admin authentication over initialization environment", async () => {
    const f = fixture(); f.database().close();
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: { ...f.env, RELAYDOCK_ADMIN_PASSWORD_HASH: "scrypt:ignored-secret:bad" } });
    expect(get(report, "admin").code).toBe("ADMIN_DATABASE_READY");
    expect(report.exitCode).toBe(0);
  });
  it("does not suggest environment-only repair for a malformed persisted admin hash", async () => {
    const f = fixture(); f.database({ admin: "scrypt:database-secret:bad" }).close();
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(get(report, "admin").code).toBe("ADMIN_DATABASE_INVALID");
    expect(report.exitCode).toBe(2);
  });
  it("reports a native-addon constructor failure without attempting a disk database connection", async () => {
    const f = fixture(); f.database().close(); let calls = 0;
    class BrokenDriver { constructor() { calls++; throw new Error("native-error-secret"); } }
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env, loadDatabase: async () => BrokenDriver });
    expect(get(report, "sqlite_driver").code).toBe("SQLITE_DRIVER_UNAVAILABLE");
    expect(get(report, "database").code).toBe("DATABASE_DRIVER_BLOCKED");
    expect(report.exitCode).toBe(2);
    expect(calls).toBe(1);
    expect(JSON.stringify(report)).not.toContain("native-error-secret");
  });
  it("fails malformed ciphertext even with a valid key", async () => {
    const f = fixture(); f.database({ secrets: ["credential-secret-not-encrypted"] }).close();
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(get(report, "vault").code).toBe("VAULT_CREDENTIALS_MISMATCH");
    expect(JSON.stringify(report)).not.toContain("credential-secret-not-encrypted");
  });
  it("stops before reading deployment data on unsupported Node versions", async () => {
    const f = fixture(); let loaded = false;
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env, nodeVersion: "20.9.0", loadDatabase: async () => { loaded = true; throw new Error(); } });
    expect(get(report, "node").code).toBe("NODE_UNSUPPORTED");
    expect(report.exitCode).toBe(2);
    expect(loaded).toBe(false);
  });  it("rejects a rollback journal appearing after the main file was read", async () => {
    const f = fixture(); f.database().close(); let journalStats = 0;
    const statSync = ((path: fs.PathLike, options?: fs.StatOptions) => {
      if (String(path) === join(f.data, "atlas.sqlite-journal") && ++journalStats >= 2) return fs.statSync(join(f.data, "vault.key"), options);
      return fs.statSync(path, options);
    }) as typeof fs.statSync;
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env, fs: { ...fs, statSync } });
    expect(get(report, "database").code).toBe("DATABASE_CHANGED");
    expect(get(report, "admin").status).toBe("WARN"); expect(get(report, "vault").status).toBe("WARN");
    expect(report.exitCode).toBe(1);
  });
  it.each(["atlas.sqlite-shm", "atlas.sqlite-journal"])("preserves orphaned %s instead of treating an incomplete restore as fresh", async (name) => {
    const f = fixture(); f.database().close(); fs.unlinkSync(join(f.data, "atlas.sqlite"));
    fs.writeFileSync(join(f.data, name), "private-recovery-fixture");
    const before = inventory(f.data);
    const report = await (await helper()).runDoctor({ cwd: f.cwd, env: f.env });
    expect(get(report, "database").code).toBe("DATABASE_RECOVERY_INCOMPLETE"); expect(report.exitCode).toBe(2);
    expect(inventory(f.data)).toEqual(before); expect(JSON.stringify(report)).not.toContain("private-recovery-fixture");
  });});



