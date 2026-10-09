"use client";
import { useEffect, useRef, useState } from "react";
import { Copy, Link2, RefreshCw, Save } from "lucide-react";
import type { Account } from "@/lib/validation";
import type { QueryRouteMode } from "@/lib/query-routing";
import { invitationSaveInput, publicInvitationError, readInvitation, type Invitation } from "@/lib/invitation";
import type { Send } from "./account-form";
import { Modal } from "./modal";
import "./invitation-panel.css";

type Props = { account: Account | null; open: boolean; onClose: () => void; send: Send; routeMode: QueryRouteMode | null; routingBusy?: boolean };
export function InvitationPanel(props: Props) {
  if (!props.open || !props.account) return null;
  return <InvitationContent {...props} account={props.account} key={`${props.account.id}:${props.account.updatedAt}`} />;
}
function InvitationContent({ account, send, routeMode, routingBusy = false, onClose }: Props & { account: Account }) {
  const [data, setData] = useState<Invitation | null>(null), [pending, setPending] = useState<"cache" | "fetch" | "save" | null>("cache");
  const [manualUrl, setManualUrl] = useState(""), [registerUrl, setRegisterUrl] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0), alive = useRef(false), inFlight = useRef(true);
  const dirty = !!data && (manualUrl !== data.manualUrl || registerUrl !== data.registerUrl);
  const blocked = account.provider !== "newapi" ? "邀请获取仅支持 New API 账户管理模板。" : account.archived ? "账号已归档，可查看和整理本地链接；取消归档后才能获取邀请码。" : !account.hasCredential ? "请在编辑档案中填写管理 PAT；模型 Key 不能替代管理凭据。" : !account.userId ? "请在编辑档案中填写用户 ID。" : "";
  const activeUrl = data?.manualUrl || data?.fetched?.url || "";
  useEffect(() => {
    alive.current = true; inFlight.current = true;
    const ticket = ++generation.current;
    void send<unknown>(`accounts/${account.id}/invitation`).then(response => {
      if (!alive.current || generation.current !== ticket) return;
      const value = readInvitation(response, account.id); setData(value); setManualUrl(value.manualUrl); setRegisterUrl(value.registerUrl);
    }).catch(() => { if (alive.current && generation.current === ticket) setError("本地邀请资料读取失败，请关闭并重新打开。"); })
      .finally(() => { if (alive.current && generation.current === ticket) { inFlight.current = false; setPending(null); } });
    return () => { alive.current = false; generation.current++; };
  }, [account.id, send]);
  async function execute(mode: "fetch" | "save") {
    if (!data || inFlight.current || (mode === "fetch" && (blocked || dirty || routeMode === null || routingBusy))) return;
    let command: unknown;
    if (mode === "save") {
      const parsed = invitationSaveInput.safeParse({ manualUrl, registerUrl, expectedRevision: data.revision, expectedUpdatedAt: account.updatedAt });
      if (!parsed.success) { setError("请输入完整公开 http(s) 地址，不要包含密码、Token 或密钥参数。"); return; }
      command = parsed.data;
    } else command = { expectedRevision: data.revision, expectedUpdatedAt: account.updatedAt, routeMode };
    const ticket = ++generation.current; inFlight.current = true; setPending(mode); setError(""); setNotice("");
    try {
      const value = readInvitation(await send<unknown>(`accounts/${account.id}/invitation${mode === "fetch" ? "/fetch" : ""}`, mode === "fetch" ? "POST" : "PATCH", command), account.id);
      if (!alive.current || generation.current !== ticket) return;
      setData(value); setManualUrl(value.manualUrl); setRegisterUrl(value.registerUrl);
      setNotice(mode === "save" ? "邀请资料已保存到本地。" : value.manualUrl ? "邀请码已获取，手动链接仍优先使用。" : "邀请码已获取并缓存。请确认站点注册入口与生成链接一致。");
    } catch (failure) {
      if (alive.current && generation.current === ticket) setError(mode === "fetch" ? publicInvitationError(failure) : "保存失败，资料可能已改变；请关闭后重新打开再编辑。");
    } finally { if (alive.current && generation.current === ticket) { inFlight.current = false; setPending(null); } }
  }
  async function copy(text: string) {
    const ticket = generation.current;
    try { await navigator.clipboard.writeText(text); if (alive.current && generation.current === ticket) setNotice("已复制。"); }
    catch { if (alive.current && generation.current === ticket) setError("复制失败，请选中内容后手动复制。"); }
  }
  const close = () => { alive.current = false; generation.current++; onClose(); };
  const date = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
  return <Modal open wide onClose={close} title={`邀请链接 · ${account.name}`} description="查看本地保存的邀请链接，或主动获取 New API 邀请码。">
    <div className="invitation-panel" data-testid="invitation-panel">
      <p className="invitation-help">打开面板只读取本地记录。点击获取会访问站点；如果尚无邀请码，New API 可能为你生成一个。</p>
      {error && <p role="alert" className="invitation-error">{error}</p>}
      {notice && <p role="status" className="invitation-notice">{notice}</p>}
      {pending === "cache" ? <p role="status">正在读取本地邀请资料…</p> : <>
        <section className="invitation-current" aria-label="当前邀请链接">
          <div className="invitation-heading"><h3><Link2 size={17} />当前邀请链接</h3><span>{data?.manualUrl ? "手动填写" : data?.fetched ? "站点获取 · 本地缓存" : "尚未保存"}</span></div>
          {activeUrl ? <><output className="invitation-url" aria-label="已保存邀请链接">{activeUrl}</output><button className="button" type="button" onClick={() => void copy(activeUrl)}><Copy size={15} />复制邀请链接</button></> : <p className="invitation-help">获取邀请码或手动填写完整邀请链接。</p>}
          {data?.manualUrl && data.manualAt && <p className="invitation-help">手动保存于 <time dateTime={data.manualAt}>{date(data.manualAt)}</time></p>}
        </section>
        <section className="invitation-fetched" aria-label="站点邀请码">
          <div className="invitation-heading"><h3>New API 邀请码</h3><button className="button" type="button" disabled={!!pending || !data || !!blocked || dirty || routingBusy || routeMode === null} onClick={() => void execute("fetch")}><RefreshCw size={15} className={pending === "fetch" ? "spin" : ""} />{pending === "fetch" ? "正在获取…" : "获取邀请码"}</button></div>
          {data?.fetched && <><div className="invitation-code"><output aria-label="已获取邀请码">{data.fetched.code}</output><button className="button" type="button" onClick={() => void copy(data.fetched!.code)}><Copy size={15} />复制邀请码</button></div><p className="invitation-help">获取于 <time dateTime={data.fetched.at}>{date(data.fetched.at)}</time>。缓存可能过期；仅获取时访问站点。</p>{data.manualUrl && <p className="invitation-help">自动生成的链接：<span className="invitation-secondary-url">{data.fetched.url}</span></p>}</>}
          <p className="invitation-help">{blocked || (routingBusy || routeMode === null ? "查询线路准备中。" : `本次点击使用${routeMode === "proxy" ? "代理" : "直连"}线路。`)}{dirty && "请先保存修改，再获取邀请码。"}</p>
        </section>
        <form className="invitation-editor" onSubmit={event => { event.preventDefault(); void execute("save"); }}>
          <label><span>手动邀请链接</span><input aria-label="手动邀请链接" type="url" value={manualUrl} maxLength={2048} disabled={!!pending || !data || account.provider !== "newapi"} placeholder="https://example.com/register?aff=…" onChange={event => setManualUrl(event.target.value)} /></label>
          <p className="invitation-help">手动链接优先，获取邀请码不会覆盖它；清空并保存后使用自动链接。</p>
          <label><span>自定义注册地址（可选）</span><input aria-label="自定义注册地址" type="url" value={registerUrl} maxLength={2048} disabled={!!pending || !data || account.provider !== "newapi"} placeholder="留空使用站点域名下的 /sign-up" onChange={event => setRegisterUrl(event.target.value)} /></label>
          <p className="invitation-help">默认使用 New API 新版 /sign-up；旧版 /register 或子路径请填写完整注册地址。自动链接追加 aff 参数，保留已有公开参数；此地址不接收管理凭据，也不会被请求。</p>
          <button type="submit" className="button primary" disabled={!!pending || !data || !dirty || account.provider !== "newapi"}><Save size={15} />{pending === "save" ? "正在保存…" : "保存邀请资料"}</button>
        </form>
      </>}
    </div>
  </Modal>;
}
