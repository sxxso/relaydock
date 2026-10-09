import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const suite = (name, file, args = []) => Object.freeze({ script: `test:${name}`, file: `scripts/verify-${file}.ts`, args: Object.freeze(args) });
export const BROWSER_GROUPS = Object.freeze({
  interface: Object.freeze([suite("e2e", "ui"), suite("interactions", "interactions"), suite("wizard", "wizard"), suite("freshness", "freshness"), suite("unit-density", "unit-density")]),
  query: Object.freeze([suite("platforms", "platforms"), suite("diagnostics", "diagnostics"), suite("drag-query", "drag-query"), suite("query-routing", "query-routing"), suite("query-focus", "query-focus", ["--ready"]), suite("model-insight", "model-insight", ["--ready"])]),
  management: Object.freeze([suite("management", "management"), suite("group-layout", "group-layout"), suite("checkin", "checkin", ["--ready"]), suite("invitation", "invitation", ["--ready"])]),
});
export function getGroup(name) {
  if (!Object.hasOwn(BROWSER_GROUPS, name)) throw new Error("Unknown browser group; use interface, query, or management");
  return BROWSER_GROUPS[name];
}
export async function runGroup(name, invoke) {
  for (const entry of getGroup(name)) await invoke(entry);
}
function cleanEnv() {
  const env = { NEXT_TELEMETRY_DISABLED: "1" };
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
async function main() {
  const [group, ...extra] = process.argv.slice(2);
  if (group === "--help") { console.log("Usage: npm run ci:browser -- interface|query|management (requires a fresh build and Chromium)"); return; }
  assert.equal(extra.length, 0, "Pass exactly one browser group");
  getGroup(group);
  const root = resolve(process.cwd());
  assert.equal(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).name, "relaydock-atlas");
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  await runGroup(group, async (entry) => {
    console.log(`\n[CI browser] ${entry.script}`);
    await new Promise((done, fail) => {
      const child = spawn(process.execPath, [tsx, resolve(root, entry.file), ...entry.args], { cwd: root, windowsHide: true, stdio: "inherit", env: cleanEnv() });
      child.once("error", () => fail(new Error(`Could not start ${entry.script}`)));
      child.once("exit", (code, signal) => code === 0 && !signal ? done() : fail(new Error(`${entry.script} failed (exit ${code ?? signal})`)));
    });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
