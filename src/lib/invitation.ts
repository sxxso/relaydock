import { z } from "zod";
import ipaddr from "ipaddr.js";

const secretParameter = /^(?:token|access_token|refresh_token|api[-_]?key|key|secret|password|auth|authorization|session)$/i;
export const invitationMessages = {
  unsupported: "站点不支持标准邀请接口；可手动填写邀请链接。",
  unauthorized: "邀请接口未授权；请检查管理 PAT 与用户 ID。",
  needsWeb: "站点返回网页或验证页面；请到站点查看邀请链接并手动填写。",
  failed: "未获取到有效邀请码；已保留原有链接，可稍后重试或手动填写。",
  changed: "账号连接或邀请资料已改变；旧结果未保存，请重新打开。",
  busy: "此账号正在查询，请等待完成后获取邀请码。",
} as const;
export function publicInvitationError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return (Object.values(invitationMessages) as string[]).includes(message) ? message : invitationMessages.failed;
}
export const invitationUrlSchema = z.string().trim().min(1).max(2048).refine(value => {
  try {
    const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || /[\r\n\u0000]/.test(value)) return false;
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || (!host.includes(".") && !ipaddr.isValid(host))) return false;
    if (ipaddr.isValid(host) && ipaddr.process(host).range() !== "unicast") return false;
    if ([...url.searchParams.keys()].some(key => secretParameter.test(key))) return false;
    let fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment.split(/[?&;]/).some(part => part.includes("=") && secretParameter.test(part.split("=")[0].trim()))) return false;
    return true;
  } catch { return false; }
}, "请输入不含凭据的完整公开 http(s) 邀请或注册地址");
export const invitationCodeSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const optionalUrl = z.union([invitationUrlSchema, z.literal("")]);
export const invitationFetchedSchema = z.object({ code: invitationCodeSchema, url: invitationUrlSchema, at: z.iso.datetime() }).strict();
export const invitationSchema = z.object({
  version: z.literal(1), accountId: z.string().min(1).max(100), revision: z.number().int().nonnegative(),
  registerUrl: optionalUrl, manualUrl: optionalUrl, manualAt: z.iso.datetime().nullable(), fetched: invitationFetchedSchema.nullable(),
}).strict();
export type Invitation = z.infer<typeof invitationSchema>;
export const invitationSaveInput = z.object({ registerUrl: optionalUrl, manualUrl: optionalUrl, expectedRevision: z.number().int().nonnegative(), expectedUpdatedAt: z.iso.datetime() }).strict();
export const invitationBackupEntry = invitationSchema.pick({ accountId: true, registerUrl: true, manualUrl: true, manualAt: true }).strict();
export const invitationBackupSchema = z.array(invitationBackupEntry).max(5000).refine(entries => new Set(entries.map(entry => entry.accountId)).size === entries.length, "邀请资料账号重复");
export function emptyInvitation(accountId: string, revision = 0): Invitation {
  return { version: 1, accountId, revision, registerUrl: "", manualUrl: "", manualAt: null, fetched: null };
}
export function parseInvitationCode(body: unknown) {
  const reply = z.object({ success: z.literal(true), data: invitationCodeSchema }).safeParse(body);
  if (!reply.success) throw new Error("邀请接口未返回有效邀请码");
  return reply.data.data;
}
export function invitationLink(siteUrl: string, code: string, registerUrl = "") {
  const url = new URL(registerUrl || siteUrl);
  // Console paths such as /keys are not a registration base. Reverse-proxy
  // subpaths and customized frontends should use an explicit register URL.
  if (!registerUrl) { url.pathname = "/sign-up"; url.search = ""; url.hash = ""; }
  url.searchParams.set("aff", invitationCodeSchema.parse(code));
  return invitationUrlSchema.parse(url.toString());
}
export function readInvitation(value: unknown, accountId: string) {
  if (!value || typeof value !== "object") throw new Error("invalid invitation response");
  const parsed = invitationSchema.parse((value as { invitation?: unknown }).invitation);
  if (parsed.accountId !== accountId) throw new Error("wrong invitation account");
  return parsed;
}
