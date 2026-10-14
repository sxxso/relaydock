export type BalanceBatchRow = {
  id: string;
  name: string;
  state: "queued" | "running" | "success" | "failed" | "cancelled";
  message: string;
};
export type BatchControl = { cancelled: boolean };

/** Cancellation never aborts in-flight requests or automatically retries failures. */
export async function runBalanceBatch(
  input: readonly Pick<BalanceBatchRow, "id" | "name">[],
  control: BatchControl,
  query: (id: string) => Promise<void>,
  publish: (rows: BalanceBatchRow[]) => void,
) {
  const rows: BalanceBatchRow[] = input.map(a => ({ ...a, state: "queued", message: "等待查询" }));
  let cursor = 0;
  const emit = () => publish(rows.map(row => ({ ...row })));
  emit();
  await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
    while (!control.cancelled && cursor < rows.length) {
      const row = rows[cursor++];
      row.state = "running"; row.message = "查询中"; emit();
      try { await query(row.id); row.state = "success"; row.message = "余额已记录"; }
      catch (e) { row.state = "failed"; row.message = e instanceof Error ? e.message : "查询失败"; }
      emit();
    }
  }));
  for (const row of rows) if (row.state === "queued") { row.state = "cancelled"; row.message = "未发出请求"; }
  emit();
  return rows;
}
