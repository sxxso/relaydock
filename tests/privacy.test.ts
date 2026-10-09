import { it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

it("does not load deployment env files into fixture tests", async () => {
  const config = (await import("../vitest.config")).default;
  expect(config.envDir).toBe(false);
  const directory = mkdtempSync(join(tmpdir(), "atlas-test-env-"));
  try {
    writeFileSync(
      join(directory, ".env.local"),
      "VITE_ATLAS_ENV_FIXTURE=must-not-load\n",
    );
    const { resolveConfig } = await import("vite");
    const resolved = await resolveConfig(
      {
        configFile: false,
        root: directory,
        envDir: config.envDir,
        mode: "test",
        publicDir: false,
        logLevel: "silent",
      },
      "serve",
    );
    expect(resolved.env).not.toHaveProperty("VITE_ATLAS_ENV_FIXTURE");
    expect(resolved.envDir).toBe(false);
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()))
      throw new Error("Unsafe fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});

it("disables framework telemetry without requiring a personal global opt-out", async () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-privacy-test-"));
  const oldDisabled = process.env.NEXT_TELEMETRY_DISABLED;
  const oldCI = process.env.CI;
  try {
    delete process.env.NEXT_TELEMETRY_DISABLED;
    // CI mode gives Next's real telemetry consumer isolated local storage.
    process.env.CI = "1";
    await import("../next.config");
    const { Telemetry } = await import("next/dist/telemetry/storage");
    const telemetry = new Telemetry({ distDir: directory });
    expect(telemetry.isEnabled).toBe(false);
  } finally {
    if (oldDisabled === undefined) delete process.env.NEXT_TELEMETRY_DISABLED;
    else process.env.NEXT_TELEMETRY_DISABLED = oldDisabled;
    if (oldCI === undefined) delete process.env.CI;
    else process.env.CI = oldCI;
    if (dirname(resolve(directory)) !== resolve(tmpdir()))
      throw new Error("Unsafe fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});
