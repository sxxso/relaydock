import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertDataOnlyBackup, cleanupDockerContext, createDockerContext, readPublishedOrigin, isMissingOwnedResource, resourceName } from "./docker-smoke-lib.mjs";

const exec = promisify(execFile);
const args = process.argv.slice(2);
if (args.some((v) => !["--ready", "--help"].includes(v))) {
  console.error("Only --ready/--help are accepted"); process.exitCode = 1;
} else if (!args.includes("--ready") || args.includes("--help")) {
  console.log(JSON.stringify({ status: "WAITING_READY", dockerVerified: false, command: "npm run test:docker -- --ready", checks: ["fresh-image", "non-root", "loopback-only", "manual-local-fixture-query", "restart-persistence", "database-and-key-migration", "data-only-backup", "owned-resource-cleanup"] }, null, 2));
} else {
  await main();
}
async function main() {
  const root = realpathSync(resolve(process.cwd()));
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name, "relaydock-atlas", "Run inside the application");
  const token = randomBytes(6).toString("hex");
  const names = Object.fromEntries(["app", "restored", "fixture", "network", "data", "migration", "copy", "image"].map((kind) => [kind, resourceName(token, kind)]));
  const label = "relaydock.smoke.run";
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  const report = { status: "RUNNING", checkedAt: new Date().toISOString(), dockerVerified: false, realProvidersQueried: false, realDeploymentRead: false, checks: [], cleanupErrors: [] };
  let ctx, ready = false, step = "docker-availability";
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  const docker = async (command, timeout = 60000, cleanup = false) => {
    const result = await exec("docker", command, { cwd: root, env, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout, signal: cleanup ? undefined : abort.signal });
    return result.stdout.trim();
  };
  const check = async (name, task) => { step = name; await task(); report.checks.push({ name, status: "PASS" }); };
  const password = `fixture-admin-${randomBytes(18).toString("hex")}`;
  const credential = `fixture-query-${randomBytes(18).toString("hex")}`;
  let cookie = "", csrf = "", origin = "", accountId = "";
  const api = async (path, method = "GET", body) => {
    const headers = { origin, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${origin}/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
    assert.equal(response.ok, true, `Local fixture API failed at ${path.split("/")[0]} (HTTP ${response.status})`);
    return { response, data: await response.json() };
  };
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      if (abort.signal.aborted) throw new Error("Canceled");
      try { const response = await fetch(`${origin}/api/auth/session`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch {}
      await new Promise((done) => setTimeout(done, 300));
    }
    throw new Error("Local container did not become ready");
  };
  const login = async () => {
    cookie = ""; csrf = "";
    const { response, data } = await api("auth/login", "POST", { password });
    const setCookie = response.headers.getSetCookie().find((v) => v.startsWith("atlas_session="));
    assert.ok(setCookie, "No fixture session cookie");
    cookie = setCookie.split(";")[0]; csrf = data.csrf;
    assert.match(csrf, /^[a-f0-9]{48}$/);
  };
  const fixtureHits = async () => Number(await docker(["exec", names.fixture, "node", "-e", 'fetch("http://127.0.0.1:4010/hits").then(r=>r.json()).then(x=>console.log(x.hits))']));
  const startApp = async (kind, volume) => {
    await docker(["run", "--detach", "--name", names[kind], "--label", `${label}=${token}`, "--network", names.network, "--mount", `type=volume,src=${volume},dst=/app/data`, "--publish", "127.0.0.1::3000", "--env-file", join(ctx.dir, ".env.smoke"), names.image]);
    origin = await readPublishedOrigin(docker, names[kind]);
    await wait(); await login();
  };
  try {
    try { report.dockerVersion = await docker(["version", "--format", "{{.Server.Version}}"], 15000); assert.ok(report.dockerVersion); ready = true; }
    catch { report.status = "BLOCKED"; report.reason = "DOCKER_CLI_OR_DAEMON_UNAVAILABLE"; process.exitCode = 2; return; }
    await check("fresh-image-from-source-whitelist", async () => {
      ctx = createDockerContext(root);
      report.sourceFiles = ctx.copiedFiles;
      await docker(["build", "--label", `${label}=${token}`, "--tag", names.image, ctx.dir], 20 * 60 * 1000);
      report.imageId = await docker(["image", "inspect", "--format", "{{.Id}}", names.image]);
    });
    await check("owned-internal-network-and-volumes", async () => {
      await docker(["network", "create", "--internal", "--label", `${label}=${token}`, names.network]);
      for (const volume of [names.data, names.migration]) await docker(["volume", "create", "--label", `${label}=${token}`, volume]);
      assert.equal(await docker(["network", "inspect", "--format", "{{.Internal}}", names.network]), "true");
      writeFileSync(join(ctx.dir, ".env.smoke"), `RELAYDOCK_ADMIN_PASSWORD=${password}\nRELAYDOCK_PRIVATE_HOSTS=${names.fixture}\nRELAYDOCK_PUBLIC_URL=\nRELAYDOCK_DNS_MODE=system\nNEXT_TELEMETRY_DISABLED=1\n`, { mode: 0o600, flag: "wx" });
      writeFileSync(join(ctx.dir, ".env.fixture"), `FIXTURE_KEY=${credential}\n`, { mode: 0o600, flag: "wx" });
      const code = 'let hits=0;require("node:http").createServer((req,res)=>{res.setHeader("content-type","application/json");if(req.url==="/hits"){res.end(JSON.stringify({hits}));return;}hits++;if(req.url!=="/balance"||req.headers.authorization!=="Bearer "+process.env.FIXTURE_KEY){res.statusCode=401;res.end("{}");return;}res.end(JSON.stringify({data:{amount:"1200",used:"100"}}));}).listen(4010,"0.0.0.0");';
      await docker(["run", "--detach", "--read-only", "--name", names.fixture, "--label", `${label}=${token}`, "--network", names.network, "--env-file", join(ctx.dir, ".env.fixture"), "--entrypoint", "node", names.image, "-e", code]);
      // Probe only the owned fixture; its status endpoint does not count as a balance query.
      for (let i = 0; ; i++) { try { assert.equal(await fixtureHits(), 0); break; } catch (error) { if (i >= 30) throw error; await new Promise((done) => setTimeout(done, 200)); } }
    });
    await check("local-login-non-root-and-no-automatic-query", async () => {
      await startApp("app", names.data);
      assert.notEqual(await docker(["exec", names.app, "id", "-u"]), "0");
      assert.equal(await fixtureHits(), 0);
      const { data } = await api("accounts", "POST", { name: "Docker synthetic account", siteUrl: `http://${names.fixture}:4010`, managementUrl: `http://${names.fixture}:4010`, provider: "custom", unit: "USD", credential, query: { path: "/balance", balancePath: "data.amount", subtractPath: "data.used", divisor: "100", authHeader: "Authorization", timeoutSeconds: 10 } });
      accountId = data.id; assert.ok(accountId);
      assert.equal(data.balance, null); assert.equal(await fixtureHits(), 0);
    });
    await check("explicit-local-fixture-refresh", async () => {
      const { data } = await api(`accounts/${accountId}/sync`, "POST", {});
      assert.equal(data.balance, "11"); assert.equal(await fixtureHits(), 1);
    });
    await check("encrypted-credential-and-balance-survive-restart", async () => {
      await docker(["stop", "--time", "10", names.app]); await docker(["start", names.app]);
      origin = await readPublishedOrigin(docker, names.app);
      await wait(); await login();
      const { data } = await api("accounts");
      assert.equal(data.accounts.find((a) => a.id === accountId)?.balance, "11");
      const sync = await api(`accounts/${accountId}/sync`, "POST", {});
      assert.equal(sync.data.balance, "11"); assert.equal(await fixtureHits(), 2);
    });
    await check("stopped-database-and-master-key-volume-migration", async () => {
      await docker(["stop", "--time", "10", names.app]);
      await docker(["run", "--rm", "--name", names.copy, "--label", `${label}=${token}`, "--network", "none", "--user", "0", "--mount", `type=volume,src=${names.data},dst=/from,readonly`, "--mount", `type=volume,src=${names.migration},dst=/to`, "--entrypoint", "sh", names.image, "-c", "cp -a /from/. /to/"]);
      await startApp("restored", names.migration);
      assert.notEqual(await docker(["exec", names.restored, "id", "-u"]), "0");
      const { data } = await api("accounts");
      assert.equal(data.accounts.find((a) => a.id === accountId)?.balance, "11");
      const sync = await api(`accounts/${accountId}/sync`, "POST", {});
      assert.equal(sync.data.balance, "11"); assert.equal(await fixtureHits(), 3);
    });
    await check("data-backup-excludes-all-fixture-secrets", async () => {
      const { data } = await api("backup/export");
      assertDataOnlyBackup(data, [credential, password]);
      assert.equal(data.accounts.length, 1); assert.equal(data.snapshots.length, 3);
      report.fixtureBalanceRequests = await fixtureHits();
    });
    report.status = "PASS";
  } catch {
    report.status = abort.signal.aborted ? "CANCELED" : "FAIL";
    report.failedCheck = step;
    report.checks.push({ name: step, status: "FAIL" });
    process.exitCode = 1;
  } finally {
    // Inspect ownership labels even after partial failures; never prune, enumerate, or delete user resources.
    if (ready) {
      for (const [type, name] of [["container", names.copy], ["container", names.app], ["container", names.restored], ["container", names.fixture], ["volume", names.data], ["volume", names.migration], ["network", names.network], ["image", names.image]]) {
        try {
          let owner;
          try { owner = await docker([type, "inspect", "--format", `{{ index ${["container", "image"].includes(type) ? ".Config.Labels" : ".Labels"} "${label}" }}`, name], 15000, true); }
          catch (error) { if (isMissingOwnedResource(error, type, name)) continue; throw error; }
          assert.equal(owner, token, "Refuse to clean a foreign resource");
          await docker([type, "rm", ...(type === "container" ? ["--force"] : []), name], 30000, true);
        } catch { report.cleanupErrors.push(type); }
      }
    }
    if (ctx) { try { cleanupDockerContext(ctx); } catch { report.cleanupErrors.push("source-context"); } }
    if (report.cleanupErrors.length) { report.status = "FAIL"; process.exitCode = 1; }
    report.dockerVerified = report.status === "PASS";
    const out = join(root, "output", "docker");
    for (const dir of [join(root, "output"), out]) {
      if (!existsSync(dir)) mkdirSync(dir);
      assert.ok(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink() && realpathSync(dir) === dir, "Refuse linked report directory");
    }
    const reportFile = join(out, "verification.json");
    if (existsSync(reportFile)) assert.ok(lstatSync(reportFile).isFile() && !lstatSync(reportFile).isSymbolicLink(), "Refuse linked report file");
    writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted);
  }
}