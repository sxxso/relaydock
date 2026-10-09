import { expect, it } from "vitest";
import { accountInput, querySchema } from "../src/lib/validation";
import { buildBalanceRequest } from "../src/lib/adapters";
import { QueryTrace } from "../src/lib/query-trace";
import {
  normalizeDiagnostic,
  diagnosticReport,
} from "../src/lib/query-diagnostics";
it("persists an explicit cc-switch profile and forwards it without arbitrary headers", () => {
  const a = accountInput.parse({
    name: "兼容夹具",
    siteUrl: "https://fixture.invalid",
    provider: "newapi",
    query: { requestProfile: "cc-switch" },
  });
  expect(a.query).toHaveProperty("requestProfile", "cc-switch");
  expect(buildBalanceRequest(a)).toHaveProperty("requestProfile", "cc-switch");
  expect(
    querySchema.safeParse({ requestProfile: "arbitrary-user-agent" }).success,
  ).toBe(false);
});
it("does not change legacy profile or copy unsafe diagnostic header values", () => {
  const t = new QueryTrace(
    Object.assign(
      {
        provider: "newapi" as const,
        operation: "test" as const,
        timeoutSeconds: 10 as const,
        dnsMode: "system" as const,
      },
      { requestProfile: "cc-switch" as const },
    ),
  );
  expect(t).toHaveProperty("response");
  const record = (
    t as unknown as { response: (value: unknown) => void }
  ).response.bind(t);
  record({
    mediaType: "html",
    encoding: "gzip",
    bodyKind: "unknown",
    wireBytes: 25,
    decodedBytes: 0,
    headers: { cookie: "fixture-secret" },
  });
  record({ bodyKind: "challenge", decodedBytes: 51 });
  const d = t.finish();
  expect(d).toMatchObject({
    requestProfile: "cc-switch",
    response: {
      mediaType: "html",
      encoding: "gzip",
      bodyKind: "challenge",
      wireBytes: 25,
      decodedBytes: 51,
    },
  });
  expect(diagnosticReport(d)).not.toContain("fixture-secret");
  expect(
    normalizeDiagnostic({ ...d, requestProfile: "secret-fixture" }),
  ).toBeNull();
  expect(
    normalizeDiagnostic({
      ...d,
      response: {
        ...JSON.parse(diagnosticReport(d)).response,
        mediaType: "secret-fixture",
      },
    }),
  ).toBeNull();
});
