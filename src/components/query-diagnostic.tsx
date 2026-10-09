"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Check, ChevronDown, Copy, Minus, X } from "lucide-react";
import {
  diagnosticExplanation,
  diagnosticReport,
  normalizeDiagnostic,
  stageLabels,
  type QueryDiagnostic,
} from "@/lib/query-diagnostics";
import { platformOf } from "@/lib/platform-catalog";
import { localDate } from "./pages";
import "./query-diagnostic.css";

export function QueryDiagnosticPanel({
  diagnostic,
  busy,
}: {
  diagnostic?: QueryDiagnostic | null;
  busy: boolean;
}) {
  const d = useMemo(() => normalizeDiagnostic(diagnostic), [diagnostic]);
  const [open, setOpen] = useState(d?.outcome === "failure"),
    [copied, setCopied] = useState(false),
    [manual, setManual] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setOpen(d?.outcome === "failure");
    setCopied(false);
    setManual("");
    if (timer.current) clearTimeout(timer.current);
  }, [d?.finishedAt, d?.outcome]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const explanation = d ? diagnosticExplanation(d) : null;
  async function copy() {
    if (!d || busy) return;
    const report = diagnosticReport(d);
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setManual("");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setManual(report);
    }
  }
  return (
    <section
      className="query-diagnostic"
      role="region"
      aria-label="查询诊断"
      aria-busy={busy}
    >
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <Activity size={15} strokeWidth={1.5} aria-hidden="true" />
          <strong>查询诊断</strong>
          <span
            className={
              "diagnostic-outcome " +
              (busy ? "measuring" : d?.outcome || "empty")
            }
          >
            {busy
              ? "正在测量"
              : d
                ? d.outcome === "success"
                  ? "成功"
                  : "未完成"
                : "尚无结果"}
          </span>
          <ChevronDown
            size={14}
            className="diagnostic-chevron"
            aria-hidden="true"
          />
        </summary>
        <div className="diagnostic-content">
          {busy ? (
            <p role="status" className="diagnostic-empty">
              请求进行中。完成后展示实际阶段耗时，不会估算进度。
            </p>
          ) : !d ? (
            <p className="diagnostic-empty">
              点击「测试连接」或「刷新余额」后，这里显示真实查询过程。不会自动查询。
            </p>
          ) : (
            <>
              <div className="diagnostic-context">
                <span>
                  {d.operation === "test" ? "连接测试" : "余额查询"} ·{" "}
                  {platformOf(d.provider).label}
                </span>
                <time dateTime={d.finishedAt}>{localDate(d.finishedAt)}</time>
              </div>
              <div className={"diagnostic-verdict " + d.outcome}>
                <strong>{explanation!.title}</strong>
                <span>
                  {d.httpStatus ? `HTTP ${d.httpStatus}` : "未收到 HTTP 响应"}
                </span>
              </div>
              <ol className="diagnostic-stages" aria-label="查询阶段耗时">
                {d.stages.map((s) => (
                  <li key={s.id} data-status={s.status}>
                    <span className="diagnostic-stage-mark" aria-hidden="true">
                      {s.status === "success" ? (
                        <Check size={11} />
                      ) : s.status === "error" ? (
                        <X size={11} />
                      ) : (
                        <Minus size={10} />
                      )}
                    </span>
                    <span>{stageLabels[s.id]}</span>
                    <span className="diagnostic-duration">
                      {s.status === "not-run" ? (
                        "未执行"
                      ) : s.status === "skipped" ? (
                        "无需解析"
                      ) : (
                        <>
                          <b>{s.durationMs}</b> ms
                          {s.status === "error" && <em>失败</em>}
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
              <div className="diagnostic-total">
                <span>
                  总耗时 <b>{d.totalMs} ms</b>
                </span>
                <span>上限 {d.timeoutSeconds} 秒</span>
              </div>
              {d.response && (
                <dl className="diagnostic-response" aria-label="脱敏响应特征">
                  <div>
                    <dt>内容类型</dt>
                    <dd>
                      {
                        {
                          json: "JSON 类型",
                          html: "HTML 类型",
                          text: "文本类型",
                          other: "其他类型",
                          missing: "未声明",
                        }[d.response.mediaType]
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>压缩编码</dt>
                    <dd>
                      {d.response.encoding === "identity"
                        ? "无压缩"
                        : d.response.encoding === "unsupported"
                          ? "不支持"
                          : d.response.encoding}
                    </dd>
                  </div>
                  <div>
                    <dt>正文分类</dt>
                    <dd>
                      {
                        {
                          unknown: "未完成",
                          json: "合法 JSON",
                          html: "网页",
                          challenge: "疑似防护页",
                          empty: "空正文",
                          "non-json": "非 JSON",
                        }[d.response.bodyKind]
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>字节数</dt>
                    <dd>
                      {d.response.wireBytes} → {d.response.decodedBytes}
                    </dd>
                  </div>
                </dl>
              )}
              <p className="diagnostic-next">{explanation!.hint}</p>
              <div className="diagnostic-footnote">
                <span>
                  {d.dnsMode === "cloudflare" ? "Cloudflare DoH" : "系统 DNS"} ·
                  {d.routeMode === "proxy"
                    ? "代理线路"
                    : d.routeMode === "direct"
                      ? "直连线路"
                      : "线路未记录"}
                  {d.requestProfile &&
                    ` · ${d.requestProfile === "cc-switch" ? "CC Switch 模板请求头" : "Atlas 请求头"}`}
                </span>
                <code>{d.code}</code>
              </div>
              <p className="diagnostic-legend">
                连接包含 TLS；等待计至响应头，不代表站点内部处理时间。
              </p>
              <button
                type="button"
                className="button diagnostic-copy"
                onClick={copy}
                aria-label="复制脱敏报告"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
                {copied ? "已复制脱敏报告" : "复制脱敏报告"}
              </button>
              <p className="diagnostic-privacy">
                仅复制诊断白名单，不含密钥、账号、域名、IP
                和响应正文，不会上传。
              </p>
              {manual && (
                <label className="diagnostic-manual">
                  自动复制不可用，请选中文本手动复制
                  <textarea
                    aria-label="脱敏诊断报告"
                    readOnly
                    value={manual}
                    rows={8}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </label>
              )}
              <span role="status" className="sr-only">
                {copied ? "脱敏诊断报告已复制" : ""}
              </span>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
