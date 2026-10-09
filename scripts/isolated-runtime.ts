import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
export function cleanRuntimeEnv(
  input: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const key of [
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "PATH",
    "Path",
    "PATHEXT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
  ])
    if (input[key] !== undefined) env[key] = input[key];
  return env;
}
export function copyIsolatedBuild(root: string, runtime: string): void {
  const source = join(root, ".next"),
    target = join(runtime, ".next");
  mkdirSync(target, { recursive: true });
  const safeFile = (path: string) =>
    !/^\.env(?:\.|$)/i.test(basename(path)) &&
    !/\.(?:sqlite|sqlite3|db)(?:-wal|-shm)?$/i.test(path);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (
      ["server", "static", "node_modules"].includes(entry.name) ||
      (entry.isFile() &&
        (entry.name === "BUILD_ID" || /\.(?:json|js)$/.test(entry.name)))
    )
      cpSync(join(source, entry.name), join(target, entry.name), {
        recursive: true,
        dereference: true,
        filter: safeFile,
      });
  }
  if (existsSync(join(root, "public")))
    cpSync(join(root, "public"), join(runtime, "public"), {
      recursive: true,
      filter: safeFile,
    });
  symlinkSync(
    join(root, "node_modules"),
    join(runtime, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.ok(!readdirSync(runtime).some((name) => /^\.env(?:\.|$)/i.test(name)));
}
