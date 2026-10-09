import { expect, it, vi } from "vitest";
import { accountDetails, type Account } from "../src/lib/validation";
import {
  balanceFreshness,
  watchRecordClock,
  compareRecordedAt,
} from "../src/lib/balance-freshness";
import { QueryTrace, QueryFailure } from "../src/lib/query-trace";
const at = "2026-10-03T04:00:00.000Z",
  now = Date.parse(at);
const base: Account = {
  ...accountDetails.parse({ name: "夹具", siteUrl: "https://fixture.example" }),
  id: "a",
  createdAt: at,
  updatedAt: at,
  balance: "0",
  balanceUnit: "USD",
  lastSnapshotAt: at,
  balanceSource: "manual",
  rawQuota: null,
  lastSyncAt: null,
  lastSyncStatus: "never",
  lastSyncError: null,
  hasCredential: false,
};
const describe = (patch: Partial<Account> = {}, time = now) =>
  balanceFreshness({ ...base, ...patch }, time);
const diagnostic = (
  operation: "test" | "sync",
  code: "ok" | "response_timeout" | "http_auth" | "invalid_balance" = "ok",
) => {
  const d = new QueryTrace({
    provider: "newapi",
    operation,
    timeoutSeconds: 10,
    dnsMode: "system",
  }).finish(code === "ok" ? undefined : new QueryFailure(code, "secret text"));
  return { ...d, startedAt: at, finishedAt: at };
};
it("labels recorded zero and its real source, never inferring from platform", () => {
  expect(describe({ provider: "newapi" })).toMatchObject({
    hasBalance: true,
    sourceLabel: "手动记录",
    ageLabel: "刚刚记录",
    queryLabel: "尚未查询余额",
  });
  expect(
    describe({ provider: "manual", balanceSource: "sync" }).sourceLabel,
  ).toBe("接口查询");
  expect(describe({ balanceSource: undefined }).sourceLabel).toBe("来源未知");
});
it("sorts recent records by actual instants across ISO spellings and unknown dates", () => {
  const times = [
    { lastSnapshotAt: null },
    { lastSnapshotAt: "2026-10-03T00:00:00Z" },
    { lastSnapshotAt: "2026-10-03T00:00:00.500Z" },
    { lastSnapshotAt: "invalid" },
  ];
  expect(
    [...times].sort(compareRecordedAt).map((a) => a.lastSnapshotAt),
  ).toEqual([
    times[2].lastSnapshotAt,
    times[1].lastSnapshotAt,
    null,
    "invalid",
  ]);
});
it("unknown values have neither a fake source nor a fake recording time", () => {
  expect(describe({ balance: null })).toMatchObject({
    hasBalance: false,
    sourceLabel: "尚无余额记录",
    recordedAt: null,
    absoluteTime: null,
    ageLabel: "尚未记录",
    amountLabel: "余额未知",
  });
});
it.each([
  [0, "刚刚记录"],
  [59999, "刚刚记录"],
  [60000, "1 分钟前记录"],
  [3599999, "59 分钟前记录"],
  [3600000, "1 小时前记录"],
  [86400000, "1 天前记录"],
  [259200000, "3 天前记录"],
])("formats actual record age at %s ms", (delta, label) => {
  expect(describe({}, now + delta).ageLabel).toBe(label);
  expect(describe({}, now + delta).recordedAt).toBe(at);
  expect(describe({}, now + delta).absoluteTime).toContain("2026");
});
it("does not make invalid or future dates look fresh", () => {
  expect(describe({ lastSnapshotAt: "invalid" }).ageLabel).toBe("记录时间未知");
  expect(describe({ lastSnapshotAt: "invalid" }).recordedAt).toBeNull();
  expect(describe({}, now - 60000).ageLabel).toBe("记录时间晚于当前设备");
  expect(describe({}, Number.NaN).ageLabel).toBe("记录时间未知");
});
it.each([
  ["response_timeout", "最近查询超时"],
  ["http_auth", "最近查询被拒绝（401/403）"],
  ["invalid_balance", "最近查询接口不兼容"],
] as const)(
  "uses sanitized sync diagnosis %s, not arbitrary error strings",
  (code, label) => {
    const f = describe(
      {
        lastSyncStatus: "error",
        lastSyncAt: at,
        lastSyncError: "PRIVATE-ERROR",
        lastSyncDiagnostic: diagnostic("sync", code),
        lastQueryDiagnostic: diagnostic("test"),
      },
      now + 259200000,
    );
    expect(f).toMatchObject({
      sourceLabel: "手动记录",
      amountLabel: "上次余额",
      ageLabel: "3 天前记录",
      queryLabel: label,
      testLabel: "连接测试成功（未更新余额）",
    });
    expect(f.accessibleLabel).not.toContain("PRIVATE-ERROR");
    expect(f.accessibleLabel).toContain(label);
  },
);
it("a failed connection test is not a failed balance refresh", () => {
  expect(
    describe({ lastQueryDiagnostic: diagnostic("test", "response_timeout") }),
  ).toMatchObject({
    queryFailed: false,
    queryLabel: "尚未查询余额",
    testFailed: true,
    testLabel: "连接测试超时（未更新余额）",
    amountLabel: "已记录余额",
  });
});
it("ignores inconsistent, stale or test-only sync diagnostics", () => {
  expect(
    describe({
      lastSyncStatus: "error",
      lastSyncDiagnostic: diagnostic("test", "http_auth"),
    }).queryLabel,
  ).toBe("最近查询失败");
  expect(
    describe({
      lastSyncStatus: "success",
      lastSyncAt: at,
      lastSyncDiagnostic: diagnostic("sync", "http_auth"),
    }).queryLabel,
  ).toBe("最近查询成功");
  expect(
    describe({
      lastSyncStatus: "error",
      lastSyncAt: "2026-10-03T05:00:00.000Z",
      lastSyncDiagnostic: diagnostic("sync", "http_auth"),
    }).queryLabel,
  ).toBe("最近查询失败");
});
it.each([-4000, 4000])(
  "does not associate a different legacy attempt within five seconds (%s)",
  (delta) => {
    const d = {
      ...diagnostic("sync", "response_timeout"),
      finishedAt: new Date(now + delta).toISOString(),
    };
    expect(
      describe({
        lastSyncStatus: "error",
        lastSyncAt: at,
        lastQueryDiagnostic: d,
      }).queryLabel,
    ).toBe("最近查询失败");
    expect(
      describe({
        lastSyncStatus: "error",
        lastSyncAt: at,
        lastSyncDiagnostic: d,
      }).queryLabel,
    ).toBe("最近查询失败");
  },
);
it("older connection tests are not presented as newer than a balance query", () => {
  expect(
    describe({
      lastSyncAt: "2026-10-03T05:00:00.000Z",
      lastSyncStatus: "success",
      lastQueryDiagnostic: diagnostic("test", "http_auth"),
    }).testLabel,
  ).toBeNull();
});
it("surfaces failures even with unknown balance, and keeps custom/token units separate", () => {
  expect(describe({ balance: null, lastSyncStatus: "error" })).toMatchObject({
    amountLabel: "余额未知",
    queryFailed: true,
    queryLabel: "最近查询失败",
  });
  expect(
    describe({ balanceSource: "sync", balanceUnit: "原始配额" }).sourceLabel,
  ).toBe("接口查询");
});
it("does not claim a restored interface snapshot was never queried", () => {
  expect(
    describe({ balanceSource: "sync", lastSyncStatus: "never" }).queryLabel,
  ).toBe("尚无查询结果");
});
function clockFixture(visible = true) {
  let time = now + 59000,
    listener: (() => void) | undefined;
  const jobs = new Map<number, { callback: () => void; delay: number }>();
  let next = 0;
  const notify = vi.fn();
  const stop = watchRecordClock(notify, {
    now: () => time,
    visible: () => visible,
    schedule: (callback, delay) => {
      const id = ++next;
      jobs.set(id, { callback, delay });
      return () => {
        jobs.delete(id);
      };
    },
    subscribe: (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  });
  return {
    notify,
    jobs,
    stop,
    setVisible(v: boolean) {
      visible = v;
      listener?.();
    },
    advance(ms: number) {
      time += ms;
    },
    fire() {
      const [id, job] = [...jobs.entries()][0];
      jobs.delete(id);
      job.callback();
      return job.callback;
    },
    listener: () => listener,
  };
}
it("runs a single aligned local clock; visibility pauses and resumes without catch-up loops", () => {
  const c = clockFixture();
  expect(c.notify).toHaveBeenCalledTimes(1);
  expect([...c.jobs.values()][0].delay).toBe(1000);
  c.advance(1000);
  c.fire();
  expect(c.jobs.size).toBe(1);
  expect([...c.jobs.values()][0].delay).toBe(60000);
  c.setVisible(false);
  expect(c.jobs.size).toBe(0);
  c.advance(259200000);
  c.setVisible(true);
  expect(c.notify).toHaveBeenLastCalledWith(now + 259260000);
  expect(c.jobs.size).toBe(1);
  c.stop();
  expect(c.jobs.size).toBe(0);
  expect(c.listener()).toBeUndefined();
});
it("does not start hidden or resurrect after cleanup", () => {
  const c = clockFixture(false);
  expect(c.notify).not.toHaveBeenCalled();
  expect(c.jobs.size).toBe(0);
  c.setVisible(true);
  const callback = [...c.jobs.values()][0].callback;
  c.stop();
  c.stop();
  callback();
  expect(c.jobs.size).toBe(0);
  expect(c.notify).toHaveBeenCalledTimes(1);
});
