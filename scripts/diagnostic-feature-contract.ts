import assert from "node:assert/strict";

// Independent test contract: do not normalize/strip unknown properties here.
// A new production field is not automatically allowed by this browser validator.
export function assertDiagnosticFeatures(d: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const [key, allowed] of [
    ["routeMode", ["direct", "proxy"]],
    ["requestProfile", ["atlas", "cc-switch"]],
  ] as const) {
    if (!Object.hasOwn(d, key)) continue;
    assert.ok(typeof d[key] === "string" && allowed.some((v) => v === d[key]), "Unrecognized diagnostic feature enum");
    keys.push(key);
  }
  if (!Object.hasOwn(d, "response")) return keys;
  assert.ok(d.response && typeof d.response === "object" && !Array.isArray(d.response), "Response features must be an object");
  const r = d.response as Record<string, unknown>;
  assert.deepEqual(Object.keys(r).sort(), ["mediaType", "encoding", "bodyKind", "wireBytes", "decodedBytes"].sort(), "Response feature whitelist excludes identities, headers and body");
  for (const [key, allowed] of [
    ["mediaType", ["json", "html", "text", "other", "missing"]],
    ["encoding", ["identity", "gzip", "deflate", "br", "unsupported"]],
    ["bodyKind", ["unknown", "json", "html", "challenge", "empty", "non-json"]],
  ] as const)
    assert.ok(typeof r[key] === "string" && allowed.some((v) => v === r[key]), "Unrecognized response feature enum");
  for (const key of ["wireBytes", "decodedBytes"])
    assert.ok(typeof r[key] === "number" && Number.isSafeInteger(r[key]) && r[key] >= 0, "Byte count must be a non-negative safe integer");
  keys.push("response");
  return keys;
}

// Independent synthetic failure oracle: malformed JSON is not an HTML page.
export const diagnosticFailureCases = [
  { mode: "invalid-json", code: "invalid_json", httpStatus: 200 },
  { mode: "html", code: "response_html", httpStatus: 200 },
] as const;
export function diagnosticFailureBody(mode: string, fixtureMarker: string): string {
  if (mode === "invalid-json") return '{"fixture":' + JSON.stringify(fixtureMarker); // Deliberately missing closing brace.
  if (mode === "html") return "<html><body>" + fixtureMarker + "</body></html>";
  throw new Error("Unknown diagnostic failure fixture");
}
