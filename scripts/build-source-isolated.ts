import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { cleanRuntimeEnv } from "./isolated-runtime";

// Never use copyIsolatedBuild: this helper always builds a NEW source snapshot.
// No npm install, .env loading, repo .next, service discovery/termination or Git writes.
const prefix = "relaydock-query-focus-";
const directories = ["src", "tests", "scripts", "public"];
const files = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "next.config.ts",
  "tsconfig.json",
  "next-env.d.ts",
  "postcss.config.mjs",
  "postcss.config.js",
  "postcss.config.ts",
  "vitest.config.ts",
];
const denied = (name: string) =>
  /^\.env/i.test(name) ||
  /^(?:data|vault|credentials(?:\..*)?|node_modules|\.next|\.git|\.agents|\.codex)$/i.test(
    name,
  ) ||
  /\.(?:sqlite3?|db)(?:-wal|-shm)?$|^(?:vault\.key|credentials)$/i.test(name) ||
  /\.(?:pem|pfx|p12|key)$/i.test(name);

export type IsolatedSource = {
  root: string;
  temp: string;
  runtime: string;
  dataDir: string;
  depsTarget: string;
  tempParent: string;
  sourceFingerprint: string;
  copiedFiles: number;
  copiedBytes: number;
  buildChild?: ChildProcess;
};

function contained(parent: string, child: string) {
  const part = relative(parent, child);
  assert.ok(
    part && !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep),
    "Path must be strictly inside its owned parent",
  );
}

export function boundedLog(limit = 32 * 1024) {
  let head = "",
    tail = "",
    bytes = 0;
  return {
    add(chunk: Buffer | string) {
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      const available = Math.max(0, limit / 2 - head.length);
      head += text.slice(0, available);
      tail = (tail + text.slice(available)).slice(-limit / 2);
    },
    text: () =>
      head +
      (bytes > limit ? "\n[log truncated: bounded head/tail]\n" : "") +
      tail,
    bytes: () => bytes,
  };
}

/** Webpack cannot resolve a Windows entry that crosses a dependency drive. */
export function isolatedSourceParent(
  root: string,
  depsTarget: string,
  systemTemp: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return systemTemp;
  const volume = (path: string) => win32.parse(path).root.toLowerCase();
  if (volume(systemTemp) === volume(depsTarget)) return systemTemp;
  assert.equal(
    volume(root),
    volume(depsTarget),
    "Cannot create an approved isolated source on the dependency volume",
  );
  return win32.join(root, "output", "isolated-builds");
}

