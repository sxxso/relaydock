import { AlertCircle, Check, PenLine, RefreshCw } from "lucide-react";
import type { Account } from "@/lib/validation";
import { absoluteRecordTime, balanceFreshness } from "@/lib/balance-freshness";
import "./balance-freshness.css";

export function BalanceFreshness({
  account,
  now,
  section = "all",
  detailed = false,
}: {
  account: Account;
  now: number;
  section?: "record" | "query" | "all";
  detailed?: boolean;
}) {
  const f = balanceFreshness(account, now);
  return (
    <span
      className={"balance-freshness" + (detailed ? " is-detailed" : "")}
      data-testid="balance-freshness"
    >
      {section !== "query" && (
        <>
          <span className="freshness-source">
            {account.balanceSource === "manual" ? (
              <PenLine size={11} aria-hidden="true" />
            ) : account.balanceSource === "sync" ? (
              <RefreshCw size={11} aria-hidden="true" />
            ) : null}
            {f.sourceLabel}
          </span>
          {f.recordedAt ? (
            <time
              className="freshness-age"
              dateTime={f.recordedAt}
              title={f.absoluteTime!}
              aria-label={`${f.ageLabel}，记录于 ${f.absoluteTime}`}
            >
              {f.ageLabel}
              {detailed && (
                <span className="freshness-absolute">
                  记录于 {f.absoluteTime}
                </span>
              )}
            </time>
          ) : (
            <span className="freshness-age">{f.ageLabel}</span>
          )}
        </>
      )}
      {section !== "record" && (
        <span className="freshness-query">
          <span
            className={
              "freshness-query-result" + (f.queryFailed ? " has-error" : "")
            }
          >
            {f.queryFailed ? (
              <AlertCircle size={11} aria-hidden="true" />
            ) : account.lastSyncStatus === "success" ? (
              <Check size={11} aria-hidden="true" />
            ) : null}
            {f.queryLabel}
          </span>
          {detailed && f.queryAt && (
            <time
              className="freshness-query-time"
              dateTime={f.queryAt}
              title={absoluteRecordTime(f.queryAt)!}
              aria-label={`余额查询时间 ${absoluteRecordTime(f.queryAt)}`}
            >
              {absoluteRecordTime(f.queryAt)}
            </time>
          )}
          {f.testLabel && (
            <span
              className={"freshness-test" + (f.testFailed ? " has-error" : "")}
              title={
                f.testAt ? "测试于 " + absoluteRecordTime(f.testAt) : undefined
              }
            >
              {f.testLabel}
              {detailed && f.testAt && (
                <time
                  dateTime={f.testAt}
                  className="freshness-query-time"
                  aria-label={`连接测试时间 ${absoluteRecordTime(f.testAt)}`}
                >
                  {absoluteRecordTime(f.testAt)}
                </time>
              )}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
