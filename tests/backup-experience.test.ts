import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/lib/store";
import { hashPassword, tokenHash } from "../src/lib/crypto";
import { handleApi } from "../src/lib/api";

let directory: string;
let store: Store;
const rawToken = "c".repeat(64);
const csrf = "d".repeat(48);

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "relaydock-backup-experience-"));
  store = new Store(join(directory, "fixture.sqlite"), Buffer.alloc(32, 41));
  store.setMeta("adminHash", hashPassword("fixture-password-123"));
  store.createSession(tokenHash(rawToken), csrf);
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function call(path: string[], method = "GET", headers: Record<string, string> = {}) {
  return handleApi(
    new Request("http://127.0.0.1:3000/api/" + path.join("/"), {
      method,
      headers: {
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
        cookie: `atlas_session=${rawToken}`,
        "x-csrf-token": csrf,
        ...headers,
      },
    }),
    path,
    store,
  );
}

describe("backup experience", () => {
  it("starts without a recorded data-backup export", () => {
    expect(store.backupStatus()).toEqual({ lastDataBackupExportAt: null });
  });

  it("records the export time and preserves it when the store is reopened", () => {
    const backup = store.exportBackup();
    expect(new Date(backup.exportedAt).toISOString()).toBe(backup.exportedAt);
    expect(Math.abs(Date.now() - Date.parse(backup.exportedAt))).toBeLessThan(5000);
    store.recordDataBackupExport(backup.exportedAt);
    expect(store.backupStatus()).toEqual({
      lastDataBackupExportAt: backup.exportedAt,
    });

    const reopened = new Store(join(directory, "fixture.sqlite"), Buffer.alloc(32, 41));
    try {
      expect(reopened.backupStatus()).toEqual({
        lastDataBackupExportAt: backup.exportedAt,
      });
    } finally {
      reopened.close();
    }
  });

  it("returns status only to an authenticated session", async () => {
    const response = await call(["backup", "status"]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(store.backupStatus());

    const unauthenticated = await handleApi(
      new Request("http://127.0.0.1:3000/api/backup/status"),
      ["backup", "status"],
      store,
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("keeps credentials and the master-key filename out of exported JSON", () => {
    store.create({
      name: "不应泄露的账号",
      siteUrl: "https://fixture.invalid",
      provider: "newapi",
      credential: "fixture-secret-never-leak",
    });
    const exported = JSON.stringify(store.exportBackup());
    expect(exported).not.toContain("fixture-secret-never-leak");
    expect(exported).not.toContain("vault.key");
    expect(exported).not.toContain("主密钥");
  });

  it("exports a data backup through the API without returning secrets", async () => {
    const response = await call(["backup", "export"]);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(new Date(body.exportedAt).toISOString()).toBe(body.exportedAt);
    expect(Math.abs(Date.now() - Date.parse(body.exportedAt))).toBeLessThan(5000);
    expect(JSON.stringify(body)).not.toContain("fixture-secret-never-leak");
    expect(JSON.stringify(body)).not.toContain("vault.key");
  });
});

