import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import zlib from "node:zlib";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { safeJsonRequest } from "../src/lib/outbound";
import { QueryFailure, QueryTrace } from "../src/lib/query-trace";
import {
  normalizeDiagnostic,
  diagnosticReport,
} from "../src/lib/query-diagnostics";

const data = { success: true, data: { quota: 1250000, group: "中文分组" } };
const plain = Buffer.from(JSON.stringify(data));
const encoded = {
  gzip: gzipSync(plain),
  deflate: deflateSync(plain),
  br: brotliCompressSync(plain),
};
const seen: http.IncomingHttpHeaders[] = [];
const versions: string[] = [],
  sockets = new Set<Socket>();
let server: http.Server,
  proxy: http.Server,
  root: string,
  targetPort: number,
  tunnels = 0;
const oldPrivate = process.env.RELAYDOCK_PRIVATE_HOSTS,
  oldDns = process.env.RELAYDOCK_DNS_MODE;
const oldProxy = process.env.RELAYDOCK_QUERY_PROXY_URL;
it("settles a headerless EventEmitter fixture when close immediately follows end", async () => {
  vi.spyOn(http, "request").mockImplementation(
    (...args: Parameters<typeof http.request>) => {
      const callback = args[2] as (res: http.IncomingMessage) => void;
      const req = Object.assign(new EventEmitter(), {
        end() {
          const res = Object.assign(new EventEmitter(), { statusCode: 200 });
          callback(res as http.IncomingMessage);
          res.emit("data", Buffer.from('{"balance":"3"}'));
          res.emit("end");
          req.emit("close");
        },
        destroy() {
          req.emit("close");
        },
      });
      return req as unknown as http.ClientRequest;
    },
  );
  await expect(
    safeJsonRequest(root, "fixture-secret", "", { routeMode: "direct" }),
  ).resolves.toEqual({ balance: "3" });
});
function track(socket: Socket) {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await sleep(5);
  expect(check()).toBe(true);
}
beforeAll(async () => {
  process.env.RELAYDOCK_PRIVATE_HOSTS = "127.0.0.1";
  process.env.RELAYDOCK_DNS_MODE = "system";
  server = http.createServer((req, res) => {
    seen.push(req.headers);
    versions.push(req.httpVersion);
    const path = req.url?.slice(1) || "";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (path in encoded) {
      res.setHeader("Content-Encoding", path);
      res.end(encoded[path as keyof typeof encoded]);
    } else if (path === "bom")
      res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]));
    else if (path === "json-wrong-mime") {
      res.setHeader("Content-Type", "text/html; secret=fixture-secret");
      res.end(plain);
    } else if (path === "html") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<!DOCTYPE html><html><title>登录</title><body>fixture-secret</body></html>",
      );
    } else if (path === "challenge") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<!doctype html><html><title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/fixture-secret'></script></html>",
      );
    } else if (path === "broken-compression") {
      res.setHeader("Content-Encoding", "gzip");
      res.end("not gzip fixture-secret");
    } else if (path === "unsupported") {
      res.setHeader("Content-Encoding", "secret-encoding-fixture-secret");
      res.end(plain);
    } else if (path === "stacked") {
      res.setHeader("Content-Encoding", "gzip, br");
      res.end(plain);
    } else if (path === "bomb") {
      res.setHeader("Content-Encoding", "gzip");
      res.end(gzipSync(Buffer.alloc(1048577, 32)));
    } else if (path === "bomb-br") {
      res.setHeader("Content-Encoding", "br");
      res.end(brotliCompressSync(Buffer.alloc(1048577, 32)));
    } else if (path === "bomb-deflate") {
      res.setHeader("Content-Encoding", "deflate");
      res.end(deflateSync(Buffer.alloc(1048577, 32)));
    } else if (path === "broken-br" || path === "broken-deflate") {
      res.setHeader("Content-Encoding", path.slice(7));
      res.end("not compressed fixture-secret");
    } else if (path === "gzip-empty") {
      res.setHeader("Content-Encoding", "gzip");
      res.end(gzipSync(Buffer.alloc(0)));
    } else if (path === "gzip-html") {
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Type", "text/html");
      res.end(gzipSync(Buffer.from("<html>fixture-secret</html>")));
    } else if (path === "wire-too-large") res.end(Buffer.alloc(1048577, 32));
    else if (path === "exact-limit") res.end('"' + "x".repeat(1048574) + '"');
    else if (path === "json-markers")
      res.end(
        JSON.stringify({
          message:
            "<html>Just a moment... /cdn-cgi/challenge-platform/fixture-secret",
        }),
      );
    else if (path === "invalid-utf8") res.end(Buffer.from([0xc3, 0x28]));
    else if (path === "empty") res.end(" \n ");
    else if (path === "malformed") res.end('{"balance":secret-fixture}');
    else res.end(plain);
  });
  server.on("connection", track);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  targetPort = (server.address() as { port: number }).port;
  root = "http://127.0.0.1:" + targetPort;
  proxy = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  proxy.on("connection", track);
  proxy.on("connect", (req, client, head) => {
    track(client as Socket);
    // Never tunnel outside this fixture's own loopback server.
    if (req.url !== `127.0.0.1:${targetPort}`) {
      client.destroy();
      return;
    }
    tunnels++;
    const upstream = connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    track(upstream);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  process.env.RELAYDOCK_QUERY_PROXY_URL =
    "http://127.0.0.1:" + (proxy.address() as { port: number }).port;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (oldPrivate === undefined) delete process.env.RELAYDOCK_PRIVATE_HOSTS;
  else process.env.RELAYDOCK_PRIVATE_HOSTS = oldPrivate;
  if (oldDns === undefined) delete process.env.RELAYDOCK_DNS_MODE;
  else process.env.RELAYDOCK_DNS_MODE = oldDns;
  if (oldProxy === undefined) delete process.env.RELAYDOCK_QUERY_PROXY_URL;
  else process.env.RELAYDOCK_QUERY_PROXY_URL = oldProxy;
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    [server, proxy].map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});
describe.each(["direct", "proxy"] as const)(
  "response body on %s route",
  (routeMode) => {
    const trace = () =>
      new QueryTrace({
        provider: "newapi",
        operation: "test",
        routeMode,
        timeoutSeconds: 10,
        dnsMode: "system",
      });
    it.each(["gzip", "deflate", "br"] as const)(
      "decodes %s JSON before parsing and records only sanitized byte metadata",
      async (encoding) => {
        const t = trace(),
          before = seen.length;
        const connects = tunnels;
        expect(
          await safeJsonRequest(
            root + "/" + encoding,
            "fixture-secret",
            "123",
            { trace: t, routeMode },
          ),
        ).toEqual(data);
        const d = t.finish();
        expect(d).toMatchObject({
          response: {
            mediaType: "json",
            encoding,
            bodyKind: "json",
            wireBytes: encoded[encoding].length,
            decodedBytes: plain.length,
          },
        });
        expect(normalizeDiagnostic(d)).toEqual(d);
        expect(diagnosticReport(d)).not.toMatch(
          /fixture-secret|127\.0\.0\.1|中文分组|1250000/,
        );
        expect(seen.length - before).toBe(1);
        expect(tunnels - connects).toBe(routeMode === "proxy" ? 1 : 0);
      },
    );
    it.each(["bom", "json-wrong-mime"])(
      "accepts valid UTF-8 JSON from %s without guessing balance or trusting MIME",
      async (path) => {
        expect(
          await safeJsonRequest(root + "/" + path, "fixture-secret", "", {
            routeMode,
          }),
        ).toEqual(data);
      },
    );
    it.each([
      ["html", "response_html", "html"],
      ["challenge", "response_challenge", "challenge"],
      ["broken-compression", "response_encoding", "unknown"],
      ["unsupported", "response_encoding", "unknown"],
      ["stacked", "response_encoding", "unknown"],
      ["invalid-utf8", "response_text_encoding", "unknown"],
      ["empty", "response_empty", "empty"],
      ["malformed", "invalid_json", "non-json"],
      ["bomb", "response_too_large", "unknown"],
      ["bomb-br", "response_too_large", "unknown"],
      ["bomb-deflate", "response_too_large", "unknown"],
      ["broken-br", "response_encoding", "unknown"],
      ["broken-deflate", "response_encoding", "unknown"],
      ["wire-too-large", "response_too_large", "unknown"],
      ["gzip-empty", "response_empty", "empty"],
      ["gzip-html", "response_html", "html"],
    ])(
      "classifies %s before extractor without retries or raw body exposure",
      async (path, code, kind) => {
        const t = trace(),
          before = seen.length;
        let failure: unknown;
        try {
          await safeJsonRequest(root + "/" + path, "fixture-secret", "", {
            trace: t,
            routeMode,
          });
        } catch (e) {
          failure = e;
        }
        expect(failure).toBeInstanceOf(QueryFailure);
        expect(failure).toMatchObject({ code });
        const d = t.finish(failure as QueryFailure);
        expect(d).toMatchObject({
          response: { bodyKind: kind },
          stages: expect.arrayContaining([
            { id: "parse", status: "not-run", durationMs: null },
          ]),
        });
        expect(diagnosticReport(d)).not.toMatch(
          /fixture-secret|secret-encoding|localhost|127\.0\.0\.1|cdn-cgi/,
        );
        expect(seen.length - before).toBe(1);
        await until(() => sockets.size === 0);
      },
    );
    it("accepts exactly 1 MiB and never treats JSON challenge strings as a challenge", async () => {
      expect(
        (
          (await safeJsonRequest(root + "/exact-limit", "fixture-secret", "", {
            routeMode,
          })) as string
        ).length,
      ).toBe(1048574);
      expect(
        await safeJsonRequest(root + "/json-markers", "fixture-secret", "", {
          routeMode,
        }),
      ).toHaveProperty("message");
    });
    it.each([undefined, "atlas", "cc-switch"] as const)(
      "uses explicit %s profile and advertises only supported encodings",
      async (requestProfile) => {
        await safeJsonRequest(root, "fixture-secret", "", {
          routeMode,
          requestProfile,
        });
        expect(versions.at(-1)).toBe("1.1");
        expect(seen.at(-1)).toMatchObject({
          "user-agent":
            requestProfile === "cc-switch"
              ? "cc-switch/1.0"
              : "RelayDock-Atlas/1.0",
          accept: requestProfile === "cc-switch" ? "*/*" : "application/json",
          "accept-encoding": "gzip, deflate, br",
        });
      },
    );
    it("rejects an unknown profile before any request", async () => {
      const before = seen.length,
        connects = tunnels;
      await expect(
        safeJsonRequest(root, "fixture-secret", "", {
          routeMode,
          requestProfile: "invalid" as "atlas",
        }),
      ).rejects.toMatchObject({ code: "invalid_config" });
      expect(seen.length).toBe(before);
      expect(tunnels).toBe(connects);
    });
    it("keeps the original deadline during slow decoder drain and destroys all streams", async () => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
      });
      const nativeGunzip = zlib.createGunzip,
        nativeRequest = http.request;
      let decoder: ReturnType<typeof zlib.createGunzip> | undefined;
      const requests: http.ClientRequest[] = [],
        responses: http.IncomingMessage[] = [];
      vi.spyOn(zlib, "createGunzip").mockImplementation((options) => {
        decoder = nativeGunzip(options);
        // Real decompression, deliberately stalled final flush after HTTP completion.
        decoder._flush = () => {};
        return decoder;
      });
      vi.spyOn(http, "request").mockImplementation(
        (...args: Parameters<typeof http.request>) => {
          const req = Reflect.apply(
            nativeRequest,
            http,
            args,
          ) as http.ClientRequest;
          requests.push(req);
          req.on("response", (res) => responses.push(res));
          return req;
        },
      );
      const t = trace(),
        before = seen.length;
      let settled = false;
      const pending = safeJsonRequest(root + "/gzip", "fixture-secret", "", {
        trace: t,
        routeMode,
      })
        .catch((e: unknown) => e)
        .finally(() => {
          settled = true;
        });
      try {
        await until(
          () =>
            !!decoder &&
            responses.some((res) => res.complete) &&
            requests[0]?.destroyed,
        );
        await vi.advanceTimersByTimeAsync(9999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const failure = await pending;
        expect(failure).toBeInstanceOf(QueryFailure);
        expect(failure).toMatchObject({ code: "read_timeout" });
        expect(t.finish(failure as QueryFailure)).toMatchObject({
          totalMs: 10000,
          response: { bodyKind: "unknown" },
        });
        expect(decoder?.destroyed).toBe(true);
        expect(requests.every((req) => req.destroyed)).toBe(true);
        expect(responses.every((res) => res.destroyed)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        expect(seen.length - before).toBe(1);
        await until(() => sockets.size === 0);
      } finally {
        decoder?.destroy();
        requests.forEach((req) => req.destroy());
      }
    });
  },
);
