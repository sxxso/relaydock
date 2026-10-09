import { describe, expect, it } from "vitest";
import { Store, MoveAccountError } from "../src/lib/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const key = Buffer.alloc(32, 31);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "relaydock-undo-"));
  const store = new Store(join(dir, "fixture.sqlite"), key);
  return { dir, store };
}
function close(dir: string, store: Store) {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

describe("field-specific undo", () => {
  it("restores only the changed field when the current value still matches", () => {
    const { dir, store } = fixture();
    try {
      const account = store.create({
        name: "undo",
        siteUrl: "https://undo.example",
        group: "A",
        tags: ["one"],
        favorite: false,
      });
      const changed = store.setFavorite(account.id, true);
      const result = store.undoFields({
        entries: [
          {
            id: account.id,
            expectedUpdatedAt: changed.updatedAt,
            restore: { favorite: false },
          },
        ],
      });
      expect(result.accounts[0].favorite).toBe(false);
      expect(result.skipped).toEqual([]);
      expect(store.get(account.id)?.updatedAt).not.toBe(changed.updatedAt);
    } finally {
      close(dir, store);
    }
  });

  it("restores group, tags and archive without touching history or credentials", () => {
    const { dir, store } = fixture();
    try {
      const account = store.create({
        name: "rich undo",
        siteUrl: "https://undo.example",
        group: "A",
        tags: ["one"],
        credential: "secret-undo",
      });
      store.record(account.id, "42", "manual", "USD", "kept history");
      store.batchUpdate({
        ids: [account.id],
        operation: { kind: "group", group: "B" },
      });
      store.batchUpdate({
        ids: [account.id],
        operation: { kind: "tags", mode: "replace", tags: ["two"] },
      });
      const changed = store.batchUpdate({
        ids: [account.id],
        operation: { kind: "archive", archived: true },
      })[0];
      const result = store.undoFields({
        entries: [
          {
            id: account.id,
            expectedUpdatedAt: changed.updatedAt,
            restore: { group: "A", tags: ["one"], archived: false },
          },
        ],
      });
      expect(result.accounts[0]).toMatchObject({
        group: "A",
        tags: ["one"],
        archived: false,
      });
      expect(store.history(account.id)).toHaveLength(1);
      expect(store.credential(account.id)).toBe("secret-undo");
    } finally {
      close(dir, store);
    }
  });

  it("rejects the whole batch when one target has a later update", () => {
    const { dir, store } = fixture();
    try {
      const a = store.create({ name: "first", siteUrl: "https://undo.example" });
      const b = store.create({ name: "second", siteUrl: "https://undo.example" });
      const changedA = store.setFavorite(a.id, true);
      const changedB = store.setFavorite(b.id, true);
      store.setFavorite(b.id, false);
      const result = store.undoFields({
        entries: [
          { id: a.id, expectedUpdatedAt: changedA.updatedAt, restore: { favorite: false } },
          { id: b.id, expectedUpdatedAt: changedB.updatedAt, restore: { favorite: false } },
        ],
      });
      expect(result.accounts).toEqual([]);
      expect(result.skipped).toEqual([{ id: b.id, field: "favorite" }]);
      expect(store.get(a.id)?.favorite).toBe(true);
      expect(store.get(b.id)?.favorite).toBe(false);
    } finally {
      close(dir, store);
    }
  });

  it("rejects fields outside the undo allowlist", () => {
    const { dir, store } = fixture();
    try {
      const account = store.create({ name: "undo", siteUrl: "https://undo.example" });
      expect(() =>
        store.undoFields({
          entries: [
            {
              id: account.id,
              expectedUpdatedAt: account.updatedAt,
              restore: { name: "must-not-change" },
            },
          ],
        }),
      ).toThrow(MoveAccountError);
      expect(store.get(account.id)?.name).toBe("undo");
    } finally {
      close(dir, store);
    }
  });
});