export function createIsolatedSource(rootInput: string): IsolatedSource {
  const root = realpathSync(resolve(rootInput)),
    depsTarget = realpathSync(join(root, "node_modules"));
  const parentPath = isolatedSourceParent(
    root,
    depsTarget,
    realpathSync(tmpdir()),
  );
  // Cross-volume fallback is confined to this project's output directory.
  if (parentPath !== realpathSync(tmpdir())) {
    contained(root, parentPath);
    mkdirSync(parentPath, { recursive: true });
    assert.equal(
      realpathSync(parentPath),
      resolve(parentPath),
      "Refuse a linked output directory",
    );
  }
  const tempParent = realpathSync(parentPath);
  assert.ok(lstatSync(depsTarget).isDirectory());
  assert.ok(existsSync(join(depsTarget, "next", "dist", "bin", "next")));
  const temp = realpathSync(mkdtempSync(join(tempParent, prefix))),
    runtime = join(temp, "runtime"),
    dataDir = join(temp, "fixture-data");
  assert.equal(dirname(temp), tempParent);
  assert.ok(basename(temp).startsWith(prefix));
  assert.notEqual(temp, root);
  mkdirSync(runtime);
  mkdirSync(dataDir);
  const digest = createHash("sha256");
  let copiedFiles = 0,
    copiedBytes = 0;
  const copy = (source: string, destination: string) => {
    if (denied(basename(source))) return; // Before stat/read, including .env.example.
    contained(root, source);
    contained(runtime, destination);
    const stat = lstatSync(source);
    assert.ok(
      !stat.isSymbolicLink(),
      "Source whitelist must not contain reparse points: " +
        relative(root, source),
    );
    contained(root, realpathSync(source));
    if (stat.isDirectory()) {
      mkdirSync(destination);
      for (const entry of readdirSync(source).sort())
        if (!denied(entry)) copy(join(source, entry), join(destination, entry));
    } else {
      assert.ok(stat.isFile(), "Only regular source files may be copied");
      const content = readFileSync(source),
        after = lstatSync(source);
      assert.equal(
        after.size,
        stat.size,
        "Source changed during snapshot; wait for ready again",
      );
      assert.equal(
        after.mtimeMs,
        stat.mtimeMs,
        "Source changed during snapshot; wait for ready again",
      );
      writeFileSync(destination, content, { flag: "wx" });
      digest.update(relative(root, source).split(sep).join("/") + "\0");
      digest.update(createHash("sha256").update(content).digest());
      copiedFiles++;
      copiedBytes += content.length;
    }
  };
  const owned: IsolatedSource = {
    root,
    temp,
    runtime,
    dataDir,
    depsTarget,
    tempParent,
    sourceFingerprint: "",
    copiedFiles: 0,
    copiedBytes: 0,
  };
  try {
    for (const name of [...directories, ...files])
      if (existsSync(join(root, name)))
        copy(join(root, name), join(runtime, name));
    assert.ok(existsSync(join(runtime, "package.json")));
    assert.ok(existsSync(join(runtime, "src", "app", "page.tsx")));
    assert.ok(
      !existsSync(join(runtime, ".next")),
      "A fresh build must start without .next",
    );
    symlinkSync(
      depsTarget,
      join(runtime, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(realpathSync(join(runtime, "node_modules")), depsTarget);
    return {
      ...owned,
      sourceFingerprint: digest.digest("hex"),
      copiedFiles,
      copiedBytes,
    };
  } catch (error) {
    cleanupIsolatedSource(owned);
    throw error;
  }
}

export async function stopOwnedChild(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  // Only the exact ChildProcess returned by OUR spawn. Never taskkill by port/name/tree.
  const exited = new Promise<void>((ok) => child.once("exit", () => ok()));
  child.kill();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, fail) => {
        timer = setTimeout(
          () => fail(new Error("Owned child did not exit; retain its runtime")),
          8000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function buildIsolatedSource(
  owned: IsolatedSource,
  envInput: NodeJS.ProcessEnv,
  log: ReturnType<typeof boundedLog>,
  signal?: AbortSignal,
) {
  assert.equal(realpathSync(owned.runtime), join(owned.temp, "runtime"));
  assert.ok(
    !existsSync(join(owned.runtime, ".next")),
    "Refuse to reuse any build",
  );
  const startedAt = Date.now();
  // Webpack supports a Windows dependency junction outside the temporary source root.
  // Calling Node directly avoids .cmd shells, npm lifecycle scripts and visible windows.
  const child = spawn(
    process.execPath,
    [join(owned.depsTarget, "next/dist/bin/next"), "build", "--webpack"],
    {
      cwd: owned.runtime,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...cleanRuntimeEnv(envInput),
        NEXT_TELEMETRY_DISABLED: "1",
        RELAYDOCK_DATA_DIR: owned.dataDir,
        RELAYDOCK_VAULT_KEY: "ab".repeat(32),
        RELAYDOCK_DNS_MODE: "system",
      },
    },
  );
  owned.buildChild = child;
  child.stdout!.on("data", (b: Buffer) => log.add(b));
  child.stderr!.on("data", (b: Buffer) => log.add(b));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    void stopOwnedChild(child).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    const code = await new Promise<number | null>((ok, fail) => {
      child.once("error", fail);
      child.once("exit", ok);
      timeout = setTimeout(() => {
        abort();
        fail(new Error("Isolated production build timed out"));
      }, 240_000);
    });
    assert.equal(
      code,
      0,
      "NEW isolated next build failed; never fall back to the repository build",
    );
    assert.ok(!signal?.aborted, "Build canceled");
    const buildFile = join(owned.runtime, ".next", "BUILD_ID"),
      buildId = readFileSync(buildFile, "utf8").trim();
    assert.ok(
      buildId && lstatSync(buildFile).mtimeMs >= startedAt - 1000,
      "BUILD_ID must have been generated by this build",
    );
    for (const name of [
      "build-manifest.json",
      "prerender-manifest.json",
      "server",
    ])
      assert.ok(
        existsSync(join(owned.runtime, ".next", name)),
        "Missing production build artifact: " + name,
      );
    return {
      buildId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: code,
      command: "next build --webpack",
      childPid: child.pid,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    await stopOwnedChild(child);
  }
}

export function cleanupIsolatedSource(owned: IsolatedSource) {
  assert.ok(
    !owned.buildChild?.pid ||
      owned.buildChild.exitCode !== null ||
      owned.buildChild.signalCode !== null,
    "Retain source/runtime while its owned build process is still alive",
  );
  const target = resolve(owned.temp),
    parentPath = isolatedSourceParent(
      owned.root,
      owned.depsTarget,
      realpathSync(tmpdir()),
    ),
    parent = realpathSync(parentPath);
  assert.equal(
    parent,
    resolve(parentPath),
    "Refuse a changed temporary parent",
  );
  assert.ok(isAbsolute(target));
  assert.equal(parent, owned.tempParent);
  assert.equal(dirname(target), parent);
  assert.ok(
    basename(target).startsWith(prefix) &&
      basename(target).length > prefix.length,
  );
  assert.notEqual(target, owned.root);
  assert.notEqual(target, resolve(owned.root, "data"));
  assert.equal(
    realpathSync(target),
    target,
    "Owned temp root must not become a junction",
  );
  assert.equal(resolve(owned.runtime), join(target, "runtime"));
  const link = join(target, "runtime", "node_modules");
  contained(target, link);
  // Verify BOTH canonical targets immediately before unlinking the owned junction.
  assert.equal(
    realpathSync(join(owned.root, "node_modules")),
    owned.depsTarget,
  );
  try {
    assert.ok(
      lstatSync(link).isSymbolicLink(),
      "Refuse to remove a non-junction dependency tree",
    );
    assert.equal(
      realpathSync(link),
      owned.depsTarget,
      "Dependency junction target changed; retain temp",
    );
    unlinkSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // lstat + unlink/rmdir only: never recursively follow ANY link, even in standalone output.
  const remove = (entry: string) => {
    if (entry !== target) contained(target, entry);
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) {
      unlinkSync(entry);
      return;
    }
    if (stat.isDirectory()) {
      assert.equal(realpathSync(entry), entry, "Refuse a replaced directory");
      for (const name of readdirSync(entry)) remove(join(entry, name));
      rmdirSync(entry);
    } else {
      assert.ok(stat.isFile());
      unlinkSync(entry);
    }
  };
  remove(target);
  assert.ok(!existsSync(target));
  assert.equal(
    realpathSync(join(owned.root, "node_modules")),
    owned.depsTarget,
  );
}
