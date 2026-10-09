import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
let directory: string, store: Store;
const token = "d".repeat(64), csrf = "e".repeat(48);
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "atlas-undo-producer-"));
  store = new Store(join(directory, "fixture.sqlite"), Buffer.alloc(32, 29));
  store.createSession(tokenHash(token), csrf);
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
const create = (group = "A") => store.create({ name: "fixture", group, siteUrl: "https://undo.fixture.invalid" });
async function post(path: string, data: unknown) {
  return handleApi(new Request(`http://127.0.0.1:3000/api/${path}`, {
    method: "POST", headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000", cookie: `atlas_session=${token}`, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(data),
  }), path.split("/"), store);
}
describe("undo producers require the version used by their previous-value snapshot", () => {
  it("accepts current versions, allowing an exact batch restore", async () => {
    const a = create(), b = create("");
    const response = await post("accounts/batch", { ids: [a.id, b.id], expectedUpdatedAt: { [a.id]: a.updatedAt, [b.id]: b.updatedAt }, operation: { kind: "group", group: "B" } });
    expect(response.status).toBe(200);
    const changed = (await response.json()).accounts;
    const restored = await post("accounts/undo", { entries: [a, b].map((before, i) => ({ id: before.id, expectedUpdatedAt: changed[i].updatedAt, restore: { group: before.group } })) });
    expect(restored.status).toBe(200); expect(store.get(a.id)?.group).toBe("A"); expect(store.get(b.id)?.group).toBe("");
  });
  it.each(["A", "B"])("rejects stale %s snapshots without changing any target", async (remembered) => {
    const a = create(remembered), b = create();
    store.batchUpdate({ ids: [a.id], operation: { kind: "group", group: "C" } });
    const before = store.list();
    const response = await post("accounts/batch", { ids: [a.id, b.id], expectedUpdatedAt: { [a.id]: a.updatedAt, [b.id]: b.updatedAt }, operation: { kind: "group", group: "B" } });
    expect(response.status).toBe(409); expect(store.list()).toEqual(before);
  });
  it("accepts a fresh favorite and rejects its stale repeat", async () => {
    const a = create();
    expect((await post(`accounts/${a.id}/favorite`, { favorite: true, expectedUpdatedAt: a.updatedAt })).status).toBe(200);
    const current = store.get(a.id);
    expect((await post(`accounts/${a.id}/favorite`, { favorite: false, expectedUpdatedAt: a.updatedAt })).status).toBe(409);
    expect(store.get(a.id)).toEqual(current);
  });
  it("rejects incomplete and extra version maps instead of skipping protection", async () => {
    const a = create(), b = create();
    for (const versions of [{ [a.id]: a.updatedAt }, { [a.id]: a.updatedAt, [b.id]: b.updatedAt, [crypto.randomUUID()]: b.updatedAt }]) {
      expect((await post("accounts/batch", { ids: [a.id, b.id], expectedUpdatedAt: versions, operation: { kind: "archive", archived: true } })).status).toBe(400);
    }
    expect(store.get(a.id)?.archived).toBe(false);
  });
  it("preserves legacy callers without version maps", async () => {
    const a = create();
    expect((await post("accounts/batch", { ids: [a.id], operation: { kind: "archive", archived: true } })).status).toBe(200);
    expect((await post(`accounts/${a.id}/favorite`, { favorite: true })).status).toBe(200);
  });
});
