import {
  codeCategories,
  stageIds,
  type QueryCode,
  type QueryConfig,
  type QueryDiagnostic,
  type QueryStageId,
  responseInfoSchema,
  type QueryResponseInfo,
} from "./query-diagnostics";

export class QueryFailure extends Error {
  constructor(
    public code: QueryCode,
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = "QueryFailure";
  }
}
export class QueryTrace {
  private startedAt = new Date().toISOString();
  private start: number;
  private active: { id: QueryStageId; start: number } | null = null;
  private stages: QueryDiagnostic["stages"] = stageIds.map((id) => ({
    id,
    status: "not-run",
    durationMs: null,
  }));
  private httpStatus: number | null = null;
  private completed: QueryDiagnostic | null = null;
  private responseInfo: QueryResponseInfo | null = null;
  constructor(
    private config: QueryConfig,
    private clock: () => number = () => performance.now(),
  ) {
    this.start = clock();
  }
  begin(id: QueryStageId) {
    if (this.completed) return;
    this.end();
    this.active = { id, start: this.clock() };
  }
  end(status: "success" | "error" = "success") {
    if (this.completed || !this.active) return;
    const s = this.stages.find((s) => s.id === this.active!.id)!;
    s.status = status;
    s.durationMs = this.elapsed(this.active.start);
    this.active = null;
  }
  skip(id: QueryStageId) {
    if (this.completed) return;
    this.end();
    const s = this.stages.find((s) => s.id === id)!;
    s.status = "skipped";
    s.durationMs = 0;
  }
  status(value: number | undefined) {
    if (!this.completed && value && value >= 100 && value <= 599)
      this.httpStatus = value;
  }
  response(info: Partial<QueryResponseInfo>) {
    if (this.completed) return;
    const result = responseInfoSchema.safeParse({
      mediaType: "missing",
      encoding: "identity",
      bodyKind: "unknown",
      wireBytes: 0,
      decodedBytes: 0,
      ...this.responseInfo,
      ...info,
    });
    if (result.success) this.responseInfo = result.data;
  }
  private elapsed(start: number) {
    return Math.round(Math.max(0, this.clock() - start) * 10) / 10;
  }
  finish(error?: QueryFailure): QueryDiagnostic {
    if (this.completed) return this.completed;
    this.end(error ? "error" : "success");
    const code = error?.code || "ok";
    this.completed = {
      schemaVersion: 1,
      ...this.config,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      totalMs: this.elapsed(this.start),
      outcome: error ? "failure" : "success",
      category: codeCategories[code],
      code,
      httpStatus: error?.httpStatus ?? this.httpStatus,
      stages: this.stages.map((s) => ({ ...s })),
      ...(this.responseInfo ? { response: { ...this.responseInfo } } : {}),
    };
    return this.completed;
  }
}
