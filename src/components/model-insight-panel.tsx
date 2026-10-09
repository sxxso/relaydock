"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, ChevronDown, RefreshCw, Search } from "lucide-react";
import type { Account } from "@/lib/validation";
import type { QueryRouteMode } from "@/lib/query-routing";
import {
  filterModelRows, modelDetailSchema, normalizeModelInsight,
  type ModelDetail, type ModelHours, type ModelInsight, type ModelPoint, type ModelRow,
} from "@/lib/model-insight";
import type { Send } from "./account-form";
import { AtlasSelect } from "./atlas-select";
import { Modal } from "./modal";
import "./model-insight-panel.css";

type Sort = Parameters<typeof filterModelRows>[1]["sort"];
const sourceLabel = (source: ModelInsight["source"]) => source === "perf" ? "站点公开流量统计" : source === "log" ? "我的调用记录" : "模型目录（无表现数据）";
const number = (value: number | null, digits = 1) => value === null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const percent = (value: number | null) => value === null ? "—" : number(value) + "%";
const milliseconds = (value: number | null) => value === null ? "—" : number(value, 0) + " ms";
const time = (value: string | null) => value === null ? "未知" : new Date(value).toLocaleString("zh-CN", { hour12: false });
const failure = (value: unknown) => value instanceof Error ? value.message : "读取失败，请稍后重试。";

function Trend({ points }: { points: ModelPoint[] }) {
  const unknownTime = points.some((point) => point.at === null);
  const timed = points.filter((point) => point.at !== null).sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
  const start = timed.length ? Date.parse(timed[0].at!) : 0;
  const end = timed.length ? Date.parse(timed[timed.length - 1].at!) : 0;
  const x = (at: string) => end === start ? 286 : 42 + (Date.parse(at) - start) / (end - start) * 488;
  const y = (rate: number) => 12 + (100 - rate) / 100 * 100;
  let previous = false;
  const path = timed.map((point) => {
    if (point.successRate === null) { previous = false; return ""; }
    const segment = `${previous ? "L" : "M"}${x(point.at!)} ${y(point.successRate)}`;
    previous = true;
    return segment;
  }).join(" ");
  const measurable = timed.filter((point) => point.successRate !== null);
  if (!points.length) return <p className="model-empty-trend">此窗口没有趋势采样。</p>;
  return <div className="model-trend">
    {measurable.length > 0 && <>
      <svg viewBox="0 0 560 132" role="img" aria-label="成功率趋势，纵轴从 0% 到 100%">
        {[0, 50, 100].map((rate) => <g key={rate}><line x1="42" x2="530" y1={y(rate)} y2={y(rate)} className="model-trend-grid" /><text x="4" y={y(rate) + 4}>{rate}%</text></g>)}
        {!unknownTime && <path d={path} className="model-trend-line" />}
        {measurable.map((point, index) => <circle key={index} cx={x(point.at!)} cy={y(point.successRate!)} r="3.5" className="model-trend-point"><title>{time(point.at)}，成功率 {percent(point.successRate)}</title></circle>)}
      </svg>
      <div className="model-trend-times"><span>{time(timed[0].at)}</span><span>{time(timed[timed.length - 1].at)}</span></div>
    </>}
    {unknownTime && <div className="model-legacy-trend">
      <p>部分采样没有时间戳，无法确定采样时间；不连接这些点。</p>
      <ol aria-label="无时间戳的成功率采样">{points.filter((point) => point.at === null).map((point, index) => <li key={index}>{percent(point.successRate)}</li>)}</ol>
    </div>}
    {!unknownTime && measurable.length === 0 && <p className="model-empty-trend">有时间记录，但没有可用的成功率采样。</p>}
    {measurable.length > 0 && <details className="model-trend-values"><summary>查看采样数值</summary><ul>{timed.map((point, index) => <li key={index}><time dateTime={point.at!}>{time(point.at)}</time><span>{percent(point.successRate)}</span></li>)}</ul></details>}
  </div>;
}

