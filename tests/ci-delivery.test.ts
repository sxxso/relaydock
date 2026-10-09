import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));
async function runner() {
  const file = resolve(root, "scripts/run-browser-ci.mjs");
  expect(existsSync(file), "browser CI runner is missing").toBe(true);
  return import(pathToFileURL(file).href);
}
describe("open-source delivery contract", () => {
  it("declares the confirmed MIT license with cjmarklll copyright and matching package metadata", () => {
    expect(pkg.license).toBe("MIT");
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.packages[""].license).toBe("MIT");
    expect(existsSync(resolve(root, "LICENSE")), "application LICENSE is missing").toBe(true);
    const license = read("LICENSE");
    expect(license).toMatch(/^MIT License\r?\n/);
    expect(license).toMatch(/^Copyright \(c\) 2026 cjmarklll$/m);
    expect(license).toContain("Permission is hereby granted, free of charge, to any person obtaining a copy");
    expect(license).toContain("The above copyright notice and this permission notice shall be included in all");
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
    expect(license).not.toMatch(/<year>|<copyright holders>/);
  });
  it("exposes opt-in Docker, grouped browser, and query-focus commands", () => {
    expect(pkg.scripts["ci:browser"]).toBe("node scripts/run-browser-ci.mjs");
    expect(pkg.scripts["test:docker"]).toBe("node scripts/verify-docker.mjs");
    expect(pkg.scripts["test:query-focus"]).toBe("tsx scripts/verify-query-focus.ts");
    expect(pkg.scripts["test:model-insight"]).toBe("tsx scripts/verify-model-insight.ts");
    expect(pkg.scripts["test:checkin"]).toBe("tsx scripts/verify-checkin.ts");
    expect(pkg.scripts["test:invitation"]).toBe("tsx scripts/verify-invitation.ts");
  });
  it("covers every browser script exactly once, including explicit query-focus consent", async () => {
    const m = await runner();
    const suites = Object.values(m.BROWSER_GROUPS).flat() as any[];
    expect(suites.map((s) => s.script).sort()).toEqual(
      Object.keys(pkg.scripts).filter((s) => s.startsWith("test:") && s !== "test:docker").sort(),
    );
    expect(new Set(suites.map((s) => s.script)).size).toBe(suites.length);
    expect(suites.find((s) => s.script === "test:query-focus").args).toEqual(["--ready"]);
    expect(suites.find((s) => s.script === "test:model-insight").args).toEqual(["--ready"]);
    expect(suites.find((s) => s.script === "test:checkin").args).toEqual(["--ready"]);
    expect(suites.find((s) => s.script === "test:invitation").args).toEqual(["--ready"]);
    for (const suite of suites) {
      expect(existsSync(resolve(root, suite.file))).toBe(true);
      expect(pkg.scripts[suite.script]).toBe(`tsx ${suite.file}`);
    }
  });
  it("rejects unknown groups before invoking any process", async () => {
    const m = await runner();
    expect(() => m.getGroup("unknown")).toThrow(/Unknown/);
  });
  it("runs suites in order and stops on the first failing suite", async () => {
    const m = await runner();
    const called: string[] = [];
    await expect(m.runGroup("interface", async (suite: any) => {
      called.push(suite.script);
      if (called.length === 2) throw new Error("fixture failure");
    })).rejects.toThrow("fixture failure");
    expect(called).toEqual(m.getGroup("interface").slice(0, 2).map((s: any) => s.script));
  });
  it("wires read-only, SHA-pinned, PR-safe CI and every browser group", () => {
    const file = ".github/workflows/ci.yml";
    expect(existsSync(resolve(root, file)), "CI workflow is missing").toBe(true);
    const ci = read(file);
    expect(ci).toMatch(/pull_request:/);
    expect(ci).toMatch(/push:/);
    expect(ci).not.toMatch(/pull_request_target|secrets\./);
    expect(ci).toMatch(/contents: read/);
    expect(ci).toMatch(/cancel-in-progress: true/);
    expect(ci).toMatch(/RELAYDOCK_MAP_GESTURES: ["']1["']/);
    for (const command of ["npm ci", "npm test", "npm run typecheck -- --incremental false", "npm run build", "npm run ci:browser", "npm run test:docker -- --ready"])
      expect(ci).toContain(command);
    expect(ci).toMatch(/group: \[interface, query, management\]/);
    expect(ci.match(/timeout-minutes:/g)?.length).toBeGreaterThanOrEqual(3);
    const uses = [...ci.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((v) => /^actions\/[\w-]+@[a-f0-9]{40}$/.test(v))).toBe(true);
    expect(ci).toContain("path: relaydock");
    expect(ci).toContain("cache-dependency-path: relaydock/package-lock.json");
  });
  it("includes three privacy-aware issue forms and a release checklist", () => {
    for (const form of ["bug-report.yml", "feature-request.yml", "platform-adapter.yml"]) {
      const path = `.github/ISSUE_TEMPLATE/${form}`;
      expect(existsSync(resolve(root, path)), `${form} is missing`).toBe(true);
      const text = read(path);
      expect(text).toContain("type: checkboxes");
      expect(text).toContain("required: true");
      expect(text).toContain("凭据");
    }
    for (const file of ["CHANGELOG.md", "docs/RELEASE-CHECKLIST.md", "docs/DOCKER-VERIFICATION.md", "docs/SCREENSHOTS.md"])
      expect(existsSync(resolve(root, file)), `${file} is missing`).toBe(true);
  });
  it("publishes actual fixture UI screenshots, not environment files or logs", () => {
    for (const name of ["atlas-light.webp", "atlas-dark.webp", "atlas-mobile.webp"])
      expect(existsSync(resolve(root, "docs/images", name)), `${name} is missing`).toBe(true);
    const doc = read("docs/SCREENSHOTS.md");
    expect(doc).toContain("合成");
    expect(doc).toContain("389p5kcDHjEOSCtq8KsVo");
  });
  it("keeps fixture/live evidence distinct and excludes secrets from Docker context", () => {
    expect(read("README.md")).toContain("实站未验证");
    const ignore = read(".dockerignore");
    for (const rule of ["**/.env*", "**/*.sqlite*", "**/vault.key", ".git", "data", "output"])
      expect(ignore.split(/\r?\n/)).toContain(rule);
  });
});
