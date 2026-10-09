import { afterEach, expect, it, vi } from "vitest";
import { safeJsonRequest } from "../src/lib/outbound";
import { QueryFailure, QueryTrace } from "../src/lib/query-trace";
import { EventEmitter } from "node:events";
const state = vi.hoisted(() => ({ mode: "dns-fail", dnsHits: 0, httpHits: 0 }));
vi.mock("node:dns/promises", () => ({
  lookup: async () => {
    state.dnsHits++;
    if (state.mode === "dns-stall") return await new Promise(() => {});
    if (state.mode === "dns-fail")
      throw new Error("malicious DNS error echoes credential-private");
    if (state.mode === "empty-dns") return [];
    if (state.mode === "clock-rewind") {
      await new Promise((r) => setTimeout(r, 9000));
      vi.setSystemTime(Date.now() - 300000);
    }
    return [{ address: "8.8.8.8", family: 4 }];
  },
}));
vi.mock("node:https", () => ({
  default: {
    request: () => {
      state.httpHits++;
      const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: () => void;
      };
      req.destroy = () => req.emit("close");
      req.end = () =>
        queueMicrotask(() => {
          const socket = new EventEmitter();
          req.emit("socket", socket);
          if (state.mode === "connect-stall") return;
          if (state.mode === "clock-rewind" || state.mode === "response-reset")
            socket.emit("secureConnect");
          if (state.mode === "clock-rewind") return;
          const error = Object.assign(new Error("credential-private"), {
            code:
              state.mode === "tls"
                ? "CERT_HAS_EXPIRED"
                : state.mode === "response-reset"
                  ? "ECONNRESET"
                  : "ECONNREFUSED",
          });
          req.emit("error", error);
          req.emit("close");
        });
      return req;
    },
  },
}));
const old = process.env.RELAYDOCK_DNS_MODE;
function failureDiagnostic(trace: QueryTrace, error: unknown) {
  expect(error).toBeInstanceOf(QueryFailure);
  if (!(error instanceof QueryFailure))
    throw new Error("Expected a typed query failure");
  return trace.finish(error);
}
afterEach(() => {
  vi.useRealTimers();
  state.dnsHits = 0;
  state.httpHits = 0;
  if (old === undefined) delete process.env.RELAYDOCK_DNS_MODE;
  else process.env.RELAYDOCK_DNS_MODE = old;
});
it.each([
  ["dns-fail", "dns_failed"],
  ["dns-stall", "dns_timeout"],
  ["connect-stall", "connect_timeout"],
  ["tls", "tls_error"],
  ["refused", "connect_failed"],
])(
  "classifies %s at its actual stage, without raw network error text or retry",
  async (mode, code) => {
    state.mode = mode;
    process.env.RELAYDOCK_DNS_MODE = "system";
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    const trace = new QueryTrace({
      provider: "newapi",
      operation: "test",
      timeoutSeconds: 10,
      dnsMode: "system",
    });
    const result = safeJsonRequest(
      "https://relay.example/api/user/self",
      "credential-private",
      "",
      { trace },
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10000);
    const error = await result;
    expect(error).toBeInstanceOf(QueryFailure);
    if (!(error instanceof QueryFailure))
      throw new Error("Expected a typed query failure");
    expect(error.code).toBe(code);
    expect(error.message).not.toContain("credential-private");
    const d = trace.finish(error);
    expect(d.category).toBe("network");
    expect(
      d.stages.find(
        (s) => s.id === (mode.startsWith("dns") ? "dns" : "connect"),
      )?.status,
    ).toBe("error");
    expect(d.stages.find((s) => s.id === "response")).toMatchObject({
      status: "not-run",
      durationMs: null,
    });
    expect(state.dnsHits).toBe(1);
    expect(state.httpHits).toBe(mode.startsWith("dns") ? 0 : 1);
  },
);
it.each(["中文密钥", "key\u0001invalid", "key\u007finvalid"])(
  "rejects invalid header value %s before DNS or a socket attempt",
  async (token) => {
    state.mode = "refused";
    process.env.RELAYDOCK_DNS_MODE = "system";
    const trace = new QueryTrace({
      provider: "newapi",
      operation: "test",
      timeoutSeconds: 10,
      dnsMode: "system",
    });
    const error = await safeJsonRequest(
      "https://relay.example/api/user/self",
      token,
      "",
      { trace },
    ).catch((e) => e);
    expect(error).toMatchObject({ code: "invalid_config" });
    expect(
      failureDiagnostic(trace, error).stages.every(
        (s) => s.status === "not-run",
      ),
    ).toBe(true);
    expect(state.dnsHits).toBe(0);
    expect(state.httpHits).toBe(0);
  },
);
it("classifies empty DNS results as a network error, not an SSRF denial", async () => {
  state.mode = "empty-dns";
  process.env.RELAYDOCK_DNS_MODE = "system";
  const trace = new QueryTrace({
    provider: "newapi",
    operation: "test",
    timeoutSeconds: 10,
    dnsMode: "system",
  });
  const error = await safeJsonRequest(
    "https://relay.example/api/user/self",
    "fixture",
    "",
    { trace },
  ).catch((e) => e);
  expect(error).toMatchObject({ code: "dns_failed" });
  expect(failureDiagnostic(trace, error).category).toBe("network");
  expect(state.httpHits).toBe(0);
});
it("does not describe a reset after TLS connected as failure to connect", async () => {
  state.mode = "response-reset";
  process.env.RELAYDOCK_DNS_MODE = "system";
  const trace = new QueryTrace({
    provider: "newapi",
    operation: "test",
    timeoutSeconds: 10,
    dnsMode: "system",
  });
  const error = await safeJsonRequest(
    "https://relay.example/api/user/self",
    "fixture",
    "",
    { trace },
  ).catch((e) => e);
  expect(error).toMatchObject({ code: "response_failed" });
  const d = failureDiagnostic(trace, error);
  expect(d.stages.find((s) => s.id === "connect")?.status).toBe("success");
  expect(d.stages.find((s) => s.id === "response")?.status).toBe("error");
});
it("keeps the shared ten-second deadline when the wall clock rewinds during DNS", async () => {
  state.mode = "clock-rewind";
  process.env.RELAYDOCK_DNS_MODE = "system";
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
  const trace = new QueryTrace({
    provider: "newapi",
    operation: "test",
    timeoutSeconds: 10,
    dnsMode: "system",
  });
  let settled = false;
  const result = safeJsonRequest(
    "https://relay.example/api/user/self",
    "fixture",
    "",
    { trace },
  )
    .catch((e) => e)
    .finally(() => {
      settled = true;
    });
  await vi.advanceTimersByTimeAsync(10000);
  expect(settled).toBe(true);
  const error = await result;
  expect(error).toMatchObject({ code: "response_timeout" });
  expect(failureDiagnostic(trace, error).totalMs).toBe(10000);
});
