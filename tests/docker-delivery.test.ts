import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
async function helper() {
  const file = resolve("scripts/docker-smoke-lib.mjs");
  expect(existsSync(file), "Docker safety helper is missing").toBe(true);
  return import(pathToFileURL(file).href);
}
describe("Docker delivery safety boundaries", () => {
  it("accepts only one explicit IPv4 loopback binding and a valid port", async () => {
    const m = await helper();
    expect(m.parseLoopbackBinding("127.0.0.1:49152\n")).toBe("http://127.0.0.1:49152");
    for (const input of ["0.0.0.0:49152", "[::]:49152", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:10\n0.0.0.0:10", "localhost:3000"])
      expect(() => m.parseLoopbackBinding(input)).toThrow();
  });
  it("generates only owned names and rejects unexpected resource kinds/tokens", async () => {
    const m = await helper();
    expect(m.resourceName("012345abcdef", "data")).toBe("relaydock-smoke-012345abcdef-data");
    for (const [token, kind] of [["../real", "data"], ["012345abcdef", "production"], ["012345abcdef", "data;rm"]])
      expect(() => m.resourceName(token, kind)).toThrow();
  });
  it("rejects secret-bearing names before any file read", async () => {
    const m = await helper();
    for (const name of [".env", ".env.local", ".env.production", ".env.example", ".envrc", "atlas.sqlite", "atlas.sqlite-wal", "atlas.db-shm", "vault.key", "key.pem", "credentials.json", "node_modules", ".git", "data"])
      expect(m.deniedSourceName(name), name).toBe(true);
    for (const name of ["route.ts", "page.tsx", "logo.svg", "package-lock.json"])
      expect(m.deniedSourceName(name), name).toBe(false);
  });
  it("copies only explicit build sources and cleans only its owned context", async () => {
    const m = await helper();
    const parent = mkdtempSync(join(tmpdir(), "atlas-delivery-test-"));
    const root = join(parent, "source");
    mkdirSync(root); mkdirSync(join(root, "src")); mkdirSync(join(root, "public"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "doctor.mjs"), "offline-cli-fixture");
    writeFileSync(join(root, "scripts", "doctor-lib.mjs"), "offline-lib-fixture");
    writeFileSync(join(root, "scripts", "private-config.json"), "PRIVATE");
    writeFileSync(join(root, "scripts", ".env.local"), "PRIVATE");
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
    const fixtureLicense = "MIT License\n\nCopyright (c) 2026 synthetic-fixture-owner\n";
    writeFileSync(join(root, "LICENSE"), fixtureLicense);
    writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), "synthetic third-party notices");
    writeFileSync(join(root, "src", "page.tsx"), "fixture");
    writeFileSync(join(root, "src", "nested.sqlite"), "PRIVATE");
    writeFileSync(join(root, ".env.local"), "PRIVATE");
    writeFileSync(join(root, "private.key"), "PRIVATE");
    let ctx: any;
    try {
      ctx = m.createDockerContext(root, parent);
      expect(dirname(ctx.dir)).toBe(parent);
      expect(basename(ctx.dir)).toMatch(/^relaydock-docker-context-/);
      expect(readFileSync(join(ctx.dir, "src", "page.tsx"), "utf8")).toBe("fixture");
      expect(existsSync(join(ctx.dir, "LICENSE")), "isolated Docker context must retain the license").toBe(true);
      expect(readFileSync(join(ctx.dir, "LICENSE"), "utf8")).toBe(fixtureLicense);
      expect(readFileSync(join(ctx.dir, "THIRD-PARTY-NOTICES.md"), "utf8")).toBe("synthetic third-party notices");
      expect(existsSync(join(ctx.dir, ".env.local"))).toBe(false);
      expect(existsSync(join(ctx.dir, "private.key"))).toBe(false);
      expect(readdirSync(join(ctx.dir, "src"))).toEqual(["page.tsx"]);
      expect(existsSync(join(ctx.dir, "scripts", "doctor.mjs")), "Docker context must ship the offline doctor").toBe(true);
      expect(readFileSync(join(ctx.dir, "scripts", "doctor-lib.mjs"), "utf8")).toBe("offline-lib-fixture");
      expect(readdirSync(join(ctx.dir, "scripts")).sort()).toEqual(["doctor-lib.mjs", "doctor.mjs"]);
      expect(() => m.cleanupDockerContext({ ...ctx, dir: root })).toThrow();
      expect(existsSync(join(root, ".env.local"))).toBe(true);
      m.cleanupDockerContext(ctx); expect(existsSync(ctx.dir)).toBe(false); ctx = undefined;
    } finally {
      if (ctx && existsSync(ctx.dir)) m.cleanupDockerContext(ctx);
      expect(dirname(parent)).toBe(tmpdir());
      expect(basename(parent)).toMatch(/^atlas-delivery-test-/);
      rmSync(parent, { recursive: true, force: true });
    }
  });
  it("refuses linked sources rather than following files outside the application", async () => {
    const m = await helper();
    const parent = mkdtempSync(join(tmpdir(), "atlas-delivery-test-"));
    const root = join(parent, "source"), external = join(parent, "external");
    mkdirSync(root); mkdirSync(join(root, "src")); mkdirSync(external);
    writeFileSync(join(external, "outside.ts"), "PRIVATE");
    symlinkSync(external, join(root, "src", "linked"), process.platform === "win32" ? "junction" : "dir");
    try {
      expect(() => m.createDockerContext(root, parent)).toThrow(/link|junction/i);
      expect(readFileSync(join(external, "outside.ts"), "utf8")).toBe("PRIVATE");
      expect(readdirSync(parent).filter((s) => s.startsWith("relaydock-docker-context-"))).toEqual([]);
    } finally {
      expect(dirname(parent)).toBe(tmpdir());
      expect(basename(parent)).toMatch(/^atlas-delivery-test-/);
      rmSync(parent, { recursive: true, force: true });
    }
  });
  it("rejects credentials and any fixture secrets in data-only backups", async () => {
    const m = await helper();
    expect(() => m.assertDataOnlyBackup({ accounts: [{ name: "demo" }], snapshots: [] }, ["fixture-secret"])).not.toThrow();
    for (const backup of [{ accounts: [{ credential: "hidden" }] }, { vaultKey: "hidden" }, { adminHash: "hidden" }, { nested: { name: "fixture-secret" } }])
      expect(() => m.assertDataOnlyBackup(backup, ["fixture-secret"])).toThrow();
  });
});
it("owns and labels the short-lived migration helper as well as app containers", async () => {
  const m = await helper();
  expect(m.resourceName("012345abcdef", "copy")).toBe("relaydock-smoke-012345abcdef-copy");
  const script = readFileSync(resolve("scripts/verify-docker.mjs"), "utf8");
  expect(script.includes('"--name", names.copy, "--label", `${label}=${token}`')).toBe(true);
  expect(script.includes('["container", names.copy]')).toBe(true);
});

