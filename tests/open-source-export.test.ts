import { afterEach, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const parents: string[] = [], links: string[] = [];
async function exporter() { return import(pathToFileURL(resolve("scripts/prepare-open-source.mjs")).href); }
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "relaydock-export-test-")));
  parents.push(parent);
  const root = join(parent, "source"); mkdirSync(root);
  for (const name of [".github", "docs", "public", "scripts", "src", "tests"]) mkdirSync(join(root, name));
  for (const name of [".dockerignore", ".gitignore", "AGENTS.md", "CLAUDE.md", "CHANGELOG.md", "CONTRIBUTING.md", "Dockerfile", "LICENSE", "README.md", "SECURITY.md", "THIRD-PARTY-NOTICES.md", "compose.yaml", "docker-compose.yml", "next.config.ts", "package-lock.json", "postcss.config.mjs", "tsconfig.json", "vitest.config.ts"])
    writeFileSync(join(root, name), "synthetic fixture\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "relaydock-atlas" }));
  writeFileSync(join(root, ".env.example"), "RELAYDOCK_ADMIN_PASSWORD=\nNEXT_TELEMETRY_DISABLED=1\n");
  writeFileSync(join(root, "public", ".gitkeep"), "");
  writeFileSync(join(root, "src", "page.tsx"), "export default function Page() { return null; }\n");
  return { parent, root };
}
afterEach(() => {
  for (const link of links.splice(0)) unlinkSync(link);
  for (const parent of parents.splice(0)) {
    assert.equal(dirname(parent), realpathSync(tmpdir()));
    assert.ok(parent.split(/[\\/]/).at(-1)!.startsWith("relaydock-export-test-"));
    assert.equal(realpathSync(parent), parent);
    rmSync(parent, { recursive: true });
  }
});