function Detail({ data, onClose }: { data: ModelDetail; onClose: () => void }) {
  return <section className="model-detail" data-testid="model-detail" aria-label={`${data.model} 分组与趋势`}>
    <header><h3>{data.model}</h3><button type="button" className="button text-button" onClick={onClose}>收起趋势</button></header>
    <p className="model-detail-meta">{sourceLabel(data.source)}；读取于 {time(data.readAt)}；{data.hours} 小时</p>
    <p className="model-detail-meta">统计范围：{time(data.windowStart)} 至 {time(data.windowEnd)}</p>
    {data.truncated && <p className="model-warning">分组或采样读取不完整；以下仅代表已读取的数据。</p>}
    {data.warnings.map((warning) => <p className="model-warning" key={warning}>{warning}</p>)}
    {data.groups.length === 0 ? <p className="model-empty-trend">此模型没有可用的分组表现。</p> : data.groups.map((group, index) => <div className="model-detail-group" key={`${group.group}-${index}`}>
      <h4>{group.group}</h4>
      <dl className="model-detail-metrics">
        <div><dt>成功率</dt><dd>{percent(group.successRate)}</dd></div>
        <div><dt>平均延迟</dt><dd>{milliseconds(group.avgLatencyMs)}</dd></div>
        <div><dt>首字延迟</dt><dd>{milliseconds(group.avgTtftMs)}</dd></div>
        <div><dt>{data.source === "log" ? "估算输出速度" : "输出速度"}</dt><dd>{number(group.avgTps)}{group.avgTps !== null && " Token/s"}</dd></div>
        <div><dt>样本量</dt><dd>{group.sampleCount === null ? "未知" : number(group.sampleCount, 0)}</dd></div>
      </dl>
      <Trend points={group.series} />
    </div>)}
  </section>;
}

