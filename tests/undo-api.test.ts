import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";

const token = "a".repeat(64);
const csrf = "b".repeat(48);
let directory: string;
let store: Store;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "relaydock-undo-api-"));
  store = new Store(join(directory, "fixture.sqlite"), Buffer.alloc(32, 29));
  store.createSession(tokenHash(token), csrf);
  vi.stubEnv("RELAYDOCK_PUBLIC_URL", "");
  vi.stubEnv("RELAYDOCK_PRIVATE_HOSTS", "127.0.0.1");
  vi.stubEnv("RELAYDOCK_DNS_MODE", "system");
});
afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function account(overrides: Record<string, unknown> = {}) {
  return store.create({
    name: "undo api fixture",
    siteUrl: "https://undo-api.example",
    group: "原分组",
    tags: ["原标签"],
    favorite: true,
    archived: false,
    ...overrides,
  });
}
async function call(body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return handleApi(
    new Request("http://127.0.0.1:3000/api/accounts/undo", {
      method,
      headers: {
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
        cookie: `atlas_session=${token}`,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        ...headers,
      },
      body: method === "GET" ? undefined : JSON.stringify(body),
    }),
    ["accounts", "undo"],
    store,
  );
}

describe("accounts/undo API", () => {
  it("restores a whitelisted field and never returns secrets", async () => {
    const a = account({ credential: "private-credential" });
    const changed = store.setFavorite(a.id, false);
    const response = await call({
      entries: [{ id: a.id, expectedUpdatedAt: changed.updatedAt, restore: { favorite: true } }],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].favorite).toBe(true);
    expect(JSON.stringify(body)).not.toContain("private-credential");
  });

  it("rejects CSRF/origin failures without changing the account", async () => {
    const a = account();
    const changed = store.setFavorite(a.id, false);
    const before = store.get(a.id);
    const failedHeaders: Record<string, string>[] = [
      { "x-csrf-token": "c".repeat(48) },
      { origin: "https://evil.example" },
    ];
    for (const headers of failedHeaders) {
      const response = await call({
        entries: [{ id: a.id, expectedUpdatedAt: changed.updatedAt, restore: { favorite: true } }],
      }, headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toHaveProperty("error");
    }
    expect(store.get(a.id)).toEqual(before);
  });

  it("rejects forbidden fields and does not write", async () => {
    const a = account();
    const before = store.get(a.id);
    const response = await call({
      entries: [{
        id: a.id,
        expectedUpdatedAt: a.updatedAt,
        restore: { favorite: false, credential: "do-not-accept" },
      }],
    });
    expect(response.status).toBe(400);
    expect(store.get(a.id)).toEqual(before);
  });

  it("rejects the whole batch when one target has a later update", async () => {
    const a = account({ name: "first" });
    const b = account({ name: "second" });
    const changedA = store.setFavorite(a.id, false);
    const changedB = store.setFavorite(b.id, false);
    store.setFavorite(b.id, true);
    const response = await call({
      entries: [
        { id: a.id, expectedUpdatedAt: changedA.updatedAt, restore: { favorite: true } },
        { id: b.id, expectedUpdatedAt: changedB.updatedAt, restore: { favorite: true } },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accounts: [],
      skipped: [{ id: b.id, field: "favorite" }],
    });
    expect(store.get(a.id)?.favorite).toBe(false);
    expect(store.get(b.id)?.favorite).toBe(true);
  });

  it.each(["GET", "PATCH", "DELETE"])("does not expose undo via %s", async (method) => {
    const response = await call({}, {}, method);
    expect(response.status).toBe(404);
  });
});