describe("public source snapshot boundary", () => {
  it("exports exact allowlisted source and manifest without parent history or deployment files", async () => {
    const { root } = fixture(), m = await exporter();
    for (const name of ["data", ".git", "output"]) { mkdirSync(join(root, name)); writeFileSync(join(root, name, "secret.txt"), "never export"); }
    writeFileSync(join(root, ".env.local"), "SECRET=never-export");
    writeFileSync(join(root, "debug.log"), "never export");
    const result = m.prepareOpenSource(root);
    expect(result.status).toBe("PASS");
    for (const name of ["data", ".git", "output", ".env.local", "debug.log"]) expect(existsSync(join(result.directory, name))).toBe(false);
    expect(existsSync(join(result.directory, "public", ".gitkeep"))).toBe(true);
    expect(readFileSync(join(result.directory, "src", "page.tsx"), "utf8")).toBe(readFileSync(join(root, "src", "page.tsx"), "utf8"));
    const manifest = JSON.parse(readFileSync(result.manifest, "utf8"));
    expect(manifest.sourceSha256).toBe(m.inspectSource(result.directory).sourceSha256);
    expect(manifest.entries.every((e: any) => /^[a-f0-9]{64}$/.test(e.sha256))).toBe(true);
    expect(manifest.published).toBe(false);
  });
  it("excludes nested database journals, secrets, logs and environment examples", async () => {
    const { root } = fixture(), m = await exporter();
    for (const name of ["private.db-journal", "private.sqlite-wal", "vault.key", "credentials.enc", "debug.log", ".env.local", ".env.example"])
      writeFileSync(join(root, "src", name), "not a credential fixture");
    expect(m.inspectSource(root).entries.filter((e: any) => e.path.startsWith("src/")).map((e: any) => e.path)).toEqual(["src/page.tsx"]);
  });
  it("blocks embedded credentials before writing a candidate and reports no matched values", async () => {
    const { root } = fixture(), m = await exporter();
    const token = "ghp_" + "A".repeat(36);
    writeFileSync(join(root, "src", "secret.ts"), `export const token = '${token}';`);
    const result = m.prepareOpenSource(root);
    expect(result.status).toBe("BLOCKED"); expect(result.findings).toContainEqual({ file: "src/secret.ts", rule: "github-token" });
    expect(JSON.stringify(result)).not.toContain(token); expect(existsSync(join(root, "output"))).toBe(false);
  });
  it("accepts labelled synthetic fixture keys but blocks them in production source", async () => {
    const { root } = fixture(), m = await exporter();
    const text = "const key = 'sk-synthetic-fixture-key-123456789';";
    writeFileSync(join(root, "tests", "fixture.test.ts"), text);
    expect(m.prepareOpenSource(root, { check: true }).status).toBe("PASS");
    writeFileSync(join(root, "src", "secret.ts"), text);
    expect(m.prepareOpenSource(root, { check: true }).status).toBe("BLOCKED");
  });
  it("blocks nonempty password examples and unreviewed active environment variables", async () => {
    const { root } = fixture(), m = await exporter();
    for (const line of ["RELAYDOCK_ADMIN_PASSWORD=secret", "RELAYDOCK_VAULT_KEY=secret", "NEXT_TELEMETRY_DISABLED=0"]) {
      writeFileSync(join(root, ".env.example"), line);
      expect(m.prepareOpenSource(root, { check: true }).status).toBe("BLOCKED");
    }
  });
  it("blocks generic personal home paths without embedding a local user's identifiers", async () => {
    const { root } = fixture(), m = await exporter();
    const paths = [["C:", "Users", "synthetic-person", "notes.txt"].join("\\"),
      ["", "Users", "synthetic-person", "notes.txt"].join("/"),
      ["", "home", "synthetic-person", "notes.txt"].join("/")];
    for (const path of paths) {
      writeFileSync(join(root, "docs", "private.md"), path);
      const result = m.prepareOpenSource(root, { check: true });
      expect(result.status).toBe("BLOCKED");
      expect(result.findings).toContainEqual({ file: "docs/private.md", rule: "personal-path" });
      expect(JSON.stringify(result)).not.toContain(path);
    }
  });
  it("rejects a source junction to files outside the application", async () => {
    const { parent, root } = fixture(), m = await exporter(), outside = join(parent, "private"); mkdirSync(outside);
    const link = join(root, "src", "linked"); symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); links.push(link);
    expect(() => m.inspectSource(root)).toThrow(/linked source/);
  });
  it("rejects redirected output and refuses unsupported binary assets", async () => {
    const { parent, root } = fixture(), m = await exporter(), outside = join(parent, "external"); mkdirSync(outside);
    const link = join(root, "output"); symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); links.push(link);
    expect(() => m.prepareOpenSource(root)).toThrow(/linked output/);
    writeFileSync(join(root, "public", "private.zip"), "not public");
    expect(() => m.inspectSource(root)).toThrow(/unsupported asset/);
  });
  it("check mode is read-only and source changes alter the fingerprint", async () => {
    const { root } = fixture(), m = await exporter(), before = m.prepareOpenSource(root, { check: true });
    expect(existsSync(join(root, "output"))).toBe(false);
    writeFileSync(join(root, "src", "page.tsx"), "export default function Page() { return 'changed'; }");
    expect(m.prepareOpenSource(root, { check: true }).sourceSha256).not.toBe(before.sourceSha256);
  });
  it("accepts only the exact existing synthetic TLS fixture and rejects a replacement key", async () => {
    const { root } = fixture(), m = await exporter();
    const file = join(root, "tests", "proxy.test.ts");
    writeFileSync(file, readFileSync(resolve("tests/proxy.test.ts")));
    expect(m.prepareOpenSource(root, { check: true }).status).toBe("PASS");
    const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" "), footer = ["-----END", "PRIVATE KEY-----"].join(" ");
    writeFileSync(file, `const key = \`${header}\nsynthetic-but-unreviewed\n${footer}\`;\n`);
    expect(m.prepareOpenSource(root, { check: true }).status).toBe("BLOCKED");
  });
});
