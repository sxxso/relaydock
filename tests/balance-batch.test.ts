import { expect, it } from "vitest";
import { runBalanceBatch, type BalanceBatchRow } from "../src/lib/balance-batch";

it("limits concurrency to three and cancellation leaves queued requests unsent", async () => {
  const control = { cancelled: false }, calls: string[] = [], release: (() => void)[] = [];
  let latest: BalanceBatchRow[] = [];
  const result = runBalanceBatch(Array.from({ length: 7 }, (_, i) => ({ id: String(i), name: String(i) })), control,
    async id => { calls.push(id); await new Promise<void>(r => release.push(r)); }, rows => latest = rows);
  expect(calls).toEqual(["0", "1", "2"]);
  expect(latest.filter(r => r.state === "running")).toHaveLength(3);
  control.cancelled = true;
  release.forEach(r => r());
  const rows = await result;
  expect(calls).toHaveLength(3);
  expect(rows.filter(r => r.state === "success")).toHaveLength(3);
  expect(rows.filter(r => r.state === "cancelled")).toHaveLength(4);
});

it("keeps error reasons and explicitly retrying failed rows does not query successful rows", async () => {
  const calls: string[] = [];
  const rows = await runBalanceBatch([{ id: "ok", name: "A" }, { id: "fail", name: "B" }], { cancelled: false }, async id => {
    calls.push(id); if (id === "fail") throw new Error("接口超时");
  }, () => {});
  expect(rows[1]).toMatchObject({ state: "failed", message: "接口超时" });
  await runBalanceBatch(rows.filter(r => r.state === "failed"), { cancelled: false }, async id => { calls.push(id); }, () => {});
  expect(calls).toEqual(["ok", "fail", "fail"]);
});

it("never sends a request if the run was invalidated before starting", async () => {
  let calls = 0;
  const rows = await runBalanceBatch([{ id: "a", name: "A" }], { cancelled: true }, async () => { calls++; }, () => {});
  expect(calls).toBe(0); expect(rows[0].state).toBe("cancelled");
});
