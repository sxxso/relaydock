import { expect, it } from "vitest";
import { QueryTrace, QueryFailure } from "../src/lib/query-trace";
import {
  diagnosticReport,
  normalizeDiagnostic,
  diagnosticExplanation,
  publicQueryError,
} from "../src/lib/query-diagnostics";

const config = {
  provider: "newapi" as const,
  operation: "sync" as const,
  timeoutSeconds: 10 as const,
  dnsMode: "system" as const,
};
const fixture = {
  schemaVersion: 1,
  ...config,
  startedAt: "2026-10-03T00:00:00.000Z",
  finishedAt: "2026-10-03T00:00:00.001Z",
  totalMs: 1,
  outcome: "failure",
  category: "auth",
  code: "http_auth",
  httpStatus: 403,
  stages: ["dns", "connect", "response", "read", "parse"].map((id) => ({
    id,
    status: "not-run",
    durationMs: null,
  })),
};

it("records actual completed stages and distinguishes skipped DNS from unexecuted work", () => {
  let now = 0;
  const t = new QueryTrace(config, () => now);
  t.skip("dns");
  t.begin("connect");
  now = 12;
  t.end();
  t.begin("response");
  now = 65;
  t.end();
  t.begin("read");
  now = 81;
  t.end();
  t.begin("parse");
  now = 83;
  t.end();
  const d = t.finish();
  expect(d.totalMs).toBe(83);
  expect(d.outcome).toBe("success");
  expect(d.stages.map((s) => [s.id, s.status, s.durationMs])).toEqual([
    ["dns", "skipped", 0],
    ["connect", "success", 12],
    ["response", "success", 53],
    ["read", "success", 16],
    ["parse", "success", 2],
  ]);
  now = 900;
  expect(t.finish()).toEqual(d);
});

it("marks the active failure stage without fabricating durations for later stages", () => {
  let now = 0;
  const t = new QueryTrace(config, () => now);
  t.begin("dns");
  now = 7;
  t.end();
  t.begin("connect");
  now = 10000;
  const d = t.finish(new QueryFailure("connect_timeout", "fixed safe error"));
  expect(d.category).toBe("network");
  expect(d.code).toBe("connect_timeout");
  expect(d.stages.find((s) => s.id === "connect")).toMatchObject({
    status: "error",
    durationMs: 9993,
  });
  expect(d.stages.find((s) => s.id === "response")).toMatchObject({
    status: "not-run",
    durationMs: null,
  });
  expect(diagnosticExplanation(d).title).toContain("网络");
});

it("does not infer authentication failure from a HTTP 200 business rejection", () => {
  const t = new QueryTrace(config);
  const d = t.finish(new QueryFailure("provider_rejected", "fixed safe error"));
  expect(d.category).toBe("service");
  expect(diagnosticExplanation(d).hint).toContain("不能");
});

it("explains an empty response without claiming a JSON field mismatch or exposing upstream text", () => {
  const d = normalizeDiagnostic({
    ...fixture,
    category: "service",
    code: "response_empty",
    httpStatus: 200,
    body: "credential-private",
  });
  expect(d).not.toBeNull();
  if (!d) throw new Error("Expected a valid empty-response diagnostic");
  expect(diagnosticExplanation(d).title).toBe("站点返回空响应");
  expect(diagnosticExplanation(d).hint).toContain("网络出口");
  expect(publicQueryError(d)).toContain("空响应");
  expect(diagnosticReport(d)).not.toContain("credential-private");
});
it("serializes a strict whitelist, not secrets smuggled into extra object properties", () => {
  const d = fixture;
  const injected = {
    ...d,
    account: "personal-account",
    url: "https://secret.example/?token=private",
    error: "secret-in-message",
    headers: { authorization: "private" },
    stages: d.stages.map((s) => ({
      ...s,
      ip: "192.168.0.1",
      token: "private",
    })),
  };
  const report = diagnosticReport(injected);
  for (const secret of [
    "personal-account",
    "secret.example",
    "private",
    "192.168.0.1",
    "secret-in-message",
    "headers",
  ])
    expect(report).not.toContain(secret);
  const parsed = JSON.parse(report);
  expect(parsed.code).toBe("http_auth");
  expect(parsed.httpStatus).toBe(403);
  expect(normalizeDiagnostic(injected)).toEqual(d);
});

it("rejects invalid or attacker-controlled free-text codes instead of exporting them", () => {
  const d = fixture;
  expect(normalizeDiagnostic({ ...d, code: "credential-secret" })).toBeNull();
  expect(normalizeDiagnostic({ ...d, totalMs: Infinity })).toBeNull();
  expect(normalizeDiagnostic({ ...d, provider: "secret-provider" })).toBeNull();
  expect(normalizeDiagnostic({ ...d, stages: [] })).toBeNull();
  expect(() =>
    diagnosticReport({ ...d, dnsMode: "private resolver" }),
  ).toThrow();
});
