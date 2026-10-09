import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/lib/store";
import { hashPassword, tokenHash } from "../src/lib/crypto";
import { handleApi } from "../src/lib/api";
import { DEFAULT_SAVED_VIEW_FILTERS } from "../src/lib/saved-views";

let directory: string;
let store: Store;
const rawToken = "a".repeat(64);
const csrf = "b".repeat(48);

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "relaydock-saved-views-api-"));
  store = new Store(join(directory, "fixture.sqlite"), Buffer.alloc(32, 31));
  store.setMeta("adminHash", hashPassword("fixture-password-123"));
  store.createSession(tokenHash(rawToken), csrf);
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function call(
  path: string[],
  body: unknown = undefined,
  method = "GET",
  headers: Record<string, string> = {},
) {
  return handleApi(
    new Request("http://127.0.0.1:3000/api/" + path.join("/"), {
      method,
      headers: {
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
        cookie: `atlas_session=${rawToken}`,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    path,
    store,
  );
}

const filters = { ...DEFAULT_SAVED_VIEW_FILTERS, group: "工作" };

describe("saved views persistence and API", () => {
  it("saves, replaces, survives reopening, and deletes a named view", async () => {
    const createdResponse = await call(
      ["views"],
      { name: "工作账户", filters },
      "PUT",
    );
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json();
    expect(created.name).toBe("工作账户");
    expect(created.filters.group).toBe("工作");
    expect(store.savedViews()).toHaveLength(1);

    const replacedResponse = await call(
      ["views"],
      { id: created.id, name: "低余额工作账户", filters: { ...filters, onlyLow: true } },
      "PUT",
    );
    expect(replacedResponse.status).toBe(200);
    expect((await replacedResponse.json()).id).toBe(created.id);
    expect(store.savedViews()[0].name).toBe("低余额工作账户");
    expect(store.savedViews()[0].filters.onlyLow).toBe(true);

    const reopened = new Store(join(directory, "fixture.sqlite"), Buffer.alloc(32, 31));
    try {
      expect(reopened.savedViews()).toEqual(store.savedViews());
    } finally {
      reopened.close();
    }

    const deletedResponse = await call(["views", created.id], undefined, "DELETE");
    expect(deletedResponse.status).toBe(200);
    expect(await deletedResponse.json()).toEqual({ views: [] });
  });

  it("returns saved views with accounts without exposing credentials", async () => {
    const account = store.create({
      name: "视图账号",
      siteUrl: "https://fixture.invalid",
      provider: "newapi",
      credential: "must-not-leak",
    });
    const view = store.saveView({ name: "全部", filters: DEFAULT_SAVED_VIEW_FILTERS });
    const response = await call(["accounts"]);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.savedViews).toEqual([view]);
    expect(body.accounts.find((a: { id: string }) => a.id === account.id)).not.toHaveProperty("credential");
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("protects writes with CSRF and origin checks", async () => {
    const before = store.savedViews();
    const csrfFailure = await call(
      ["views"],
      { name: "不应保存", filters },
      "PUT",
      { "x-csrf-token": "c".repeat(48) },
    );
    expect(csrfFailure.status).toBe(403);
    const originFailure = await call(
      ["views"],
      { name: "不应保存", filters },
      "PUT",
      { origin: "https://evil.invalid" },
    );
    expect(originFailure.status).toBe(403);
    expect(store.savedViews()).toEqual(before);
  });

  it("keeps saved views in data backups and accepts old backups without the field", () => {
    const backup = store.exportBackup();
    expect(backup.savedViews).toEqual(store.savedViews());
    const oldBackup = { ...backup } as Record<string, unknown>;
    delete oldBackup.savedViews;
    expect(() => store.importBackup(oldBackup, true)).not.toThrow();
  });

  it.each(["POST", "PATCH"])('does not expose unsupported /views methods via %s', async (method) => {
    const response = await call(["views"], { name: "x", filters }, method);
    expect(response.status).toBe(404);
  });
});
