import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import https from "node:https";
import tls from "node:tls";
import { connect, isIP, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { safeJsonRequest } from "../src/lib/outbound";
import { QueryFailure, QueryTrace } from "../src/lib/query-trace";
import {
  diagnosticExplanation,
  normalizeDiagnostic,
  publicQueryError,
} from "../src/lib/query-diagnostics";

const dns = vi.hoisted(() => ({
  hits: [] as string[],
  target: [{ address: "127.0.0.1", family: 4 }],
  proxy: [{ address: "127.0.0.1", family: 4 }],
  targetDelay: 0,
  proxyDelay: 0,
  fail: "",
}));
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    dns.hits.push(host);
    if (host === dns.fail) throw new Error("proxy-secret provider-secret");
    const delay = host === "proxy.example" ? dns.proxyDelay : dns.targetDelay;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (host === "proxy.example") return dns.proxy;
    if (host === "target.example" || host === "wrong.example")
      return dns.target;
    throw new Error("Unexpected fixture DNS lookup");
  },
}));

// Synthetic test-only key/certificate, not deployment credentials. The fixture
// CA is trusted only in this test worker, with normal hostname verification.
const cert = `-----BEGIN CERTIFICATE-----
MIIC+zCCAeOgAwIBAgIIR/Di607WCmEwDQYJKoZIhvcNAQELBQAwHjEcMBoGA1UE
AxMTcmVsYXlkb2NrLXRlc3Qtb25seTAeFw0yNjEwMDMwNjI3NDdaFw00NjEwMDQw
NjI3NDdaMB4xHDAaBgNVBAMTE3JlbGF5ZG9jay10ZXN0LW9ubHkwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDKKXAmLJwmKrgq0B5+s7RWhxg3MkLqrUse
AOLeIP0RywHBMwlfQvfQBAwOyBa38eTLeoN9z6/cTnMaef5xFfB8kt1yHXr1K9Nh
lN1yLc2kJ8erGCbjMaatUQkWkm41JaeSkiDrwzFbNy94BOHfzIA2dgZLAJp0m/x1
/DQwoW2AVc/jSTkWvpkEylf9HTFS+leWRtJShEGJucfTUVHB3jJ7MKAOIrLonMhD
ruS0Zf5AHdRte/R0KIdqcdwsc95JFxFj5HvXGiB8UqwryF/4M2dxTz81Pobf28li
jYx9OqPOX992aKfK7iAp35TNdmgEwiWyeIJ4GGgEryPXIeZzIoLhAgMBAAGjPTA7
MCgGA1UdEQQhMB+CDnRhcmdldC5leGFtcGxlgg1wcm94eS5leGFtcGxlMA8GA1Ud
EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAKjCZJP0XowytjhLc0T26cHs
7fduE0UkiCx3qh761oUE4deHh96OELXdtZZZ8j2WQvPgqzlk4dnAWYQ5/gbAL//C
TWZm1Ts640pQ9AQkfOtgx0qEA/OoLcE/5h/a5K3RV92ExtOxUm2j0+TqK9evzCjH
XH7FjdgG4+KjlOZZ/XCxcOW7UfOxh8CODShiYFAIaiVuqAQJGHARAsroJOiP7NzU
op9rq1+sxsXN4Mv05z/NCG2EHNgeOBK74LcVtc+p2D7QP4H2xhOELwWAQEuwFhKZ
M6FqdSWAgBQ5ysa+rjCDVE+V6rlgnPgcNipoPrBErCfEqGFauQBnrX4D4lXgMkE=
-----END CERTIFICATE-----`;
const key = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDKKXAmLJwmKrgq
0B5+s7RWhxg3MkLqrUseAOLeIP0RywHBMwlfQvfQBAwOyBa38eTLeoN9z6/cTnMa
ef5xFfB8kt1yHXr1K9NhlN1yLc2kJ8erGCbjMaatUQkWkm41JaeSkiDrwzFbNy94
BOHfzIA2dgZLAJp0m/x1/DQwoW2AVc/jSTkWvpkEylf9HTFS+leWRtJShEGJucfT
UVHB3jJ7MKAOIrLonMhDruS0Zf5AHdRte/R0KIdqcdwsc95JFxFj5HvXGiB8Uqwr
yF/4M2dxTz81Pobf28lijYx9OqPOX992aKfK7iAp35TNdmgEwiWyeIJ4GGgEryPX
IeZzIoLhAgMBAAECggEAPR0xzhiGS/N2IVsxHNRunAnTBDyphhBFORjDfKs0VgCs
0x7+olG4YKYYjw9l7s2tgOXUgmAapdsBaOugQ8eCH+a2Ex1eYmeRS1qZZz75f7qW
3d47Q0trO9HXkX9K2b48Xk7WrO8hKJYSP5IaRnGoAM7FMD9Kch4FwBUyIdFrLPQ6
iY6xbnG9JjAdo0XRQUGrJIB3mntXH8GYIGMgIFpuxzI5Tc1jzvLy5YrZN7zw9cok
BCAWqQS38rh+DhcX5P33hc/gQK29Gl5SMvJrBn2A75zu3L0Hp9R6+oOBMGxou1C+
4mHuevLMnaeFs/LDdx4V9YCdtAQD+6UF5HqT5gJgkQKBgQDgim2UDY3h7akFrf1c
zpNZdt7ba1aZ2yzG9B5+WRxFtCW3RdE24ysHxEwT/U5SGnB/AAf9dxQ9oOs29TZe
UCKrlZlp83IDX4UUi2iVpMbNPxWNw3bExNasuwdp9ylOWjAANY3LXIdv24C6snns
607zN+FGMpIpjX3IiGeani2CbwKBgQDmfFmq9w8tJEswdnbcv0lR4JzjsIIj/3tG
1DL5Z7DT/7qifUmOQxHnDIR6krq7dmwH+Q4bkV+8sS0djwomc5TFr5mAl9wI9CI/
En0SGxRvBio1A9iNEJPiNfAleIFfsPNRzOm8RXMMGCZ4lMCIaPl2jfCPEGu6q8vG
LKkhs0e3rwKBgBwVlFERRO6+MAbS1T63Y7yr3oHpMgK6ZCZaQDojYSLivljm9Zz8
2tP03GMfqp0gS3PHCDjOnQx8RQ8xqmQvd7aoVnDnDxqW5ulD6ofU/TyMqGB70y4X
RJaEKhA55sOzCg/sotiNsS7vcHFpg1B7ufs3wQhrqNZjqRjc3sB7CkwnAoGBANgx
ceZkwa6FKaX2qL2dC8gqWN9V9GyRuu+QIZRBx+LDMCw0OuefT86atjVHJrKqfODp
o2sGbHfQ9VGRl2LD7ZuUf/bX+wPHA8yHqhtunTca4EJELj77esun7m8nXqsEjud+
vwvjVOvWR1e5p/MMDFtA/pEjRPmfJY/o2miLAs1vAoGAVqJPG0wXN52v4+7A22+y
p0NIkn7TygT6Nt1kXNA2oW/9Ol9BIWlxHwTGWKJkkEztnBQuM/woFvpNsKmO64vY
tmI+IMpV56cY5L5B2OJGlFcxaP7UxOyxvN+FkG+gZS3bwG31G06WxJ4tXjHNryED
ImR3PdM/asHjyws54heEMoM=
-----END PRIVATE KEY-----`;

let target: Server, secureTarget: Server, proxy: Server, secureProxy: Server;
let targetPort: number,
  secureTargetPort: number,
  proxyPort: number,
  secureProxyPort: number;
const sockets = new Set<Socket>();
let mode = "tunnel",
  connectDelay = 0;
let tunnels: {
  authority: string;
  headers: IncomingHttpHeaders;
  encrypted: boolean;
}[] = [];
let targetHits: {
  url: string;
  headers: IncomingHttpHeaders;
  sni: string | false;
}[] = [];
let wire: Buffer[] = [];
let proxySni: string | false = false;
const originalCa = tls.getCACertificates("default");
function track(socket: Socket) {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
}
async function listen(server: Server) {
  server.on("connection", track);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error("Fixture condition was not reached");
}
function trace() {
  return new QueryTrace({
    provider: "custom",
    operation: "test",
    timeoutSeconds: 10,
    dnsMode: "system",
  });
}
function url(path = "/balance", secure = false, host = "target.example") {
  return `${secure ? "https" : "http"}://${host}:${secure ? secureTargetPort : targetPort}${path}`;
}
function setProxy(secure = false, auth = false) {
  vi.stubEnv(
    "RELAYDOCK_QUERY_PROXY_URL",
    `${secure ? "https" : "http"}://${auth ? "proxy-user:proxy%2Dsecret@" : ""}proxy.example:${secure ? secureProxyPort : proxyPort}`,
  );
}
async function failure(input = url(), queryTrace = trace()) {
  const error: unknown = await safeJsonRequest(
    input,
    "provider-secret",
    "user-fixture",
    { trace: queryTrace },
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(QueryFailure);
  if (!(error instanceof QueryFailure))
    throw new Error("Expected a safe query failure");
  for (const secret of [
    "provider-secret",
    "proxy-secret",
    "proxy%2Dsecret",
    "proxy-user",
    "user-fixture",
    "proxy.example",
    "target.example",
  ])
    expect(
      `${error.message} ${JSON.stringify(queryTrace.finish(error))}`,
    ).not.toContain(secret);
  return error;
}
beforeAll(async () => {
  const handle: http.RequestListener = (req, res) => {
    targetHits.push({
      url: req.url || "",
      headers: req.headers,
      sni: (req.socket as tls.TLSSocket).servername || false,
    });
    if (req.url === "/upgrade") {
      res.writeHead(101, { Connection: "Upgrade", Upgrade: "provider-secret" });
      res.flushHeaders();
      return;
    }
    if (req.url === "/premature-close") {
      req.socket.destroy();
      return;
    }
    if (req.url === "/stall") return;
    if (req.url === "/read-stall") {
      res.writeHead(200);
      res.write("{");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, {
        Location: "http://169.254.169.254/provider-secret",
      });
      res.end();
      return;
    }
    if (req.url === "/large") {
      res.end("x".repeat(1048577));
      return;
    }
    if (req.url === "/invalid") {
      res.end("proxy-secret provider-secret");
      return;
    }
    res.end(JSON.stringify({ balance: 7 }));
  };
  target = http.createServer(handle);
  secureTarget = https.createServer({ key, cert }, handle);
  proxy = http.createServer();
  secureProxy = https.createServer({ key, cert });
  for (const server of [proxy, secureProxy]) {
    server.on("connect", (req, client, head) => {
      track(client as Socket);
      // CONNECT hands ownership of a half-open socket to the fixture. Observe
      // FIN even in stall modes, and close its server-side half on cancellation.
      client.on("end", () => client.destroy());
      tunnels.push({
        authority: req.url || "",
        headers: req.headers,
        encrypted: !!(client as tls.TLSSocket).encrypted,
      });
      proxySni = (client as tls.TLSSocket).servername || false;
      if (mode === "stall") {
        client.resume();
        return;
      }
      if (mode === "close") {
        client.destroy();
        return;
      }
      if (mode === "head") {
        client.end(
          "HTTP/1.1 200 Connection Established\r\n\r\nproxy-secret provider-secret",
        );
        return;
      }
      if (mode === "large-header") {
        client.end(
          `HTTP/1.1 200 Connection Established\r\nX-Untrusted: ${"x".repeat(17000)}\r\n\r\n`,
        );
        return;
      }
      if (mode === "407" || mode === "redirect") {
        client.end(
          `HTTP/1.1 ${mode === "407" ? "407 Proxy Authentication Required" : "302 Found"}\r\nLocation: http://169.254.169.254/proxy-secret\r\nContent-Length: 27\r\n\r\nproxy-secret provider-secret`,
        );
        return;
      }
      const forward = () => {
        const authority = req.url || "";
        const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(authority);
        if (!match || !isIP(match[1].replace(/^\[|\]$/g, ""))) {
          client.destroy();
          return;
        }
        const port = Number(match[2]);
        // The fixture never connects anywhere outside its own target servers.
        if (![targetPort, secureTargetPort].includes(port)) {
          client.destroy();
          return;
        }
        if (mode === "tls-stall") {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          client.resume();
          return;
        }
        const upstream = connect(port, "127.0.0.1", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          client.on("data", (chunk: Buffer) => wire.push(Buffer.from(chunk)));
          client.pipe(upstream);
          upstream.pipe(client);
        });
        track(upstream);
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
      };
      if (connectDelay) setTimeout(forward, connectDelay);
      else forward();
    });
  }
  targetPort = await listen(target);
  secureTargetPort = await listen(secureTarget);
  proxyPort = await listen(proxy);
  secureProxyPort = await listen(secureProxy);
});
beforeEach(() => {
  mode = "tunnel";
  connectDelay = 0;
  tunnels = [];
  targetHits = [];
  wire = [];
  proxySni = false;
  dns.hits = [];
  dns.target = [{ address: "127.0.0.1", family: 4 }];
  dns.proxy = [{ address: "127.0.0.1", family: 4 }];
  dns.targetDelay = 0;
  dns.proxyDelay = 0;
  dns.fail = "";
  vi.stubEnv("RELAYDOCK_PRIVATE_HOSTS", "target.example,wrong.example");
  vi.stubEnv("RELAYDOCK_DNS_MODE", "system");
  vi.stubEnv("RELAYDOCK_QUERY_PROXY_URL", "");
  tls.setDefaultCACertificates([...originalCa, cert]);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  tls.setDefaultCACertificates(originalCa);
  for (const socket of sockets) socket.destroy();
  await until(() => sockets.size === 0);
});
afterAll(async () => {
  await Promise.all(
    [target, secureTarget, proxy, secureProxy].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

it("is disabled by default and ignores all ambient/OS proxy environment hints", async () => {
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ])
    vi.stubEnv(name, `http://proxy.example:${proxyPort}`);
  vi.stubEnv("NODE_USE_ENV_PROXY", "1");
  expect(await safeJsonRequest(url(), "provider-secret", "")).toEqual({
    balance: 7,
  });
  expect(tunnels).toHaveLength(0);
  expect(dns.hits).toEqual(["target.example"]);
});
it.each([false, true])(
  "settles proxied origin 101 with target HTTPS=%s, destroys the tunnel and clears its deadline",
  async (secure) => {
    setProxy(false, true);
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    const transport = secure ? https : http,
      nativeRequest = transport.request;
    let closed = false;
    vi.spyOn(transport, "request").mockImplementation(
      (...args: Parameters<typeof http.request>) => {
        const request = Reflect.apply(
          nativeRequest,
          transport,
          args,
        ) as http.ClientRequest;
        if (args[1]?.method === "GET")
          request.once("close", () => {
            closed = true;
          });
        return request;
      },
    );
    const queryTrace = trace();
    let settled = false;
    const result = failure(url("/upgrade", secure), queryTrace).finally(() => {
      settled = true;
    });
    await until(() => closed);
    await vi.advanceTimersByTimeAsync(10001);
    expect(settled).toBe(true);
    expect(await result).toMatchObject({ code: "http_error", httpStatus: 101 });
    expect(
      queryTrace.finish().stages.find((s) => s.id === "response")?.status,
    ).toBe("error");
    expect(tunnels).toHaveLength(1);
    expect(targetHits).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await until(() => sockets.size === 0);
  },
);
it.each(["connect", "response", "read"])(
  "settles proxied request close without an error in %s phase and destroys pending proxy sockets",
  async (phase) => {
    setProxy(false, true);
    if (phase === "connect") mode = "stall";
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    const nativeRequest = http.request;
    let request: http.ClientRequest | undefined;
    vi.spyOn(http, "request").mockImplementation(
      (...args: Parameters<typeof http.request>) => {
        const result = Reflect.apply(
          nativeRequest,
          http,
          args,
        ) as http.ClientRequest;
        if (args[1]?.method === "GET") request = result;
        return result;
      },
    );
    const queryTrace = trace(),
      stages = vi.spyOn(queryTrace, "begin");
    let settled = false;
    const result = failure(
      url(phase === "read" ? "/read-stall" : "/stall"),
      queryTrace,
    ).finally(() => {
      settled = true;
    });
    await until(() =>
      phase === "connect"
        ? tunnels.length === 1
        : phase === "read"
          ? stages.mock.calls.some(([id]) => id === "read")
          : targetHits.length === 1,
    );
    expect(request).toBeDefined();
    // Exercise a bare request close, without the error/aborted event on which the
    // previous implementation depended. The actual CONNECT socket remains real.
    request!.emit("close");
    await vi.advanceTimersByTimeAsync(10001);
    expect(settled).toBe(true);
    expect((await result).code).toBe(
      phase === "connect"
        ? "proxy_failed"
        : phase === "read"
          ? "read_failed"
          : "response_failed",
    );
    expect(queryTrace.finish().stages.find((s) => s.id === phase)?.status).toBe(
      "error",
    );
    expect(request!.destroyed).toBe(true);
    expect(tunnels).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await until(() => sockets.size === 0);
  },
);
it("settles a real proxied premature origin socket close without retry", async () => {
  setProxy(false, true);
  expect((await failure(url("/premature-close"))).code).toBe("response_failed");
  expect(tunnels).toHaveLength(1);
  expect(targetHits).toHaveLength(1);
  await until(() => sockets.size === 0);
});
it.each([false, true])(
  "CONNECTs HTTP target to a pinned IP via secure proxy=%s, preserving Host and separating auth",
  async (secure) => {
    setProxy(secure, true);
    const queryTrace = trace();
    expect(
      await safeJsonRequest(url(), "provider-secret", "user-fixture", {
        trace: queryTrace,
        authHeader: "x-api-key",
      }),
    ).toEqual({ balance: 7 });
    expect(tunnels).toHaveLength(1);
    expect(tunnels[0]).toMatchObject({
      authority: `127.0.0.1:${targetPort}`,
      encrypted: secure,
      headers: {
        host: `127.0.0.1:${targetPort}`,
        "proxy-authorization": `Basic ${Buffer.from("proxy-user:proxy-secret").toString("base64")}`,
      },
    });
    expect(JSON.stringify(tunnels[0])).not.toContain("provider-secret");
    expect(JSON.stringify(tunnels[0])).not.toContain("user-fixture");
    expect(tunnels[0].headers.authorization).toBeUndefined();
    expect(tunnels[0].headers["x-api-key"]).toBeUndefined();
    expect(tunnels[0].headers["new-api-user"]).toBeUndefined();
    expect(targetHits).toHaveLength(1);
    expect(targetHits[0].headers).toMatchObject({
      host: `target.example:${targetPort}`,
      "x-api-key": "provider-secret",
      "new-api-user": "user-fixture",
      "content-type": "application/json",
      "user-agent": "RelayDock-Atlas/1.0",
    });
    expect(targetHits[0].headers["proxy-authorization"]).toBeUndefined();
    expect(targetHits[0].headers.authorization).toBeUndefined();
    expect(dns.hits).toEqual(["target.example", "proxy.example"]);
    if (secure) expect(proxySni).toBe("proxy.example");
    expect(
      queryTrace
        .finish()
        .stages.filter((s) =>
          ["dns", "connect", "response", "read"].includes(s.id),
        )
        .every((s) => s.status === "success"),
    ).toBe(true);
    await until(() => sockets.size === 0);
  },
);
it.each([false, true])(
  "encrypts target HTTPS inside CONNECT with original SNI via secure proxy=%s",
  async (secure) => {
    setProxy(secure, true);
    expect(
      await safeJsonRequest(url("/balance", true), "provider-secret", ""),
    ).toEqual({ balance: 7 });
    expect(tunnels).toHaveLength(1);
    expect(tunnels[0].authority).toBe(`127.0.0.1:${secureTargetPort}`);
    expect(targetHits[0]).toMatchObject({
      sni: "target.example",
      headers: {
        host: `target.example:${secureTargetPort}`,
        authorization: "Bearer provider-secret",
      },
    });
    const tunneled = Buffer.concat(wire).toString("latin1");
    expect(tunneled).not.toContain("provider-secret");
    expect(tunneled).not.toContain("GET /balance");
    expect(tunneled).not.toContain("proxy-secret");
  },
);
it("formats a pinned IPv6 CONNECT authority without delegating target DNS", async () => {
  setProxy();
  dns.target = [{ address: "::1", family: 6 }];
  expect(await safeJsonRequest(url(), "provider-secret", "")).toEqual({
    balance: 7,
  });
  expect(tunnels[0].authority).toBe(`[::1]:${targetPort}`);
  expect(targetHits[0].headers.host).toBe(`target.example:${targetPort}`);
});
it("pins a locally resolved public target and both proxy and target lookups happen only once", async () => {
  setProxy();
  vi.stubEnv("RELAYDOCK_PRIVATE_HOSTS", "");
  dns.target = [
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ];
  await safeJsonRequest(url(), "provider-secret", "");
  expect(tunnels[0].authority).toBe(`8.8.8.8:${targetPort}`);
  expect(targetHits[0].headers.host).toBe(`target.example:${targetPort}`);
  expect(dns.hits).toEqual(["target.example", "proxy.example"]);
});
it.each(["http://127.0.0.1", "http://proxy.example"])(
  "permits an explicitly configured local/private proxy %s without a target allowlist entry for it",
  async (host) => {
    vi.stubEnv("RELAYDOCK_QUERY_PROXY_URL", `${host}:${proxyPort}`);
    await safeJsonRequest(url(), "provider-secret", "");
    expect(tunnels).toHaveLength(1);
  },
);
it("does not let a private proxy authorize a private target", async () => {
  setProxy();
  vi.stubEnv("RELAYDOCK_PRIVATE_HOSTS", "");
  expect((await failure()).code).toBe("unsafe_target");
  expect(tunnels).toHaveLength(0);
});
it("rejects a mixed public/private target answer before CONNECT", async () => {
  setProxy();
  vi.stubEnv("RELAYDOCK_PRIVATE_HOSTS", "");
  dns.target = [
    { address: "8.8.8.8", family: 4 },
    { address: "::1", family: 6 },
  ];
  expect((await failure()).code).toBe("unsafe_target");
  expect(tunnels).toHaveLength(0);
});
it.each([
  "169.254.169.254",
  "100.100.100.200",
  "fd00:ec2::254",
  "::ffff:169.254.169.254",
])(
  "never permits target metadata %s even with a private target allowlist and proxy",
  async (address) => {
    setProxy();
    dns.target = [{ address, family: isIP(address) }];
    expect((await failure()).code).toBe("unsafe_target");
    expect(tunnels).toHaveLength(0);
    expect(targetHits).toHaveLength(0);
  },
);
it.each([
  "169.254.169.254",
  "100.100.100.200",
  "[fd00:ec2::254]",
  "0.0.0.0",
  "[::]",
  "224.0.0.1",
  "[ff02::1]",
  "[::ffff:169.254.169.254]",
])(
  "rejects forbidden proxy endpoint %s even though proxy private IPs are explicit",
  async (host) => {
    vi.stubEnv(
      "RELAYDOCK_QUERY_PROXY_URL",
      `http://proxy-user:proxy-secret@${host}:${proxyPort}`,
    );
    expect((await failure()).code).toBe("proxy_config");
    expect(tunnels).toHaveLength(0);
    expect(targetHits).toHaveLength(0);
  },
);
it("validates every proxy DNS answer, including IPv4-mapped metadata", async () => {
  setProxy();
  dns.proxy = [
    { address: "127.0.0.1", family: 4 },
    { address: "::ffff:100.100.100.200", family: 6 },
  ];
  expect((await failure()).code).toBe("proxy_config");
  expect(tunnels).toHaveLength(0);
});
it.each([
  "socks5://proxy-user:proxy-secret@proxy.example",
  "proxy.example:8080",
  "http://proxy.example:0",
  "http://proxy.example/path",
  "http://proxy.example/?provider-secret",
  "http://proxy.example/#proxy-secret",
  "http://proxy-user:bad%zz@proxy.example",
  "http://proxy%0Duser:proxy-secret@proxy.example",
  "http://proxy%3Auser:proxy-secret@proxy.example",
  "http://proxy.example\\path",
])("rejects malformed/unsupported proxy config safely: %s", async (config) => {
  vi.stubEnv("RELAYDOCK_QUERY_PROXY_URL", config);
  expect((await failure()).code).toBe("proxy_config");
  expect(dns.hits).toHaveLength(0);
  expect(tunnels).toHaveLength(0);
});
it.each(["407", "redirect", "close", "head", "large-header"])(
  "fails safely on proxy %s without retry, fallback, redirect, or provider auth",
  async (kind) => {
    setProxy(false, true);
    mode = kind;
    const queryTrace = trace(),
      error = await failure(url(), queryTrace);
    expect(error.code).toBe(kind === "407" ? "proxy_auth" : "proxy_failed");
    if (kind === "407") expect(error.httpStatus).toBe(407);
    expect(tunnels).toHaveLength(1);
    expect(targetHits).toHaveLength(0);
    expect(JSON.stringify(tunnels)).not.toContain("provider-secret");
    expect(
      queryTrace.finish().stages.find((s) => s.id === "connect")?.status,
    ).toBe("error");
    expect(
      queryTrace.finish().stages.find((s) => s.id === "response")?.status,
    ).toBe("not-run");
    await until(() => sockets.size === 0);
  },
);
it.each(["/redirect", "/large", "/invalid"])(
  "retains target redirect refusal, body cap and safe JSON errors for %s",
  async (path) => {
    setProxy(false, true);
    const expected = {
      "/redirect": "http_redirect",
      "/large": "response_too_large",
      "/invalid": "invalid_json",
    };
    expect((await failure(url(path))).code).toBe(
      expected[path as keyof typeof expected],
    );
    expect(tunnels).toHaveLength(1);
    expect(targetHits).toHaveLength(1);
  },
);
it.each(["target", "proxy"])(
  "preserves TLS hostname verification for %s rather than checking pinned IP",
  async (side) => {
    setProxy(side === "proxy", true);
    let input = url("/balance", true);
    if (side === "target") input = url("/balance", true, "wrong.example");
    else
      vi.stubEnv(
        "RELAYDOCK_QUERY_PROXY_URL",
        `https://proxy-user:proxy-secret@wrong.example:${secureProxyPort}`,
      );
    expect((await failure(input)).code).toBe(
      side === "proxy" ? "proxy_failed" : "tls_error",
    );
    expect(targetHits).toHaveLength(0);
    if (side === "proxy") expect(tunnels).toHaveLength(0);
  },
);
it("never accepts an untrusted target certificate", async () => {
  setProxy();
  tls.setDefaultCACertificates(originalCa);
  expect((await failure(url("/balance", true))).code).toBe("tls_error");
  expect(targetHits).toHaveLength(0);
});
it.each(["empty", "failed"])(
  "handles proxy DNS %s with safe errors and no direct fallback",
  async (kind) => {
    setProxy(false, true);
    if (kind === "empty") dns.proxy = [];
    else dns.fail = "proxy.example";
    expect((await failure()).code).toBe("proxy_failed");
    expect(tunnels).toHaveLength(0);
    expect(targetHits).toHaveLength(0);
  },
);
it.each(["stall", "tls-stall"])(
  "closes a stalled proxy %s at the shared connect deadline",
  async (kind) => {
    setProxy();
    mode = kind;
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    const queryTrace = trace(),
      result = failure(url("/balance", kind === "tls-stall"), queryTrace);
    await until(() => tunnels.length === 1);
    await vi.advanceTimersByTimeAsync(10000);
    expect((await result).code).toBe(
      kind === "stall" ? "proxy_timeout" : "connect_timeout",
    );
    expect(queryTrace.finish().totalMs).toBe(10000);
    expect(targetHits).toHaveLength(0);
    expect(tunnels).toHaveLength(1);
    await until(() => sockets.size === 0);
  },
);
it("times out proxy DNS within the original budget and creates no socket", async () => {
  setProxy();
  dns.targetDelay = 9000;
  dns.proxyDelay = 2000;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
  const queryTrace = trace(),
    result = failure(url(), queryTrace);
  await vi.advanceTimersByTimeAsync(10000);
  expect((await result).code).toBe("proxy_timeout");
  expect(queryTrace.finish().totalMs).toBe(10000);
  expect(queryTrace.finish().stages.find((s) => s.id === "dns")?.status).toBe(
    "error",
  );
  expect(tunnels).toHaveLength(0);
  expect(targetHits).toHaveLength(0);
});
it("retains read timeout after a CONNECT tunnel is established and closes it", async () => {
  setProxy();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
  const queryTrace = trace(),
    stages = vi.spyOn(queryTrace, "begin");
  const result = failure(url("/read-stall"), queryTrace);
  await until(() => targetHits.length === 1);
  await until(() => stages.mock.calls.some(([id]) => id === "read"));
  await vi.advanceTimersByTimeAsync(10000);
  expect((await result).code).toBe("read_timeout");
  expect(queryTrace.finish().stages.find((s) => s.id === "read")?.status).toBe(
    "error",
  );
  await until(() => sockets.size === 0);
});
it("uses one total deadline across target DNS, proxy DNS, CONNECT and target response", async () => {
  setProxy();
  dns.targetDelay = 3000;
  dns.proxyDelay = 1000;
  connectDelay = 2000;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
  const queryTrace = trace(),
    result = failure(url("/stall"), queryTrace);
  await vi.advanceTimersByTimeAsync(4000);
  await until(() => tunnels.length === 1);
  await vi.advanceTimersByTimeAsync(2000);
  await until(() => targetHits.length === 1);
  await vi.advanceTimersByTimeAsync(4000);
  expect((await result).code).toBe("response_timeout");
  const d = queryTrace.finish();
  expect(d.totalMs).toBe(10000);
  expect(d.stages.find((s) => s.id === "dns")?.durationMs).toBe(4000);
  expect(d.stages.find((s) => s.id === "connect")?.status).toBe("success");
  expect(d.stages.find((s) => s.id === "response")?.status).toBe("error");
  expect(tunnels).toHaveLength(1);
  expect(targetHits).toHaveLength(1);
});
it.each([
  "proxy_config",
  "proxy_auth",
  "proxy_failed",
  "proxy_timeout",
] as const)(
  "exposes fixed proxy-specific frontend text and help for %s, never arbitrary error text",
  (code) => {
    const error = new QueryFailure(
      code,
      "http://proxy-user:proxy-secret@proxy.example provider-secret",
    );
    const d = trace().finish(error);
    expect(normalizeDiagnostic(d)).toEqual(d);
    expect(publicQueryError(d)).toContain("代理");
    const explanation = diagnosticExplanation(d);
    expect(explanation.title).toContain("代理");
    expect(explanation.hint).toContain("代理");
    expect(
      JSON.stringify({ message: publicQueryError(d), explanation }),
    ).not.toContain("proxy-secret");
    expect(
      JSON.stringify({ message: publicQueryError(d), explanation }),
    ).not.toContain("proxy.example");
  },
);
