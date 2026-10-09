import { expect, it } from "vitest";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { Store } from "../src/lib/store";
import { handleApi } from "../src/lib/api";
import { tokenHash } from "../src/lib/crypto";
import { totals } from "../src/lib/money";

it("keeps same-platform/same-domain accounts and their encrypted credentials, queries and histories independent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-multi-account-"));
  const store = new Store(join(dir, "fixture.sqlite"), Buffer.alloc(32, 42));
  const old = process.env.RELAYDOCK_PRIVATE_HOSTS;
  let failFirst = false,
    hits = 0;
  const server = createServer((req, res) => {
    hits++;
    const first =
      req.headers.authorization === "Bearer fixture-account-a" &&
      req.headers["new-api-user"] === "1";
    const second =
      req.headers.authorization === "Bearer fixture-account-b" &&
      req.headers["new-api-user"] === "2";
    if (!first && !second) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (first && failFirst) {
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><html><title>登录</title></html>");
      return;
    }
    if (second && req.headers["user-agent"] !== "cc-switch/1.0") {
      res.setHeader("Content-Type", "text/html");
      res.end("<html>Unexpected request profile</html>");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Encoding", "gzip");
    res.end(
      gzipSync(
        Buffer.from(
          JSON.stringify({
            success: true,
            data: { quota: first ? "1000000" : "1500000" },
          }),
        ),
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    process.env.RELAYDOCK_PRIVATE_HOSTS = "127.0.0.1";
    const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const csrf = "c".repeat(48),
      raw = "d".repeat(64);
    store.createSession(tokenHash(raw), csrf);
    const common = {
      name: "同一个站",
      siteUrl: root,
      managementUrl: root,
      provider: "newapi",
      unit: "USD",
      quotaPerUnit: "500000",
      group: "常用",
    };
    const a = store.create({
      ...common,
      alias: "个人",
      credential: "fixture-account-a",
      userId: "1",
    });
    const b = store.create({
      ...common,
      alias: "工作",
      credential: "fixture-account-b",
      userId: "2",
      query: { requestProfile: "cc-switch" },
    });
    const call = (id: string, action: string) =>
      handleApi(
        new Request(`http://localhost/api/accounts/${id}/${action}`, {
          method: "POST",
          headers: {
            origin: "http://localhost",
            cookie: `atlas_session=${raw}`,
            "x-csrf-token": csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ routeMode: "direct" }),
        }),
        ["accounts", id, action],
        store,
      );
    expect(a.id).not.toBe(b.id);
    expect(hits).toBe(0);
    expect((await call(a.id, "sync")).status).toBe(200);
    expect((await call(b.id, "sync")).status).toBe(200);
    expect(store.get(a.id)?.balance).toBe("2");
    expect(store.get(b.id)?.balance).toBe("3");
    expect(totals(store.list())).toEqual({ USD: "5" });
    const histories = [store.history(a.id), store.history(b.id)];
    expect(histories.map((h) => h.length)).toEqual([1, 1]);
    failFirst = true;
    const failure = await call(a.id, "sync");
    expect(failure.status).toBe(502);
    expect(await failure.json()).toMatchObject({
      diagnostic: { code: "response_html" },
    });
    expect(store.get(a.id)?.balance).toBe("2");
    expect(store.get(b.id)?.balance).toBe("3");
    expect([store.history(a.id), store.history(b.id)]).toEqual(histories);
    expect((await call(b.id, "test")).status).toBe(200);
    expect(store.history(b.id)).toHaveLength(1);
    expect(store.credential(a.id)).toBe("fixture-account-a");
    expect(store.credential(b.id)).toBe("fixture-account-b");
    expect(JSON.stringify(store.exportBackup())).not.toMatch(
      /fixture-account-a|fixture-account-b|Bearer/,
    );
    expect(hits).toBe(4);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    if (old === undefined) delete process.env.RELAYDOCK_PRIVATE_HOSTS;
    else process.env.RELAYDOCK_PRIVATE_HOSTS = old;
    // Only this explicitly created random fixture directory, never the app DB.
    expect(resolve(dir)).toBe(join(resolve(tmpdir()), basename(dir)));
    expect(basename(dir)).toMatch(/^atlas-multi-account-/);
    rmSync(dir, { recursive: true, force: true });
  }
});
