import { expect, it } from "vitest";

// Dynamic loading lets the RED run assert the missing feature, rather than
// terminating the suite with a module-resolution exception.
const feature = async () => {
  const module = await import("../src/lib/model-insight").catch(() => null);
  expect(module, "model insight parser has not been implemented").not.toBeNull();
  return module!;
};
const now = "2026-10-08T08:00:00.000Z";
it("joins catalog and perf without inventing missing metrics or legacy timestamps", async () => {
  const m = await feature();
  const catalog = m.parseCatalog({ success: true, data: [
    { model_name: "gpt-a", owner_by: "OpenAI", enable_groups: ["default", "vip"] },
    { model_name: "unknown", owner_by: "Other", enable_groups: [] },
    { model_name: "gpt-a", token: "private-secret" },
  ] });
  const perf = m.parsePerfSummary({ success: true, data: { models: [
    { model_name: "gpt-a", success_rate: "98.5", avg_latency_ms: "1100", avg_tps: null, recent_success_rates: [90, "100", null] },
    { model_name: "hidden", success_rate: "NaN", avg_tps: Infinity, avg_ttft_ms: -1 },
  ] } });
  const rows = m.mergeModelRows(catalog.rows, perf.rows);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ model: "gpt-a", inCatalog: true, vendor: "OpenAI", successRate: 98.5, avgLatencyMs: 1100, avgTps: null, sampleCount: null });
  expect(rows[0].trend).toEqual([
    { at: null, successRate: 90, avgLatencyMs: null, avgTps: null, avgTtftMs: null },
    { at: null, successRate: 100, avgLatencyMs: null, avgTps: null, avgTtftMs: null },
    { at: null, successRate: null, avgLatencyMs: null, avgTps: null, avgTtftMs: null },
  ]);
  expect(rows[1].successRate).toBeNull();
  expect(rows[2]).toMatchObject({ inCatalog: false, successRate: null, avgTps: null, avgTtftMs: null });
  expect(JSON.stringify(rows)).not.toContain("private-secret");
});
it("parses current series and bounded detail without returning upstream fields", async () => {
  const m = await feature();
  const result = m.parsePerfDetail({ success: true, data: { model_name: "gpt-a", groups: [{
    group: "vip", success_rate: 99, avg_ttft_ms: "240", sample_count: "3", token: "private-secret",
    series: [{ ts: 1791442800, success_rate: 75, avg_tps: 20, request: "private-prompt" }],
  }] } }, "gpt-a");
  expect(result.groups[0]).toMatchObject({ group: "vip", successRate: 99, avgTtftMs: 240, sampleCount: 3 });
  expect(result.groups[0].series[0].at).toBe(new Date(1791442800 * 1000).toISOString());
  expect(JSON.stringify(result)).not.toMatch(/private-secret|private-prompt|request/);
  const huge = m.parseCatalog({ data: Array.from({ length: 501 }, (_, i) => ({ model_name: `m-${i}`, enable_groups: Array.from({ length: 40 }, (_, j) => `group-${j}`) })) });
  expect(huge.rows).toHaveLength(500);
  expect(huge.rows[0].groups).toHaveLength(32);
  expect(huge.truncated).toBe(true);
});
it("aggregates only typed in-window consumption/error logs and estimates output speed", async () => {
  const m = await feature();
  const ts = Date.parse(now) / 1000;
  const result = m.aggregateLogs([
    { model_name: "gpt-a", type: 2, created_at: ts - 100, use_time: "2", completion_tokens: "80", other: '{"frt":250,"prompt":"private-prompt"}', token_name: "private-key" },
    { model_name: "gpt-a", type: 5, created_at: ts - 90, use_time: null, completion_tokens: 9 },
    { model_name: "gpt-a", type: 1, created_at: ts - 90, use_time: 1 },
    { model_name: "gpt-a", type: 2, created_at: ts - 25 * 3600, use_time: 1 },
    { model_name: "outside", type: 2, created_at: ts + 20, use_time: 1 },
    { model_name: "bad-time", type: 2, created_at: "NaN", use_time: 1 },
  ], ts - 24 * 3600, ts);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ sampleCount: 2, successRate: 50, avgLatencyMs: 2000, avgTtftMs: 250, avgTps: 40 });
  expect(result.rows[0].trend).toHaveLength(1);
  expect(JSON.stringify(result)).not.toMatch(/private-prompt|private-key|token_name|completion_tokens/);
});
it("validates cached identity and strict aggregate shape, and filters locally", async () => {
  const m = await feature();
  const rows = m.parseCatalog({ data: [{ model_name: "gpt-a" }] }).rows;
  const valid = { version: 1, accountId: "account-a", readAt: now, hours: 24, source: "catalog", windowStart: null, windowEnd: null, rows, truncated: false, catalogAvailable: true, warnings: [] };
  expect(m.normalizeModelInsight(valid, "account-a")).toEqual(valid);
  expect(m.normalizeModelInsight(valid, "other")).toBeNull();
  expect(m.normalizeModelInsight({ ...valid, token: "private-secret" }, "account-a")).toBeNull();
  expect(m.normalizeModelInsight({ ...valid, warnings: ["private-secret"] }, "account-a")).toBeNull();
  expect(m.normalizeModelInsight({ ...valid, rows: [{ ...rows[0], vendor: "bad\nlabel" }] }, "account-a")).toBeNull();
  expect(m.normalizeModelInsight({ ...valid, windowStart: now, windowEnd: "2026-10-07T08:00:00.000Z" }, "account-a")).toBeNull();
  expect(m.filterModelRows(rows, { search: "GPT", trafficOnly: false, sort: "model" })).toHaveLength(1);
  expect(m.filterModelRows(rows, { search: "", trafficOnly: true, sort: "successRate" })).toHaveLength(0);
});
it("signals truncation when log groups exceed the bound", async () => {
  const m = await feature(); const ts = Date.parse(now) / 1000;
  const result = m.aggregateLogs(Array.from({ length: 40 }, (_, i) => ({ model_name: "gpt-a", type: 2, created_at: ts - 1, group: "g-" + i })), ts - 3600, ts);
  expect(result.rows[0].groups).toHaveLength(32); expect(result.truncated).toBe(true);
});
