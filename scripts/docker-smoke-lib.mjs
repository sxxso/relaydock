import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function parseLoopbackBinding(value) {
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(value.trim());
  assert.ok(match, "Expected exactly one IPv4 loopback binding");
  const port = Number(match[1]);
  assert.ok(port >= 1 && port <= 65535, "Invalid published port");
  return `http://127.0.0.1:${port}`;
}
export function resourceName(token, kind) {
  assert.match(token, /^[a-f0-9]{12}$/);
  assert.ok(["app", "restored", "fixture", "network", "data", "migration", "copy", "image"].includes(kind), "Unknown owned resource kind");
  return `relaydock-smoke-${token}-${kind}`;
}
export function deniedSourceName(name) {
  return /^\.env/i.test(name) || /^(?:data|node_modules|\.next|\.git|\.agents|\.codex|vault|credentials(?:\..*)?)$/i.test(name) || /\.(?:sqlite3?|db)(?:-wal|-shm)?$|\.(?:pem|pfx|p12|key)$/i.test(name);
}
function inside(parent, path) {
  const part = relative(parent, path);
  assert.ok(part && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`), "Path escaped its owned parent");
}
export function cleanupDockerContext(ctx) {
  const target = resolve(ctx.dir), parent = realpathSync(ctx.parent);
  assert.equal(dirname(target), parent);
  assert.match(basename(target), /^relaydock-docker-context-[a-zA-Z0-9]{6}$/);
  assert.equal(realpathSync(target), target, "Refuse a replaced context");
  assert.notEqual(target, ctx.root);
  const remove = (path) => {
    if (path !== target) inside(target, path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { unlinkSync(path); return; }
    if (stat.isDirectory()) {
      assert.equal(realpathSync(path), path, "Refuse a linked directory");
      for (const name of readdirSync(path)) remove(join(path, name));
      rmdirSync(path);
    } else { assert.ok(stat.isFile()); unlinkSync(path); }
  };
  remove(target);
}
export function createDockerContext(rootInput, parentInput = tmpdir()) {
  const root = realpathSync(resolve(rootInput)), parent = realpathSync(parentInput);
  const dir = realpathSync(mkdtempSync(join(parent, "relaydock-docker-context-")));
  const ctx = { dir, parent, root, copiedFiles: 0 };
  const copy = (source, destination) => {
    if (deniedSourceName(basename(source))) return; // Before stat/read.
    inside(root, source); inside(dir, destination);
    const stat = lstatSync(source);
    assert.ok(!stat.isSymbolicLink(), "Refuse source links/junctions");
    inside(root, realpathSync(source));
    if (stat.isDirectory()) {
      mkdirSync(destination);
      for (const name of readdirSync(source).sort()) copy(join(source, name), join(destination, name));
    } else {
      assert.ok(stat.isFile(), "Only regular sources may be copied");
      const content = readFileSync(source), after = lstatSync(source);
      assert.equal(after.size, stat.size); assert.equal(after.mtimeMs, stat.mtimeMs);
      writeFileSync(destination, content, { flag: "wx" }); ctx.copiedFiles++;
    }
  };
  try {
    for (const name of ["src", "public", "LICENSE", "THIRD-PARTY-NOTICES.md", "Dockerfile", ".dockerignore", "package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "next-env.d.ts", "postcss.config.mjs"])
      if (existsSync(join(root, name))) copy(join(root, name), join(dir, name));
    const scriptRoot = join(root, "scripts");
    if (existsSync(scriptRoot)) {
      const stat = lstatSync(scriptRoot);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Refuse linked script directories");
      inside(root, realpathSync(scriptRoot));
      mkdirSync(join(dir, "scripts"));
      for (const name of ["doctor.mjs", "doctor-lib.mjs"])
        if (existsSync(join(scriptRoot, name))) copy(join(scriptRoot, name), join(dir, "scripts", name));
    }
    assert.ok(existsSync(join(dir, "Dockerfile")) && existsSync(join(dir, "package.json")), "Missing build contract");
    return ctx;
  } catch (error) { cleanupDockerContext(ctx); throw error; }
}
export function assertDataOnlyBackup(backup, secrets) {
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!/^(?:credential|credentials|vaultKey|vault_key|adminHash|sessions?|password|token)$/i.test(key), "Data backup contains a forbidden secret field");
      visit(child);
    }
  };
  visit(backup);
  const serialized = JSON.stringify(backup);
  for (const secret of secrets) if (secret) assert.ok(!serialized.includes(secret), "Data backup contains a fixture secret");
}
export async function readPublishedOrigin(docker, name) {
  assert.match(name, /^relaydock-smoke-[a-f0-9]{12}-(?:app|restored)$/);
  return parseLoopbackBinding(await docker(["port", name, "3000/tcp"]));
}
export function isMissingOwnedResource(error, type, name) {
  if (!["container", "volume", "network", "image"].includes(type) || !/^relaydock-smoke-[a-f0-9]{12}-[a-z]+$/.test(name)) return false;
  const text = String(error?.stderr ?? "").trim();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = "(?:Error: *|Error response from daemon: *)?";
  const exactName = escaped + (type === "image" ? "(?::latest)?" : "");
  const absence = new RegExp(`^${prefix}No such (?:${type}|object): *${exactName}$`, "i");
  if (absence.test(text)) return true;
  if (type === "volume") return new RegExp(`^${prefix}get ${escaped}: no such volume$`, "i").test(text);
  if (type === "network") return new RegExp(`^${prefix}network ${escaped} not found$`, "i").test(text);
  // Context, permission, connection, and multi-error messages must fail cleanup.
  return false;
}
