import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import http, { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { safeJsonRequest } from "../src/lib/outbound";
import { QueryFailure, QueryTrace } from "../src/lib/query-trace";
let server: Server,
  root: string,
  old = process.env.RELAYDOCK_PRIVATE_HOSTS,
  hits = 0,
  deniedClosed = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === "/upgrade") {
      res.writeHead(101, { Connection: "Upgrade", Upgrade: "fixture-secret" });
      res.flushHeaders();
      return;
    }
    if (req.url === "/premature-close") {
      req.socket.destroy();
      return;
    }
    if (req.url === "/denied-stall") {
      res.on("close", () => deniedClosed++);
      res.writeHead(401);
      res.flushHeaders();
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: root + "/success" });
      res.end();
      return;
    }
    if (req.url === "/unauthorized") {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === "/limited") {
      res.writeHead(429);
      res.end();
      return;
    }
    if (req.url === "/empty" || req.url === "/whitespace") {
      res.setHeader("Content-Type", "text/plain");
      res.end(req.url === "/empty" ? "" : " \n\t\r ");
      return;
    }
    if (req.url === "/invalid") {
      res.end("<html>not json</html>");
      return;
    }
    if (req.url === "/slow") return;
    if (req.url === "/header") {
      res.end(
        JSON.stringify({
          apiKey: req.headers["x-api-key"],
          authorization: req.headers.authorization || null,
        }),
      );
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        data: { quota: 0 },
        tokenReceived: req.headers.authorization === "Bearer fixture-only",
        userReceived: req.headers["new-api-user"] === "123",
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  root = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  process.env.RELAYDOCK_PRIVATE_HOSTS = "127.0.0.1";
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (old === undefined) delete process.env.RELAYDOCK_PRIVATE_HOSTS;
  else process.env.RELAYDOCK_PRIVATE_HOSTS = old;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
describe("pinned outbound fixture server", () => {
  it.each(["upgrade", "close-without-response"])(
    "settles direct %s before the deadline and removes the deadline timer",
    async (kind) => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
      });
      const nativeRequest = http.request;
      let request: http.ClientRequest | undefined,
        closed = false;
      vi.spyOn(http, "request").mockImplementation(
        (...args: Parameters<typeof http.request>) => {
          request = Reflect.apply(
            nativeRequest,
            http,
            args,
          ) as http.ClientRequest;
          request.once("close", () => {
            closed = true;
          });
          return request;
        },
      );
      const queryTrace = new QueryTrace({
        provider: "custom",
        operation: "test",
        timeoutSeconds: 10,
        dnsMode: "system",
      });
      const stages = vi.spyOn(queryTrace, "begin");
      let settled = false;
      const result = safeJsonRequest(
        root + (kind === "upgrade" ? "/upgrade" : "/slow"),
        "fixture-secret",
        "",
        { trace: queryTrace },
      )
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      try {
        for (
          let i = 0;
          i < 200 &&
          !(kind === "upgrade"
            ? closed
            : stages.mock.calls.some(([id]) => id === "response"));
          i++
        )
          await sleep(5);
        expect(request).toBeDefined();
        if (kind === "close-without-response") {
          expect(stages.mock.calls.some(([id]) => id === "response")).toBe(
            true,
          );
          request!.emit("close");
        } else expect(closed).toBe(true);
        await vi.advanceTimersByTimeAsync(10001);
        expect(settled).toBe(true);
        const error = await result;
        expect(error).toBeInstanceOf(QueryFailure);
        if (!(error instanceof QueryFailure))
          throw new Error("Expected a safe query failure");
        expect(error.code).toBe(
          kind === "upgrade" ? "http_error" : "response_failed",
        );
        if (kind === "upgrade") expect(error.httpStatus).toBe(101);
        expect(error.message).not.toContain("fixture-secret");
        expect(
          queryTrace.finish(error).stages.find((s) => s.id === "response")
            ?.status,
        ).toBe("error");
        expect(request!.destroyed).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        request?.destroy();
      }
    },
  );
  it("settles a real direct premature socket close without retry or raw error text", async () => {
    const count = hits;
    const error: unknown = await safeJsonRequest(
      root + "/premature-close",
      "fixture-secret",
      "",
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "response_failed" });
    expect(error).toBeInstanceOf(QueryFailure);
    if (error instanceof QueryFailure)
      expect(error.message).not.toContain("fixture-secret");
    expect(hits).toBe(count + 1);
  });
  it("closes rejected responses without leaving a stalled body downloading", async () => {
    const closed = deniedClosed;
    await expect(
      safeJsonRequest(root + "/denied-stall", "fixture-only", ""),
    ).rejects.toThrow("令牌");
    await new Promise((r) => setTimeout(r, 50));
    expect(deniedClosed).toBe(closed + 1);
  });
  it("supports explicit custom header authentication without leaking a second auth header", async () => {
    const result = await (safeJsonRequest as any)(
      root + "/header",
      "fixture-only",
      "",
      { timeoutSeconds: 20, authHeader: "x-api-key" },
    );
    expect(result).toEqual({ apiKey: "fixture-only", authorization: null });
  });
  it("validates timeout/header options before making any request", async () => {
    const count = hits;
    for (const options of [{ timeoutSeconds: 999 }, { authHeader: "Host" }])
      await expect(
        (safeJsonRequest as any)(
          root + "/success",
          "fixture-only",
          "",
          options,
        ),
      ).rejects.toThrow("查询配置");
    expect(hits).toBe(count);
  });
  it("passes legacy authentication only to an explicitly allowed host", async () => {
    let r = (await safeJsonRequest(
      root + "/success",
      "fixture-only",
      "123",
    )) as { tokenReceived: boolean; userReceived: boolean };
    expect(r.tokenReceived).toBe(true);
    expect(r.userReceived).toBe(true);
  });
  it("never follows redirects", async () => {
    let count = hits;
    await expect(
      safeJsonRequest(root + "/redirect", "fixture-only", ""),
    ).rejects.toThrow("重定向");
    expect(hits - count).toBe(1);
  });
  it.each(["/empty", "/whitespace"])(
    "classifies HTTP 200 %s as an empty response, without retry or credential text",
    async (path) => {
      const count = hits;
      const trace = new QueryTrace({
        provider: "newapi",
        operation: "test",
        timeoutSeconds: 10,
        dnsMode: "system",
      });
      const error = await safeJsonRequest(
        root + path,
        "fixture-secret",
        "123",
        { trace },
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "response_empty" });
      expect(error).toBeInstanceOf(QueryFailure);
      if (!(error instanceof QueryFailure))
        throw new Error("Expected a safe query failure");
      expect(error.message).not.toContain("fixture-secret");
      const d = trace.finish(error);
      expect(d.httpStatus).toBe(200);
      expect(d.category).toBe("service");
      expect(d.stages.find((s) => s.id === "read")?.status).toBe("error");
      expect(d.stages.find((s) => s.id === "parse")?.status).toBe("not-run");
      expect(hits).toBe(count + 1);
    },
  );
  it("reports 401, 429 and invalid JSON without retry", async () => {
    let count = hits;
    await expect(
      safeJsonRequest(root + "/unauthorized", "fixture-only", ""),
    ).rejects.toThrow("令牌");
    await expect(
      safeJsonRequest(root + "/limited", "fixture-only", ""),
    ).rejects.toThrow("限流");
    await expect(
      safeJsonRequest(root + "/invalid", "fixture-only", ""),
    ).rejects.toThrow("JSON");
    expect(hits - count).toBe(3);
  });
  it("times out and closes a stalled request after ten seconds", async () => {
    await expect(
      safeJsonRequest(root + "/slow", "fixture-only", ""),
    ).rejects.toThrow("等待响应");
  }, 15000);
});