it("refreshes the owned container binding after restart instead of reusing the old origin", async () => {
  const m = await helper();
  expect(typeof m.readPublishedOrigin).toBe("function");
  const bindings = ["127.0.0.1:49152", "127.0.0.1:49201"];
  const commands: string[][] = [];
  const docker = async (args: string[]) => { commands.push(args); return bindings.shift()!; };
  expect(await m.readPublishedOrigin(docker, "relaydock-smoke-012345abcdef-app")).toBe("http://127.0.0.1:49152");
  expect(await m.readPublishedOrigin(docker, "relaydock-smoke-012345abcdef-app")).toBe("http://127.0.0.1:49201");
  expect(commands).toEqual(Array(2).fill(["port", "relaydock-smoke-012345abcdef-app", "3000/tcp"]));
  const script = readFileSync(resolve("scripts/verify-docker.mjs"), "utf8");
  expect(/docker\(\["start", names\.app\]\);\s*origin = await readPublishedOrigin\(docker, names\["app-gateway"\]\)/.test(script)).toBe(true);
});
it("ignores only exact owned-resource absence, never Docker context or connection failures", async () => {
  const m = await helper();
  expect(typeof m.isMissingOwnedResource).toBe("function");
  const prefix = "relaydock-smoke-012345abcdef-";
  for (const [type, name, stderr] of [
    ["container", prefix + "app", "Error: No such container: " + prefix + "app"],
    ["container", prefix + "copy", "Error: No such object: " + prefix + "copy"],
    ["volume", prefix + "data", "Error response from daemon: get " + prefix + "data: no such volume"],
    ["network", prefix + "network", "Error response from daemon: network " + prefix + "network not found"],
    ["image", prefix + "image", "Error response from daemon: No such image: " + prefix + "image:latest"],
  ]) expect(m.isMissingOwnedResource({ stderr }, type, name)).toBe(true);
  for (const stderr of [
    'unable to resolve docker endpoint: context "unavailable" not found',
    'error during connect: context "unavailable" not found',
    'Cannot connect to the Docker daemon',
    'Error: No such container: someone-elses-container',
    'Error response from daemon: network another-network not found',
    'Error: failed to inspect resource: not found',
    'context not found\nError: No such container: ' + prefix + 'app',
  ]) expect(m.isMissingOwnedResource({ stderr }, "container", prefix + "app")).toBe(false);
  expect(m.isMissingOwnedResource({}, "container", prefix + "app")).toBe(false);
});
it("retains the application license in the final non-root runtime image", () => {
  const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
  const runtime = dockerfile.split(/^FROM [^\r\n]+ AS runtime\r?\n/m)[1];
  expect(runtime, "runtime stage is missing").toBeDefined();
  expect(runtime).toMatch(/^COPY --from=build --chown=node:node \/app\/LICENSE \.\/LICENSE$/m);
});

it("publishes only an owned loopback gateway and attaches it before starting", async () => {
  const m = await helper();
  const prefix = "relaydock-smoke-012345abcdef-";
  const commands: string[][] = [];
  await m.startLoopbackGateway(async (args: string[]) => { commands.push(args); return ""; }, {
    name: prefix + "app-gateway", target: prefix + "app", image: prefix + "image",
    internalNetwork: prefix + "network", ingressNetwork: prefix + "ingress", label: "relaydock.smoke.run=012345abcdef",
  });
  expect(commands[0].slice(0, 13)).toEqual(["create", "--name", prefix + "app-gateway", "--label", "relaydock.smoke.run=012345abcdef", "--network", prefix + "ingress", "--read-only", "--cap-drop", "ALL", "--publish", "127.0.0.1::3000", "--entrypoint"]);
  expect(commands[0].at(-1)).toBe(prefix + "app");
  expect(commands.slice(1)).toEqual([["network", "connect", prefix + "network", prefix + "app-gateway"], ["start", prefix + "app-gateway"]]);
  expect(await m.readPublishedOrigin(async () => "127.0.0.1:49152", prefix + "app-gateway")).toBe("http://127.0.0.1:49152");
  expect(m.isMissingOwnedResource({ stderr: "Error: No such container: " + prefix + "app-gateway" }, "container", prefix + "app-gateway")).toBe(true);
});