export function ModelInsightPanel({ account, send, routeMode, routingBusy, onClose }: {
  account: Account; send: Send; routeMode: QueryRouteMode | null; routingBusy: boolean; onClose: () => void;
}) {
  const [insight, setInsight] = useState<ModelInsight | null>(null);
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [hours, setHours] = useState<ModelHours>(24);
  const [source, setSource] = useState<"auto" | "log">("auto");
  const [appliedSource, setAppliedSource] = useState<"auto" | "log">("auto");
  const [search, setSearch] = useState("");
  const [trafficOnly, setTrafficOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("model");
  const [pending, setPending] = useState<"cache" | "summary" | string | null>("cache");
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const generation = useRef(0);
  const alive = useRef(true);
  const selected = useRef({ hours, source });
  selected.current = { hours, source };

  useEffect(() => {
    alive.current = true;
    const ticket = ++generation.current;
    setPending("cache"); setInsight(null); setDetail(null); setError(""); setDetailError("");
    setHours(24); setSource("auto"); setAppliedSource("auto"); setSearch(""); setTrafficOnly(false); setSort("model");
    void send<{ insight: unknown }>(`accounts/${account.id}/models`).then(({ insight: cached }) => {
      if (!alive.current || generation.current !== ticket) return;
      const data = normalizeModelInsight(cached, account.id);
      setInsight(data);
      if (data) { setHours(data.hours); setSource(data.source === "log" ? "log" : "auto"); setAppliedSource(data.source === "log" ? "log" : "auto"); }
    }).catch((e: unknown) => {
      if (alive.current && generation.current === ticket) setError("本地缓存读取失败：" + failure(e));
    }).finally(() => {
      if (alive.current && generation.current === ticket) setPending(null);
    });
    return () => { alive.current = false; generation.current++; };
  }, [account.id, send]);

  const invalidateSelection = () => { generation.current++; setDetail(null); setDetailError(""); setError(""); setPending(null); };
  const close = () => { alive.current = false; generation.current++; onClose(); };
  const canRead = !account.archived && account.provider === "newapi" && !routingBusy && routeMode !== null;
  const busy = pending !== null;
  const changed = insight !== null && (insight.hours !== hours || appliedSource !== source);
  const rows = useMemo(() => filterModelRows(insight?.rows ?? [], { search, trafficOnly, sort }), [insight, search, trafficOnly, sort]);

  async function refresh() {
    if (!canRead || busy) return;
    const ticket = ++generation.current, choice = { hours, source }, capturedRoute = routeMode;
    setPending("summary"); setError(""); setDetailError(""); setDetail(null);
    try {
      const response = await send<unknown>(`accounts/${account.id}/models`, "POST", { ...choice, routeMode: capturedRoute });
      if (!alive.current || generation.current !== ticket || selected.current.hours !== choice.hours || selected.current.source !== choice.source) return;
      const data = normalizeModelInsight(response, account.id);
      if (!data || data.hours !== choice.hours) throw new Error("返回的模型数据不匹配，请重新更新。");
      if (data.source === "catalog" && insight && insight.source !== "catalog") {
        setError("本次只能读取模型目录，保留上次表现与读取时间。" + data.warnings.join(" "));
        return;
      }
      setInsight(data);
      setAppliedSource(choice.source);
    } catch (e) {
      if (alive.current && generation.current === ticket) setError("更新失败，保留上次结果。" + failure(e));
    } finally {
      if (alive.current && generation.current === ticket) setPending(null);
    }
  }

  async function showDetail(row: ModelRow) {
    if (!canRead || busy || changed || !insight || insight.source === "catalog") return;
    if (detail?.model === row.model) { generation.current++; setDetail(null); return; }
    const ticket = ++generation.current, query = { model: row.model, hours: insight.hours, source: insight.source, routeMode };
    setPending(`detail:${row.model}`); setDetailError(""); setDetail(null);
    try {
      const response = await send<unknown>(`accounts/${account.id}/models/detail`, "POST", query);
      if (!alive.current || generation.current !== ticket) return;
      const parsed = modelDetailSchema.safeParse(response);
      if (!parsed.success || parsed.data.accountId !== account.id || parsed.data.model !== row.model || parsed.data.hours !== query.hours || (query.source === "log" && parsed.data.source !== "log")) throw new Error("返回的趋势数据不匹配，请重新读取。");
      setDetail(parsed.data);
    } catch (e) {
      if (alive.current && generation.current === ticket) setDetailError("趋势读取失败：" + failure(e));
    } finally {
      if (alive.current && generation.current === ticket) setPending(null);
    }
  }

  return <Modal open onClose={close} wide title={`模型表现 · ${account.name}`} description="查看近期统计与模型目录。历史表现不能保证此刻调用成功，目录不代表账号拥有调用权限。">
    <div className="model-insight-panel" data-testid="model-insight-panel">
      <div className="model-query-controls">
        <div className="model-query-choice"><span>数据来源</span><AtlasSelect label="数据来源" value={source} disabled={busy} options={[{ value: "auto", label: "站点优先" }, { value: "log", label: "我的调用记录" }]} onValueChange={(v) => { invalidateSelection(); setSource(v as "auto" | "log"); }} /></div>
        <div className="model-query-choice"><span>统计窗口</span><AtlasSelect label="统计窗口" value={String(hours)} disabled={busy} options={[24, 72, 168].map((n) => ({ value: String(n), label: `${n} 小时` }))} onValueChange={(v) => { invalidateSelection(); setHours(Number(v) as ModelHours); }} /></div>
        <button type="button" className="button primary model-refresh" data-testid="model-refresh" onClick={() => void refresh()} disabled={!canRead || busy}><RefreshCw size={15} className={pending === "summary" ? "spin" : ""} />{pending === "summary" ? "更新中…" : "更新模型表现"}</button>
      </div>
      <p className="model-query-help">{account.archived ? "此账号已归档，可查看本地记录。取消归档后才能更新。" : routingBusy || !routeMode ? "查询线路准备中，稍后可更新。" : `点击更新才会读取站点，使用${routeMode === "proxy" ? "代理" : "直连"}线路。搜索、筛选和排序只处理当前结果。`}</p>
      {error && <div role="alert" className="model-error"><AlertCircle size={16} /><p>{error}</p></div>}
      {pending === "cache" ? <p className="model-empty" role="status">正在读取本地缓存…</p> : !insight ? <div className="model-empty"><Activity size={25} /><h3>还没有模型表现记录</h3><p>点击“更新模型表现”读取目录和近期统计。</p></div> : <>
        <section className="model-result-summary" aria-label="当前结果来源与时间">
          <div className="model-source-line"><strong>{sourceLabel(insight.source)}</strong><span>{insight.rows.length} 个模型</span></div>
          <dl><div><dt>读取时间</dt><dd><time dateTime={insight.readAt}>{time(insight.readAt)}</time></dd></div><div><dt>当前结果窗口</dt><dd>{insight.hours} 小时</dd></div><div className="model-window"><dt>统计范围</dt><dd>{time(insight.windowStart)} 至 {time(insight.windowEnd)}</dd></div></dl>
          {changed && <p className="model-pending-choice" role="status">查询设置已改变，尚未更新。以下仍为上次 {insight.hours} 小时的{sourceLabel(insight.source)}。</p>}
          {insight.truncated && <p className="model-warning">读取不完整或达到采样上限；这些指标仅代表已读取的数据。</p>}
          {insight.warnings.length > 0 && <ul className="model-warnings">{insight.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        </section>
        <div className="model-local-controls">
          <label className="model-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索模型" placeholder="搜索模型或厂商" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          <label className="model-traffic"><input type="checkbox" checked={trafficOnly} onChange={(e) => setTrafficOnly(e.target.checked)} />仅显示有流量</label>
          <AtlasSelect label="模型排序" value={sort} options={[{ value: "model", label: "模型名称" }, { value: "successRate", label: "成功率优先" }, { value: "avgLatencyMs", label: "延迟较低优先" }, { value: "avgTtftMs", label: "首字较快优先" }, { value: "avgTps", label: "输出较快优先" }, { value: "sampleCount", label: "样本较多优先" }]} onValueChange={(v) => setSort(v as Sort)} />
        </div>
        <div className="model-table-wrap"><table className="model-table"><caption className="sr-only">模型表现；缺失指标以横线表示，样本未知以横线表示。</caption><thead><tr><th scope="col">模型</th><th scope="col">成功率</th><th scope="col">平均延迟</th><th scope="col">首字延迟</th><th scope="col">{insight.source === "log" ? "估算速度" : "输出速度"}<small>Token/s</small></th><th scope="col">样本量</th><th scope="col"><span className="sr-only">趋势操作</span></th></tr></thead><tbody>
          {rows.map((row) => <tr data-testid="model-row" key={row.model}>
            <th scope="row"><span className="model-name">{row.model}</span><small>{row.vendor || (row.inCatalog ? "站点目录" : "流量记录")}{row.groups.length > 0 && ` · ${row.groups.join("、")}`}</small></th>
            <td data-label="成功率" className="model-rate">{percent(row.successRate)}</td><td data-label="平均延迟">{milliseconds(row.avgLatencyMs)}</td><td data-label="首字延迟">{milliseconds(row.avgTtftMs)}</td><td data-label={insight.source === "log" ? "估算速度 Token/s" : "输出速度 Token/s"}>{number(row.avgTps)}</td><td data-label="样本量" title={row.sampleCount === null ? "样本量未知" : undefined}>{number(row.sampleCount, 0)}</td>
            <td className="model-row-action"><button type="button" className="button text-button" aria-label={`查看 ${row.model} 趋势`} aria-expanded={detail?.model === row.model} disabled={!canRead || busy || changed || insight.source === "catalog"} onClick={() => void showDetail(row)}>{pending === `detail:${row.model}` ? "读取中…" : detail?.model === row.model ? "收起" : "分组与趋势"}<ChevronDown size={14} /></button></td>
          </tr>)}
        </tbody></table>{rows.length === 0 && <p className="model-empty">{insight.rows.length ? "没有符合筛选的模型，试试清空搜索或关闭流量筛选。" : "此窗口没有可展示的模型记录。"}</p>}</div>
        <p className="model-table-note">— 表示未知或无指标。{insight.source === "log" ? "输出速度由调用日志估算，只反映已读取样本。" : "站点统计的样本量未提供时保持未知。"}</p>
        {detailError && <p role="alert" className="model-error">{detailError}</p>}
        {detail && <Detail data={detail} onClose={() => { generation.current++; setDetail(null); }} />}
      </>}
    </div>
  </Modal>;
}
