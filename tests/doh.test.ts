import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
const state = vi.hoisted(() => ({
  requests: [] as {
    host: string;
    headers: Record<string, string>;
    pinned: string;
  }[],
  kind: "ok",
  dnsDelay: 0,
  destroyedDns: [] as string[],
  upgradedSocketDestroyed: false,
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () =>
    state.kind === "resolver-empty"
      ? []
      : state.kind === "resolver-private"
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "1.1.1.1", family: 4 }],
  ),
}));
vi.mock("node:https", () => ({
  default: {
    request: (url: URL, options: any, callback: Function) => {
      const req: any = new EventEmitter();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let destroyed = false;
      req.destroy = () => {
        if (destroyed) return;
        destroyed = true;
        if (url.hostname === "cloudflare-dns.com")
          state.destroyedDns.push(url.searchParams.get("type")!);
        if (timer) clearTimeout(timer);
        req.emit("close");
      };
      options.signal?.addEventListener(
        "abort",
        () => {
          req.destroy();
          req.emit("error", new Error("aborted"));
        },
        { once: true },
      );
      req.end = () => {
        options.lookup(url.hostname, {}, (_error: unknown, address: string) =>
          state.requests.push({
            host: url.hostname,
            headers: options.headers,
            pinned: address,
          }),
        );
        const socket = new EventEmitter();
        req.emit("socket", socket);
        socket.emit("secureConnect");
        const resolver = url.hostname === "cloudflare-dns.com";
        if (
          resolver &&
          ["redirect", "upgrade", "close-without-response", "resolver-stall"].includes(state.kind) &&
          url.searchParams.get("type") === "AAAA"
        )
          return;
        if (resolver && state.kind === "resolver-stall") return;
        if (!resolver && state.kind === "stall") return;
        timer = setTimeout(
          () => {
            const res: any = new EventEmitter();
            res.resume = () => { };
            res.statusCode = resolver && state.kind === "redirect" ? 302 : 200;
            if (resolver && state.kind === "upgrade") {
              res.statusCode = 101;
              const upgraded = Object.assign(new EventEmitter(), {
                destroy: () => { state.upgradedSocketDestroyed = true; },
              });
              req.emit("upgrade", res, upgraded, Buffer.from("fixture-secret"));
              req.emit("close");
              return;
            }
            if (resolver && state.kind === "close-without-response") {
              req.emit("close");
              return;
            }
            callback(res);
            let data: unknown = { balance: "3" };
            if (resolver) {
              const family = url.searchParams.get("type") === "A" ? 4 : 6;
              data = {
                Status: 0,
                Answer: [
                  {
                    type: family === 4 ? 1 : 28,
                    data:
                      family === 4
                        ? "8.8.8.8"
                        : state.kind === "private"
                          ? "::1"
                          : "2606:4700:4700::1111",
                  },
                ],
              };
            }
            if (state.kind === "malformed" && resolver)
              res.emit("data", Buffer.from("<html>echo fixture-secret</html>"));
            else res.emit("data", Buffer.from(JSON.stringify(data)));
            res.emit("end");
            req.emit("close");
          },
          resolver ? state.dnsDelay : 0,
        );
      };
      return req;
    },
  },
}));
import { safeJsonRequest } from "../src/lib/outbound";
import { QueryFailure, QueryTrace } from "../src/lib/query-trace";
const old = process.env.RELAYDOCK_DNS_MODE;
beforeEach(() => {
  state.requests = [];
  state.kind = "ok";
  state.dnsDelay = 0;
  state.destroyedDns = [];
  state.upgradedSocketDestroyed = false;
  process.env.RELAYDOCK_DNS_MODE = "cloudflare";
});
afterEach(() => {
  vi.useRealTimers();
  if (old === undefined) delete process.env.RELAYDOCK_DNS_MODE;
  else process.env.RELAYDOCK_DNS_MODE = old;
});
it("defaults to system DNS without contacting DoH", async () => {
  delete process.env.RELAYDOCK_DNS_MODE;
  await safeJsonRequest(
    "https://relay.example/user/balance",
    "fixture-secret",
    "",
  );
  expect(state.requests.map((r) => r.host)).toEqual(["relay.example"]);
});
it.each([
  ["resolver-empty", "dns_failed"],
  ["resolver-private", "unsafe_target"],
])(
  "classifies the resolver's %s before making any HTTP request",
  async (kind, code) => {
    state.kind = kind;
    const error = await safeJsonRequest(
      "https://relay.example/user/balance",
      "fixture-secret",
      "",
    ).catch((e) => e);
    expect(error).toMatchObject({ code });
    expect(state.requests).toHaveLength(0);
  },
);
it("sends no credential to fixed resolver, validates and pins target IP", async () => {
  await safeJsonRequest(
    "https://relay.example/user/balance",
    "fixture-secret",
    "",
  );
  expect(state.requests).toHaveLength(3);
  for (const request of state.requests.filter(
    (r) => r.host === "cloudflare-dns.com",
  ))
    expect(JSON.stringify(request.headers)).not.toContain("fixture-secret");
  expect(state.requests.find((r) => r.host === "relay.example")).toMatchObject({
    pinned: "8.8.8.8",
    headers: { Authorization: "Bearer fixture-secret" },
  });
});
it("blocks mixed public/private answers before sending credential to target", async () => {
  state.kind = "private";
  await expect(
    safeJsonRequest("https://relay.example/balance", "fixture-secret", ""),
  ).rejects.toThrow("私有");
  expect(state.requests.every((r) => r.host === "cloudflare-dns.com")).toBe(
    true,
  );
});
it.each(["redirect", "malformed"])(
  "refuses resolver %s without fallback or secret echo",
  async (kind) => {
    state.kind = kind;
    await expect(
      safeJsonRequest("https://relay.example/balance", "fixture-secret", ""),
    ).rejects.not.toThrow("fixture-secret");
    expect(state.requests.every((r) => r.host === "cloudflare-dns.com")).toBe(
      true,
    );
  },
);
it("shares one total timeout across DNS and provider response", async () => {
  vi.useFakeTimers();
  state.dnsDelay = 5000;
  state.kind = "stall";
  const request = safeJsonRequest(
    "https://relay.example/balance",
    "fixture-secret",
    "",
  );
  const check = expect(request).rejects.toThrow("10 秒");
  await vi.advanceTimersByTimeAsync(9999);
  expect(state.requests).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  await check;
});
it("cancels the sibling DNS request immediately when a resolver response is rejected", async () => {
  vi.useFakeTimers();
  state.kind = "redirect";
  const request = safeJsonRequest(
    "https://relay.example/balance",
    "fixture-secret",
    "",
  );
  const check = expect(request).rejects.toThrow("DNS-over-HTTPS");
  await vi.advanceTimersByTimeAsync(0);
  await check;
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["upgrade", "close-without-response"])(
  "settles resolver %s safely and aborts its stalled sibling before the shared deadline",
  async (kind) => {
    vi.useFakeTimers();
    state.kind = kind;
    state.dnsDelay = 1000;
    const trace = new QueryTrace({
      provider: "custom", operation: "test", timeoutSeconds: 10, dnsMode: "cloudflare",
    });
    let settled = false;
    const result = safeJsonRequest("https://relay.example/balance", "fixture-secret", "", { trace })
      .catch((error: unknown) => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
    const error = await result;
    expect(error).toBeInstanceOf(QueryFailure);
    if (!(error instanceof QueryFailure)) throw new Error("Expected a safe DNS failure");
    expect(error.code).toBe("dns_failed");
    expect(error.message).not.toContain("fixture-secret");
    expect(trace.finish(error).stages.find((s) => s.id === "dns")?.status).toBe("error");
    expect(state.requests.map((r) => r.host)).toEqual(["cloudflare-dns.com", "cloudflare-dns.com"]);
    expect(state.destroyedDns.sort()).toEqual(["A", "AAAA"]);
    if (kind === "upgrade") expect(state.upgradedSocketDestroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10001);
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("keeps DNS timeout classification and aborts both stalled resolver requests", async () => {
  vi.useFakeTimers();
  state.kind = "resolver-stall";
  const result = safeJsonRequest("https://relay.example/balance", "fixture-secret", "").catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await result).toMatchObject({ code: "dns_timeout" });
  expect(state.destroyedDns.sort()).toEqual(["A", "AAAA"]);
  expect(vi.getTimerCount()).toBe(0);
});
