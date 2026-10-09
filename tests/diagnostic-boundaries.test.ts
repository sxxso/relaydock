import { expect, it, vi } from "vitest";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
vi.mock("../src/lib/outbound", () => ({
  safeJsonRequest: async () => {
    const { QueryFailure } = await import("../src/lib/query-trace");
    throw new QueryFailure(
      "read_failed",
      "token=fixture-secret-untrusted-error",
    );
  },
}));
it("public API text and stored sync errors are generated from codes, never a typed error's arbitrary message", async () => {
  const store = new Store(":memory:", Buffer.alloc(32, 8));
  try {
    const csrf = "a".repeat(48),
      raw = "b".repeat(64);
    store.createSession(tokenHash(raw), csrf);
    const a = store.create({
      name: "fixture",
      siteUrl: "https://fixture.example",
      provider: "generic",
      credential: "fixture-only",
    });
    const r = await handleApi(
      new Request("http://localhost/api/accounts/" + a.id + "/sync", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          cookie: "atlas_session=" + raw,
          "x-csrf-token": csrf,
        },
      }),
      ["accounts", a.id, "sync"],
      store,
    );
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body.diagnostic.code).toBe("read_failed");
    expect(body.error).not.toContain("fixture-secret-untrusted-error");
    expect(store.get(a.id)?.lastSyncError).not.toContain(
      "fixture-secret-untrusted-error",
    );
  } finally {
    store.close();
  }
});
