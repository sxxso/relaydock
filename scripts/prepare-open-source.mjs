import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const directories = [".github", "docs", "public", "scripts", "src", "tests"];
const files = [".dockerignore", ".env.example", ".gitignore", "AGENTS.md", "CLAUDE.md", "CHANGELOG.md", "CONTRIBUTING.md", "Dockerfile", "LICENSE", "README.md", "SECURITY.md", "THIRD-PARTY-NOTICES.md", "compose.yaml", "docker-compose.yml", "next.config.ts", "package.json", "package-lock.json", "postcss.config.mjs", "tsconfig.json", "vitest.config.ts"];
const prohibited = (name) =>
  (/^\.env/i.test(name) && name !== ".env.example") ||
  /^(?:\.git|\.agents|\.codex|\.learnings|\.playwright-cli|\.auth|data|output|node_modules|\.next|backups?|playwright-report|test-results)$/i.test(name) ||
  /\.(?:sqlite3?|db)(?:[-.].*)?$|\.(?:key|pem|pfx|p12|log|tsbuildinfo)$|^(?:vault|credentials|storage[_-](?:scan|analysis|report|app)).*/i.test(name);
const textExtensions = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|svg|txt)$|(?:^|\/)(?:Dockerfile|LICENSE|\.gitignore|\.dockerignore|\.gitkeep|\.env\.example)$/;
const rules = [
  ["private-key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["api-key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["personal-path", /(?:[A-Z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s]+|\/(?:Users|home)\/[^/\s]+)/i],
];

function inside(parent, child) {
  const rel = relative(parent, child);
  assert.ok(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep), "Path must stay inside its owned parent");
}

// Public test-only TLS fixture (CN=relaydock-test-only), never deployment material.
// Do not exempt all test private keys: only this exact existing fixture is accepted.
function knownSyntheticTls(rel, text) {
  if (rel !== "tests/proxy.test.ts") return false;
  const keys = text.match(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g) || [];
  const headers = text.match(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g) || [];
  return headers.length === 1 && keys.length === 1 &&
    createHash("sha256").update(keys[0].replace(/\r\n/g, "\n")).digest("hex") === "232d3d0b8c2243de3a204619792d34cae26b17c709595f170449feb99243a494";
}

export function inspectSource(rootInput) {
  const root = realpathSync(resolve(rootInput));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "relaydock-atlas", "Run from the RelayDock application directory");
  const entries = [], findings = [];
  function visit(source) {
    inside(root, source);
    const rel = relative(root, source).split(sep).join("/");
    const stat = lstatSync(source);
    // Refuse links even if their filename would otherwise be excluded.
    assert.ok(!stat.isSymbolicLink(), "Refuse linked source entry: " + rel);
    inside(root, realpathSync(source));
    if (prohibited(source.split(sep).at(-1)) || (rel !== ".env.example" && /^\.env/i.test(source.split(sep).at(-1)))) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(source).sort()) visit(join(source, name));
      return;
    }
    assert.ok(stat.isFile(), "Only regular source files may be exported: " + rel);
    assert.ok(stat.size <= 2 * 1024 * 1024, "Unexpected large source file: " + rel);
    assert.ok(textExtensions.test(rel) || /^docs\/images\/atlas-(?:light|dark|mobile)\.webp$/.test(rel) || /^docs\/images\/atlas-current-(?:light|dark|mobile)\.png$/.test(rel), "Review unsupported asset before publishing: " + rel);
    const content = readFileSync(source);
    const after = lstatSync(source);
    assert.equal(after.mtimeMs, stat.mtimeMs, "Source changed during snapshot");
    assert.equal(after.size, stat.size, "Source changed during snapshot");
    if (textExtensions.test(rel)) {
      const text = content.toString("utf8");
      for (const [rule, regex] of rules) {
        const matches = text.match(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g")) || [];
        // Only clearly labelled synthetic API keys in fixture code are accepted.
        const fixture = /^(?:tests\/|scripts\/verify-|src\/lib\/adapters\/[^/]+\/fixtures\.json$)/.test(rel);
        if (matches.some((value) => !(rule === "api-key" && fixture && /(?:test|fixture|synthetic|example|fake|dummy|mock)/i.test(value)) && !(rule === "private-key" && knownSyntheticTls(rel, text))))
          findings.push({ file: rel, rule }); // Never print the matched secret or source line.
      }
      if (rel === ".env.example") {
        const allowed = new Set(["RELAYDOCK_ADMIN_PASSWORD", "NEXT_TELEMETRY_DISABLED"]);
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim() || line.trim().startsWith("#")) continue;
          const match = /^([A-Z_]+)=(.*)$/.exec(line);
          if (!match || !allowed.has(match[1]) || (match[1] === "RELAYDOCK_ADMIN_PASSWORD" ? match[2] !== "" : match[2] !== "1"))
            findings.push({ file: rel, rule: "nonempty-or-unreviewed-env-example" });
        }
      }
    }
    entries.push({ path: rel, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), content });
  }
  for (const name of [...directories, ...files]) {
    assert.ok(existsSync(join(root, name)), "Missing release input: " + name);
    visit(join(root, name));
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const digest = createHash("sha256");
  for (const entry of entries) digest.update(entry.path + "\0" + entry.sha256 + "\n");
  return { root, entries, findings, sourceSha256: digest.digest("hex") };
}

export function prepareOpenSource(rootInput, { check = false } = {}) {
  const snapshot = inspectSource(rootInput);
  const summary = { status: snapshot.findings.length ? "BLOCKED" : "PASS", files: snapshot.entries.length, bytes: snapshot.entries.reduce((n, e) => n + e.bytes, 0), sourceSha256: snapshot.sourceSha256, findings: snapshot.findings, scope: "allowlisted current source only; no parent Git history or deployment data", published: false };
  if (snapshot.findings.length || check) return summary;
  const output = join(snapshot.root, "output");
  if (existsSync(output)) assert.ok(lstatSync(output).isDirectory() && !lstatSync(output).isSymbolicLink(), "Refuse linked output directory");
  else mkdirSync(output);
  const parent = join(output, "open-source");
  if (existsSync(parent)) assert.ok(lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink(), "Refuse linked release parent");
  else mkdirSync(parent);
  inside(snapshot.root, realpathSync(parent));
  const bundle = mkdtempSync(join(parent, "candidate-"));
  assert.equal(dirname(realpathSync(bundle)), realpathSync(parent));
  const destination = join(bundle, "relaydock");
  mkdirSync(destination);
  for (const name of directories) mkdirSync(join(destination, name));
  for (const entry of snapshot.entries) {
    const target = join(destination, entry.path);
    inside(destination, target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.content, { flag: "wx" });
  }
  const exported = inspectSource(destination);
  assert.equal(exported.sourceSha256, snapshot.sourceSha256);
  assert.deepEqual(exported.findings, []);
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify({ ...summary, createdAt: new Date().toISOString(), entries: snapshot.entries.map(({ content, ...entry }) => entry) }, null, 2) + "\n", { flag: "wx" });
  return { ...summary, directory: destination, manifest: join(bundle, "manifest.json") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--check"), "Usage: npm run release:prepare [-- --check]");
    const result = prepareOpenSource(process.cwd(), { check: args[0] === "--check" });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "PASS") process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
