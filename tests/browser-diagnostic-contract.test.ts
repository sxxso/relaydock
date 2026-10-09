import { expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
async function checker() {
  const file = resolve("scripts/diagnostic-feature-contract.ts");
  expect(existsSync(file), "current diagnostic browser contract is missing").toBe(true);
  return import(pathToFileURL(file).href);
}
const response = { mediaType: "json", encoding: "gzip", bodyKind: "json", wireBytes: 60, decodedBytes: 120 };
it("accepts only safe optional diagnostic features and legacy absent fields", async () => {
  const { assertDiagnosticFeatures } = await checker();
  expect(assertDiagnosticFeatures({})).toEqual([]);
  expect(assertDiagnosticFeatures({ routeMode: "direct", requestProfile: "atlas", response })).toEqual(["routeMode", "requestProfile", "response"]);
  expect(assertDiagnosticFeatures({ routeMode: "proxy", requestProfile: "cc-switch" })).toEqual(["routeMode", "requestProfile"]);
});
it("rejects free-form request features and nested identity/header/body fields", async () => {
  const { assertDiagnosticFeatures } = await checker();
  for (const input of [{ requestProfile: "private-secret" }, { routeMode: "private-proxy" }, { response: { ...response, headers: { Authorization: "PRIVATE" } } }, { response: { ...response, body: "PRIVATE" } }, { response: { ...response, url: "https://private.invalid" } }, { response: [] }, { response: null }])
    expect(() => assertDiagnosticFeatures(input)).toThrow();
});
it("rejects unbounded bytes, unsupported enums and missing response fields", async () => {
  const { assertDiagnosticFeatures } = await checker();
  for (const bad of [{ ...response, wireBytes: -1 }, { ...response, decodedBytes: Infinity }, { ...response, wireBytes: 1.5 }, { ...response, wireBytes: Number.MAX_SAFE_INTEGER + 1 }, { ...response, encoding: "PRIVATE" }, { ...response, mediaType: "https://private.invalid" }, { ...response, bodyKind: "upstream-body" }, { mediaType: "json" }])
    expect(() => assertDiagnosticFeatures({ response: bad })).toThrow();
});
it("uses the same explicit feature validator in both legacy browser scripts", () => {
  for (const file of ["scripts/verify-wizard.ts", "scripts/verify-diagnostics.ts"]) {
    const text = readFileSync(resolve(file), "utf8");
    expect(text.includes('from "./diagnostic-feature-contract"')).toBe(true);
    expect(text.includes("...assertDiagnosticFeatures(d)")).toBe(true);
    expect(text).toMatch(/serialized|report = JSON.stringify/);
    expect(text.includes('"headers":')).toBe(true);
    expect(text.includes('"body":')).toBe(true);
  }
});
it("keeps malformed JSON and HTML as separate failure fixtures", async () => {
  const m = await checker();
  expect(typeof m.diagnosticFailureBody).toBe("function");
  expect(m.diagnosticFailureCases).toEqual([
    { mode: "invalid-json", code: "invalid_json", httpStatus: 200 },
    { mode: "html", code: "response_html", httpStatus: 200 },
  ]);
  const broken = m.diagnosticFailureBody("invalid-json", "fixture-private-marker");
  expect(() => JSON.parse(broken)).toThrow();
  expect(broken.startsWith("{")).toBe(true);
  const html = m.diagnosticFailureBody("html", "fixture-private-marker");
  expect(html).toMatch(/^<html>/);
  expect(() => m.diagnosticFailureBody("unknown", "fixture-private-marker")).toThrow();
  const script = readFileSync(resolve("scripts/verify-diagnostics.ts"), "utf8");
  expect(script.includes("...diagnosticFailureCases.map")).toBe(true);
  expect(script.includes("diagnosticFailureBody(mode, secret)")).toBe(true);
});