import { randomBytes, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import {
  BatchUpdateError,
  MoveAccountError,
  GroupLayoutError,
  type Store,
} from "./store";
import { verifyPassword, hashPassword, tokenHash } from "./crypto";
import {
  accountDetails,
  batchInput,
  undoInput,
  moveInput,
  draftQueryInput,
  settingsSchema,
} from "./validation";
import { queryBalance, BalanceQueryFailure } from "./query-balance";
import type { QueryDiagnostic } from "./query-diagnostics";
import { queryRoutingStatus } from "./query-routing-server";
import { queryRouteInput, queryRouteRequest } from "./query-routing";
import { modelDetailInput, modelInsightInput, ModelQueryFailure, queryModelDetail, queryModelInsight } from "./query-model-insight";
import { checkinBatchInput, checkinStatusInput, checkinSubmitInput } from "./query-checkin";
import { monthSchema } from "./checkin";
import { batchCheckin, isCheckinBusy, localCheckin, readCheckinStatus, submitCheckin } from "./checkin-service";
import { invitationSaveInput } from "./invitation";
import { invitationFetchInput, invitationFailure, queryInvitation } from "./query-invitation";
// Database-scoped locks: parallel temporary stores do not block each other,
// while multiple Store handles of the same DB cannot double-read one account.
const modelBusy = new Map<string, Set<string>>();
const modelIsBusy = (store: Store, id: string) => modelBusy.get(store.modelInsightScope)?.has(id) ?? false;
const busy = new Set<string>();
const draftBusy = new Set<string>();
const attempts = new Map<string, { count: number; until: number }>();
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public diagnostic?: QueryDiagnostic,
  ) {
    super(message);
  }
}
const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
function sessionCookie(req: Request) {
  let raw = req.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("atlas_session="))
    ?.slice(14);
  return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : undefined;
}
function expectedOrigin(req: Request) {
  if (process.env.RELAYDOCK_PUBLIC_URL)
    return new URL(process.env.RELAYDOCK_PUBLIC_URL).origin;
  // Next may canonicalize req.url to localhost even when the browser uses
  // 127.0.0.1. Honor Host only for explicit loopback names, never public hosts.
  const internal = new URL(req.url);
  const host = req.headers.get("host");
  const local = host ? new URL(internal.protocol + "//" + host) : internal;
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) ||
    local.username ||
    local.password ||
    (host && (local.pathname !== "/" || local.search || local.hash))
  )
    throw new ApiError(
      403,
      "对外部署须配置 RELAYDOCK_PUBLIC_URL；请求来源不被允许",
    );
  return local.origin;
}
function checkOrigin(req: Request) {
  if (req.headers.get("origin") !== expectedOrigin(req))
    throw new ApiError(403, "请求来源不被允许");
}
async function body(req: Request, allowEmpty = false, limit = 8 * 1024 * 1024) {
  let reader = req.body?.getReader();
  if (!reader) return {};
  let chunks: Uint8Array[] = [],
    length = 0;
  while (true) {
    let r = await reader.read();
    if (r.done) break;
    length += r.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new ApiError(413, limit === 8 * 1024 * 1024 ? "请求不能超过 8 MB" : "邀请请求过大");
    }
    chunks.push(r.value);
  }
  if (allowEmpty && length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "请求不是有效 JSON");
  }
}
export async function handleApi(req: Request, path: string[], store: Store) {
  try {
    let method = req.method,
      key = path.join("/"),
      raw = sessionCookie(req),
      session = raw ? store.session(tokenHash(raw)) : undefined;
    if (key === "auth/session" && method === "GET")
      return json({
        authenticated: !!session,
        configured: !!store.getMeta("adminHash"),
        csrf: session?.csrf,
        settings: session ? store.settings() : undefined,
      });
    if (key === "auth/login" && method === "POST") {
      checkOrigin(req);
      let { password } = z
        .object({ password: z.string().max(256) })
        .parse(await body(req));
      let rateKey = "admin",
        now = Date.now(),
        rate = attempts.get(rateKey);
      if (rate && rate.until > now && rate.count >= 8)
        throw new ApiError(429, "尝试次数过多，请 15 分钟后重试");
      let hash = store.getMeta("adminHash");
      if (!hash)
        throw new ApiError(
          503,
          "尚未初始化管理员，请在本机运行 npm run setup 并重启服务",
        );
      if (!verifyPassword(password, hash)) {
        attempts.set(rateKey, {
          count: rate && rate.until > now ? rate.count + 1 : 1,
          until: rate && rate.until > now ? rate.until : now + 15 * 60 * 1000,
        });
        throw new ApiError(401, "密码不正确");
      }
      attempts.delete(rateKey);
      let token = randomBytes(32).toString("hex"),
        csrf = randomBytes(24).toString("hex");
      store.createSession(tokenHash(token), csrf);
      let secure = expectedOrigin(req).startsWith("https:") ? "; Secure" : "";
      return json({ csrf, settings: store.settings() }, 200, {
        "Set-Cookie": `atlas_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure}`,
      });
    }
    if (!session) throw new ApiError(401, "请先登录");
    if (!["GET", "HEAD"].includes(method)) {
      checkOrigin(req);
      let csrf = req.headers.get("x-csrf-token") || "";
      if (
        !/^[a-f0-9]{48}$/.test(csrf) ||
        csrf.length !== session.csrf.length ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))
      )
        throw new ApiError(403, "安全校验失效，请刷新页面重试");
    }
    if (key === "auth/logout" && method === "POST") {
      store.deleteSession(tokenHash(raw!));
      return json({ ok: true }, 200, {
        "Set-Cookie":
          "atlas_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
      });
    }
    if (key === "auth/password" && method === "POST") {
      let p = z
        .object({
          current: z.string().max(256),
          password: z.string().min(12, "新密码至少 12 个字符").max(128),
        })
        .parse(await body(req));
      if (!verifyPassword(p.current, store.getMeta("adminHash")!))
        throw new ApiError(400, "当前密码不正确");
      store.setMeta("adminHash", hashPassword(p.password));
      store.deleteAllSessions();
      return json({ ok: true }, 200, {
        "Set-Cookie":
          "atlas_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
      });
    }
    if (key === "views" && method === "GET")
      return json({ views: store.savedViews() });
    if (key === "views" && method === "PUT")
      return json(store.saveView(await body(req)));
    if (path[0] === "views" && path.length === 2 && method === "DELETE")
      return json(store.deleteSavedView(path[1]));
    if (key === "accounts" && method === "GET")
      return json({
        accounts: store.list(),
        settings: store.settings(),
        queryRouting: queryRoutingStatus(store),
        groupLayout: store.groupLayout(),
        groupColors: store.groupColors(),
        savedViews: store.savedViews(),
      });
    if (key === "map/groups/move" && method === "POST")
      return json(store.moveGroup(await body(req)));
    if (key === "map/groups/rename" && method === "POST")
      return json(store.renameGroup(await body(req)));
    if (key === "map/groups/color" && method === "POST")
      return json(store.setGroupColor(await body(req)));
    if (key === "query/routing" && method === "GET")
      return json(queryRoutingStatus(store));
    if (key === "query/routing" && method === "POST") {
      const { mode } = queryRouteInput.parse(await body(req));
      const status = queryRoutingStatus(store);
      if (mode === "proxy" && !status.proxyValid)
        throw new ApiError(
          400,
          status.proxyConfigured
            ? "查询代理配置无效，请检查部署配置或选择直连"
            : "尚未配置查询代理，请先由部署者配置后重启服务",
        );
      store.setMeta("queryRoute", mode);
      return json({ ...status, mode });
    }
    if (key === "accounts" && method === "POST")
      return json(store.create(await body(req)), 201);
    if (key === "checkin/batch" && method === "POST") {
      const input = checkinBatchInput.parse(await body(req));
      const route = input.routeMode ?? queryRoutingStatus(store).mode;
      return json(await batchCheckin(store, input.ids, route, input.refreshBalance, id => busy.has(id)));
    }
    if (key === "query/test" && method === "POST") {
      const draft = draftQueryInput.parse(await body(req));
      const sessionId = tokenHash(raw!);
      if (draftBusy.has(sessionId))
        throw new ApiError(409, "草稿正在测试，请勿重复点击");
      draftBusy.add(sessionId);
      try {
        const { credential, routeMode, ...details } = draft;
        const account = accountDetails.parse({ name: "查询草稿", ...details });
        const { result, diagnostic } = await queryBalance(
          account,
          credential,
          "test",
          routeMode ?? queryRoutingStatus(store).mode,
        );
        return json({ ok: true, ...result, diagnostic });
      } catch (e) {
        if (e instanceof BalanceQueryFailure)
          throw new ApiError(e.status, e.message, e.diagnostic);
        throw e;
      } finally {
        draftBusy.delete(sessionId);
      }
    }
    if (key === "accounts/move" && method === "POST") {
      const p = moveInput.safeParse(await body(req));
      if (!p.success)
        throw new MoveAccountError(400, "移动命令无效；未修改站点");
      const current = store.get(p.data.id);
      if (
        store
          .list()
          .some(
            (a) =>
              !a.archived &&
              ((a.group || "未分组") === (current?.group || "未分组") ||
                (a.group || "未分组") === p.data.group) &&
              busy.has(a.id),
          )
      )
        throw new ApiError(409, "分组内有站点正在查询，请等待完成后移动");
      return json({ accounts: store.moveAccount(p.data) });
    }
    if (key === "accounts/undo" && method === "POST") {
      const parsed = undoInput.safeParse(await body(req));
      if (!parsed.success) throw new ApiError(400, "撤销命令无效");
      if (parsed.data.entries.some((entry) => busy.has(entry.id)))
        throw new ApiError(409, "所选账号正在查询，请等待完成后撤销");
      return json(store.undoFields(parsed.data));
    }
    if (key === "accounts/batch" && method === "POST") {
      const parsed = batchInput.safeParse(await body(req));
      if (!parsed.success) throw new BatchUpdateError("invalid");
      if (parsed.data.ids.some((id) => busy.has(id)))
        throw new ApiError(409, "所选账号正在查询，请等待完成后批量修改");
      return json({ accounts: store.batchUpdate(parsed.data) });
    }
    if (path[0] === "accounts" && path[1]) {
      let id = path[1],
        a = store.get(id);
      if (!a) throw new ApiError(404, "账号不存在");
      if (path[2] === "invitation" && path.length === 3 && method === "GET") {
        if (new URL(req.url).search) throw new ApiError(400, "邀请记录不接受查询参数");
        return json({ invitation: store.invitation(id) });
      }
      if (path[2] === "invitation" && path.length === 3 && method === "PATCH") {
        const command = invitationSaveInput.parse(await body(req, false, 16384));
        const current = store.get(id);
        if (!current) throw new ApiError(404, "账号不存在");
        if (current.provider !== "newapi") throw new ApiError(400, "邀请链接仅支持 New API 账户管理模板。");
        const invitation = store.saveInvitationManual(id, command);
        if (!invitation) throw new ApiError(409, "邀请资料已改变；请关闭并重新打开后再编辑。");
        return json({ invitation });
      }
      if (path[2] === "invitation" && path.length === 4 && path[3] === "fetch" && method === "POST") {
        const input = invitationFetchInput.parse(await body(req, false, 16384));
        const connection = store.modelInsightConnection(id);
        if (!connection) throw new ApiError(404, "账号不存在");
        if (connection.account.updatedAt !== input.expectedUpdatedAt) throw new ApiError(409, "账号连接或邀请资料已改变；旧结果未保存，请重新打开。");
        if (connection.account.provider !== "newapi") throw new ApiError(400, "邀请链接仅支持 New API 账户管理模板。");
        if (connection.account.archived) throw new ApiError(400, "归档账号不能获取邀请码；可查看本地链接。");
        if (!connection.credential) throw new ApiError(400, "缺少管理 PAT；模型 Key 不能替代管理凭据。");
        if (!connection.account.userId) throw new ApiError(400, "缺少用户 ID，请在编辑档案中补充。");
        if (store.invitation(id).revision !== input.expectedRevision) throw new ApiError(409, "邀请资料已改变；请重新打开后获取。");
        if (busy.has(id) || isCheckinBusy(store, id) || modelIsBusy(store, id)) throw new ApiError(409, "此账号正在查询，请等待完成后获取邀请码。");
        // Shared with balance/checkin locking: acquire only after the bounded body
        // and current connection have been read, before the generating provider GET.
        busy.add(id);
        try {
          let code: string;
          try { code = await queryInvitation(connection.account, connection.credential, input.routeMode ?? queryRoutingStatus(store).mode); }
          catch (error) { throw new ApiError(502, invitationFailure(error)); }
          const invitation = store.saveInvitationFetched(id, code, connection.connectionVersion, input.expectedRevision);
          if (!invitation) throw new ApiError(409, "账号连接或邀请资料已改变；旧结果未保存，请重新打开。");
          return json({ invitation });
        } finally { busy.delete(id); }
      }
      if (path[2] === "checkin" && path.length === 3 && method === "GET") {
        const params = new URL(req.url).searchParams;
        if ([...params.keys()].some(key => key !== "month") || params.getAll("month").length > 1) throw new ApiError(400, "签到月份参数无效");
        const month = params.has("month") ? monthSchema.parse(params.get("month")) : undefined;
        return json(localCheckin(store, id, month));
      }
      if (path[2] === "checkin" && method === "POST" && (path.length === 3 || (path.length === 4 && path[3] === "status"))) {
        const statusOnly = path.length === 4;
        const input = statusOnly ? checkinStatusInput.parse(await body(req)) : checkinSubmitInput.parse(await body(req));
        const route = input.routeMode ?? queryRoutingStatus(store).mode;
        if (!statusOnly) return json(await submitCheckin(store, id, route, checkinSubmitInput.parse(input).refreshBalance, key => busy.has(key)));
        const result = await readCheckinStatus(store, id, route, checkinStatusInput.parse(input).month, key => busy.has(key));
        if (!("version" in result)) throw new ApiError(result.outcome === "busy" || result.outcome === "changed" ? 409 : result.outcome === "missing" ? 404 : 400, result.message);
        return json(result);
      }
      if (path[2] === "models" && path.length === 3 && method === "GET") {
        return json({ insight: store.modelInsight(id) });
      }
      if (path[2] === "models" && method === "POST" && (path.length === 3 || (path.length === 4 && path[3] === "detail"))) {
        if (a.provider !== "newapi") throw new ApiError(400, "模型表现首轮仅支持 New API 账户管理模板。");
        if (a.archived) throw new ApiError(400, "归档账号不能读取模型表现。");
        const detail = path.length === 4;
        const input = detail ? modelDetailInput.parse(await body(req)) : modelInsightInput.parse(await body(req));
        const connection = store.modelInsightConnection(id);
        if (!connection) throw new ApiError(404, "账号不存在");
        if (connection.account.provider !== "newapi") throw new ApiError(400, "模型表现首轮仅支持 New API 账户管理模板。");
        if (connection.account.archived) throw new ApiError(400, "归档账号不能读取模型表现。");
        if (modelIsBusy(store, id)) throw new ApiError(409, "此账号正在读取模型表现，请等待完成。");
        const scope = modelBusy.get(store.modelInsightScope) || new Set<string>();
        modelBusy.set(store.modelInsightScope, scope); scope.add(id);
        const routeMode = input.routeMode ?? queryRoutingStatus(store).mode;
        const connectionVersion = connection.connectionVersion;
        try {
          if (detail) {
            const result = await queryModelDetail(connection.account, connection.credential, id, modelDetailInput.parse(input), routeMode);
            if (store.modelInsightConnectionVersion(id) !== connectionVersion) throw new ApiError(409, "账号连接配置已改变；请按新配置重新读取模型表现。");
            return json(result);
          }
          const insight = await queryModelInsight(connection.account, connection.credential, id, modelInsightInput.parse(input), routeMode);
          if (store.modelInsightConnectionVersion(id) !== connectionVersion) throw new ApiError(409, "账号连接配置已改变；请按新配置重新读取模型表现。");
          const previous = store.modelInsight(id);
          if ((insight.source !== "catalog" || !previous || previous.source === "catalog") && !store.saveModelInsight(id, insight, connectionVersion)) throw new ApiError(409, "账号连接配置已改变；请按新配置重新读取模型表现。");
          return json(insight);
        } finally {
          scope.delete(id); if (!scope.size) modelBusy.delete(store.modelInsightScope);
        }
      }
      if (path.length === 3 && path[2] === "favorite" && method === "POST") {
        const command = z
          .object({ favorite: z.boolean(), expectedUpdatedAt: z.iso.datetime().optional() })
          .strict()
          .parse(await body(req));
        return json(store.setFavorite(id, command.favorite, command.expectedUpdatedAt));
      }
      if (path.length === 2 && method === "PATCH")
        return json(store.update(id, await body(req)));
      if (path.length === 2 && method === "DELETE") {
        if (busy.has(id) || modelIsBusy(store, id) || isCheckinBusy(store, id))
          throw new ApiError(409, "账号正在查询，请等待完成后删除");
        store.remove(id);
        return json({ ok: true });
      }
      if (path[2] === "history" && method === "GET")
        return json({ snapshots: store.history(id) });
      if (path[2] === "balance" && method === "POST") {
        let b = z
          .object({
            amount: z.string(),
            note: z.string().max(2000).default(""),
          })
          .parse(await body(req));
        return json(store.record(id, b.amount, "manual", a.unit, b.note));
      }
      if (["sync", "test"].includes(path[2]) && method === "POST") {
        if (a.provider === "manual")
          throw new ApiError(400, "手动账号无需接口同步，请记录余额");
        if (a.archived) throw new ApiError(400, "归档账号不能查询");
        if (busy.has(id) || isCheckinBusy(store, id))
          throw new ApiError(409, "此账号正在查询，请勿重复点击");
        const { routeMode } = queryRouteRequest.parse(await body(req, true));
        if (busy.has(id) || isCheckinBusy(store, id))
          throw new ApiError(409, "此账号正在查询，请勿重复点击");
        busy.add(id);
        try {
          const { result, diagnostic } = await queryBalance(
            a,
            store.credential(id),
            path[2] as "test" | "sync",
            routeMode ?? queryRoutingStatus(store).mode,
          );
          if (path[2] === "sync")
            store.record(
              id,
              result.balance,
              "sync",
              result.unit,
              "接口同步",
              result.rawQuota,
              diagnostic,
            );
          else store.saveQueryDiagnostic(id, diagnostic);
          if (path[2] === "test")
            return json({
              ok: true,
              message: `连接成功 · ${diagnostic.totalMs} ms · 已读取余额；未修改余额`,
              durationMs: diagnostic.totalMs,
              provider: a.provider,
              diagnostic,
              ...result,
            });
          return json(store.get(id)!);
        } catch (e) {
          // Persistence failures are not provider/network failures. In particular,
          // do not save a successful sync report before its snapshot was saved.
          if (!(e instanceof BalanceQueryFailure)) throw e;
          const diagnostic = e.diagnostic,
            message = e.message;
          if (path[2] === "sync") store.syncFailure(id, message, diagnostic);
          else store.saveQueryDiagnostic(id, diagnostic);
          throw new ApiError(e.status, message, diagnostic);
        } finally {
          busy.delete(id);
        }
      }
    }
    if (key === "history" && method === "GET")
      return json({ snapshots: store.history() });
    if (key === "settings" && method === "PATCH")
      return json(store.setSettings(settingsSchema.parse(await body(req))));
    if (key === "backup/status" && method === "GET")
      return json(store.backupStatus());
    if (key === "backup/export" && method === "GET") {
      const backup = store.exportBackup();
      store.recordDataBackupExport(backup.exportedAt);
      return json(backup);
    }
    if (key === "backup/import" && method === "POST") {
      let input = await body(req);
      return json(store.importBackup(input.backup, input.preview !== false));
    }
    throw new ApiError(404, "接口不存在");
  } catch (e) {
    if (e instanceof ModelQueryFailure) return json({ error: e.message }, e.status);
    if (e instanceof ApiError)
      return json(
        {
          error: e.message,
          ...(e.diagnostic ? { diagnostic: e.diagnostic } : {}),
        },
        e.status,
      );
    if (e instanceof MoveAccountError || e instanceof GroupLayoutError)
      return json({ error: e.message }, e.status);
    if (e instanceof BatchUpdateError)
      return json({ error: e.message }, e.status);
    if (e instanceof ZodError)
      return json({ error: e.issues[0]?.message || "输入数据不正确" }, 400);
    if (
      e instanceof Error &&
      /账号不存在|金额|非负|备份快照与现有账号归属冲突|备份快照排序冲突|备份快照余额引用/.test(
        e.message,
      )
    )
      return json({ error: e.message }, 400);
    return json({ error: "操作失败，请检查输入或本机服务配置" }, 500);
  }
}





