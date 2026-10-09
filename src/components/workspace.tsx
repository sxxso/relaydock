"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Map,
  LayoutList,
  Plus,
  Search,
  RefreshCw,
  Star,
  History,
  Settings as SettingsIcon,
  LogOut,
  ArrowUpRight,
  Copy,
  MoreHorizontal,
  X,
  Compass,
  PenLine,
  Archive,
  Trash2,
  AlertCircle,
  Check,
  LoaderCircle,
  Command,
  SlidersHorizontal,
  ExternalLink,
  Sun,
  Moon,
  Bookmark,
  Palette,
  Activity,
  CalendarCheck,
} from "lucide-react";
import type { Account, Settings } from "@/lib/validation";
import { filterAccounts, hasAccountFilters, isOlderThanSevenDays } from "@/lib/account-filter";
import { type SavedView, type SavedViewFilters } from "@/lib/saved-views";
import { displayAmount, isLow, totals, unitKey } from "@/lib/money";
import { groupColorIndex } from "@/lib/map-layout";
import { groupColorStyle, type GroupColors } from "@/lib/group-colors";
import { AtlasMap } from "./atlas-map";
import { AccountForm, BalanceForm, type Send } from "./account-form";
import { Modal } from "./modal";
import { ModelInsightPanel } from "./model-insight-panel";
import { CheckinPanel } from "./checkin-panel";
import { InvitationPanel } from "./invitation-panel";
import { CheckinBatchPanel } from "./checkin-batch-panel";
import type { CheckinResult } from "@/lib/checkin";
import { HistoryPage, SettingsPage } from "./pages";
import { useAppearance } from "./use-appearance";
import { AtlasSelect } from "./atlas-select";
import { platformOf } from "@/lib/platform-catalog";
import { QueryDiagnosticPanel } from "./query-diagnostic";
import { normalizeDiagnostic } from "@/lib/query-diagnostics";
import { balanceFreshness } from "@/lib/balance-freshness";
import { BalanceFreshness } from "./balance-freshness";
import { useFreshnessClock } from "./use-freshness-clock";
import {
  retainVisibleSelection,
  revealAccountFilters,
} from "@/lib/map-management";
import { BatchManagement, SelectionBox } from "./batch-management";
import "./interaction-motion.css";
import { QueryRouteSwitch } from "./query-route-switch";
import type { QueryRouteMode, QueryRoutingStatus } from "@/lib/query-routing";
import type { GroupLayout } from "@/lib/group-layout";
import { makeUndoEntry, type UndoEntry } from "@/lib/undo";
import { GroupRename } from "./group-rename";
import { GroupColorEditor } from "./group-color-editor";
import { WorkspaceLoading } from "./workspace-loading";
import { usePendingUndo } from "./use-pending-undo";
import { UndoNotice } from "./undo-notice";
import { useFilterMenuPosition } from "./use-filter-menu-position";
import { mergeLatestAccounts } from "@/lib/pending-undo";
import {
  AccountReadState,
  accountWriteRequest,
} from "@/lib/account-read-state";
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Compass size={25} strokeWidth={1.3} />
      </span>
      <strong>汇站</strong>
      <span className="brand-english">Atlas</span>
    </div>
  );
}
function Login({
  configured,
  onLogin,
}: {
  configured: boolean;
  onLogin: (csrf: string, settings: Settings) => void;
}) {
  let [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <header>
        <Brand />
        <span className="private-label">独立部署 · 私有记录</span>
      </header>
      <div className="login-layout">
        <section className="login-intro">
          <span className="ink-stroke" />
          <h1>
            把散落的站点，
            <br />
            收拢成自己的群岛。
          </h1>
          <p>
            余额、入口与每一次记录，
            <br />
            都在你的掌握之中。
          </p>
          <div className="login-illustration" aria-hidden="true">
            <svg viewBox="0 0 560 230">
              <path
                d="M39 86 C80 22 250 24 295 87 C349 164 215 218 99 182 C35 162 5 128 39 86Z"
                fill="var(--island-a)"
              />
              <ellipse
                cx="166"
                cy="118"
                rx="124"
                ry="71"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="10"
                opacity=".15"
                strokeDasharray="150 34 240 40"
              />
              <path
                d="M365 64 C423 25 527 76 534 128 C543 198 413 216 366 164 C345 139 340 90 365 64Z"
                fill="var(--island-b)"
              />
              <circle cx="137" cy="108" r="20" fill="var(--accent)" />
              <circle
                cx="225"
                cy="149"
                r="14"
                fill="var(--accent)"
                opacity=".5"
              />
              <circle
                cx="440"
                cy="119"
                r="17"
                fill="var(--ink-soft)"
                opacity=".6"
              />
            </svg>
          </div>
          <div className="login-promises">
            <span>
              <ShieldMark />
              数据留在本机
            </span>
            <span>
              <RefreshCw size={14} />
              只在点击时查询
            </span>
          </div>
        </section>
        <section className="login-form">
          <span className="subtle-badge">管理员入口</span>
          <h2>欢迎回到汇站</h2>
          <p>从一片安静的地图开始。</p>
          {configured ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                try {
                  let r = await fetch("/api/auth/login", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ password }),
                  });
                  let d = await r.json();
                  if (!r.ok) throw new Error(d.error);
                  setPassword("");
                  onLogin(d.csrf, d.settings);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label className="field">
                <span>管理员密码</span>
                <input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoFocus
                />
              </label>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button className="button primary login-submit" disabled={busy}>
                {busy ? <LoaderCircle size={16} className="spin" /> : null}
                {busy ? "验证中…" : "进入我的群岛"}
                <ArrowUpRight size={16} />
              </button>
            </form>
          ) : (
            <div className="setup-note">
              <h3>先给你的群岛一把钥匙</h3>
              <p>
                在项目终端运行以下命令，设置至少 12 位管理员密码，然后重启服务。
              </p>
              <code>npm run setup</code>
              <p>没有默认密码，也没有开放注册。</p>
            </div>
          )}
          <p className="login-footnote">
            令牌在服务端加密保存，不会出现在导出文件中。
          </p>
        </section>
      </div>
      <footer>你的站点，你的节奏。</footer>
    </main>
  );
}
function ShieldMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.5 13 3.5V8c0 3-5 6-5 6S3 11 3 8V3.5L8 1.5Z"
        fill="none"
        stroke="currentColor"
      />
      <path d="m5 8 2 2 4-4" fill="none" stroke="currentColor" />
    </svg>
  );
}
export function Workspace() {
  const [auth, setAuth] = useState<"loading" | "login" | "ready">("loading"),
    [configured, setConfigured] = useState(true),
    [csrf, setCsrf] = useState(""),
    [accounts, setAccounts] = useState<Account[]>([]),
    [dataReady, setDataReady] = useState(false),
    [groupColors, setGroupColors] = useState<GroupColors>({ revision: 0, colors: [] }),
    [colorBusy, setColorBusy] = useState(false),
    [colorEditingGroup, setColorEditingGroup] = useState<string | null>(null),
    [settings, setSettings] = useState<Settings>({
      theme: "light",
      motion: true,
    }),
    [settingsBusy, setSettingsBusy] = useState(false),
    [queryRouting, setQueryRouting] = useState<QueryRoutingStatus | null>(null),
    [routingBusy, setRoutingBusy] = useState(false),
    [draftTesting, setDraftTesting] = useState(false),
    [groupLayout, setGroupLayout] = useState<GroupLayout>({
      revision: 0,
      positions: [],
    }),
    [page, setPage] = useState<"sites" | "history" | "settings">("sites"),
    [view, setView] = useState<"map" | "list">("map"),
    [search, setSearch] = useState(""),
    [group, setGroup] = useState("all"),
    [currency, setCurrency] = useState("all"),
    [favorites, setFavorites] = useState(false),
    [onlyLow, setOnlyLow] = useState(false),
    [archive, setArchive] = useState<SavedViewFilters["archive"]>("active"),
    [recordAge, setRecordAge] = useState<SavedViewFilters["recordAge"]>("any"),
    [sort, setSort] = useState<SavedViewFilters["sort"]>("name"),
    [savedViews, setSavedViews] = useState<SavedView[]>([]),
    [activeViewId, setActiveViewId] = useState<string | null>(null),
    [saveViewOpen, setSaveViewOpen] = useState(false),
    [viewName, setViewName] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [focusVersion, setFocusVersion] = useState(0),
    [renamingGroup, setRenamingGroup] = useState<string | null>(null),
    [detailClosing, setDetailClosing] = useState(false),
    [edit, setEdit] = useState<Account | null>(null),
    [formOpen, setFormOpen] = useState(false),
    [balanceOpen, setBalanceOpen] = useState(false),
    [modelOpen, setModelOpen] = useState(false),
    [checkinOpen, setCheckinOpen] = useState(false),
    [invitationOpen, setInvitationOpen] = useState(false),
    [invitationBusy, setInvitationBusy] = useState(false),
    [checkinBusy, setCheckinBusy] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [busy, setBusy] = useState<Set<string>>(new Set()),
    [batch, setBatch] = useState(false),
    [moving, setMoving] = useState(false),
    [toast, setToast] = useState(""),
    [loadError, setLoadError] = useState(""),
    [commands, setCommands] = useState(false),
    [commandSearch, setCommandSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
      new Set(),
    ),
    [batchMode, setBatchMode] = useState(false),
    [batchSelection, setBatchSelection] = useState<ReadonlySet<string>>(
      new Set(),
    );
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [checkinScope, setCheckinScope] = useState<{ accounts: Account[]; scope: "selected" | "filtered" } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    accountReads = useRef(new AccountReadState()),
    authVersion = useRef(0),
    settingsSaving = useRef(false),
    settingsVersion = useRef(0),
    routingSaving = useRef(false),
    routingVersion = useRef(0),
    routingRef = useRef<QueryRoutingStatus | null>(null),
    layoutSaving = useRef(false),
    layoutVersion = useRef(0),
    layoutRef = useRef<GroupLayout>({ revision: 0, positions: [] }),
    colorRef = useRef<GroupColors>({ revision: 0, colors: [] }),
    colorSaving = useRef(false),
    colorVersion = useRef(0),
    queriesRunning = useRef(0),
    checkinRequests = useRef(0),
    invitationRequests = useRef(0),
    batchRunning = useRef(false),
    detailTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    filterPanel = useRef<HTMLDetailsElement>(null),
    searchRef = useRef<HTMLInputElement>(null);
  const resolvedTheme = useAppearance(settings, auth === "ready");
  useFilterMenuPosition(filterPanel);
  const noticesBlocked = formOpen || balanceOpen || deleteOpen || commands || !!renamingGroup || colorEditingGroup !== null || saveViewOpen || batchDialogOpen || checkinOpen || invitationOpen || checkinScope !== null;
  const { action: undoAction, controller: undoController } = usePendingUndo(auth === "ready", noticesBlocked);
  const freshnessNow = useFreshnessClock(auth === "ready" && page === "sites");
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (detailTimer.current) clearTimeout(detailTimer.current);
    },
    [],
  );
  const offerUndo = useCallback((message: string, entries: UndoEntry[]) => {
    undoController.offer(message, entries);
  }, [undoController]);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  }, []);
  const send = useCallback<Send>(
    async (path, method = "GET", data) => {
      const session = authVersion.current;
      const finishWrite = accountWriteRequest(path, method)
        ? accountReads.current.beginWrite()
        : undefined;
      try {
        let res = await fetch("/api/" + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(method !== "GET" ? { "x-csrf-token": csrf } : {}),
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        let b = await res.json();
        if (session !== authVersion.current) throw new Error("会话已变化，请重新登录后操作");
        if (res.status === 401 && path !== "auth/login" && session === authVersion.current) setAuth("login");
        if (!res.ok)
          throw Object.assign(new Error(b.error || "操作失败"), {
            status: res.status,
            diagnostic: normalizeDiagnostic(b.diagnostic),
          });
        return b;
      } finally {
        finishWrite?.();
      }
    },
    [csrf],
  );
  const load = useCallback(async () => {
    const startedAuthVersion = authVersion.current;
    const startedVersion = settingsVersion.current;
    const startedRoutingVersion = routingVersion.current;
    const startedLayoutVersion = layoutVersion.current;
    const startedColorVersion = colorVersion.current;
    const accountTicket = accountReads.current.beginRead();
    try {
      let d = await send<{
        accounts: Account[];
        settings: Settings;
        queryRouting: QueryRoutingStatus;
        groupLayout: GroupLayout;
        groupColors: GroupColors;
        savedViews: SavedView[];
      }>("accounts");
      // An old GET must not undo a newer saved account, group rename or sync.
      const currentSession = startedAuthVersion === authVersion.current;
      const currentRead = currentSession && accountReads.current.canApply(accountTicket);
      if (currentRead) setAccounts(d.accounts);
      if (currentRead) setSavedViews(d.savedViews || []);
      if (currentRead && !colorSaving.current && !layoutSaving.current && startedColorVersion === colorVersion.current && d.groupColors.revision >= colorRef.current.revision) {
        colorRef.current = d.groupColors;
        setGroupColors(d.groupColors);
      }
      if (
        currentSession && !layoutSaving.current &&
        startedLayoutVersion === layoutVersion.current &&
        d.groupLayout.revision >= layoutRef.current.revision
      ) {
        layoutRef.current = d.groupLayout;
        setGroupLayout(d.groupLayout);
      }
      if (currentSession && !settingsSaving.current && startedVersion === settingsVersion.current)
        setSettings(d.settings);
      if (
        currentSession && !routingSaving.current &&
        startedRoutingVersion === routingVersion.current
      ) {
        routingRef.current = d.queryRouting;
        setQueryRouting(d.queryRouting);
      }
      if (currentRead) {
        setLoadError("");
        setDataReady(true);
      }
    } catch (e) {
      if (startedAuthVersion === authVersion.current && accountReads.current.canApply(accountTicket))
        setLoadError((e as Error).message);
    }
  }, [send]);
  // Ordinary writes use plain send; every external query captures its own route.
  const sendQuery = useCallback<Send>(
    async (path, method = "GET", data) => {
      if (
        method !== "POST" ||
        !(path === "query/test" || /^accounts\/[^/]+\/(sync|test)$/.test(path))
      )
        return send(path, method, data);
      const status = routingRef.current;
      if (!status || routingSaving.current)
        throw new Error("查询线路尚未就绪，请稍后重试");
      const payload =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : {};
      const mode = payload.routeMode ?? status.mode;
      queriesRunning.current++;
      if (path === "query/test") setDraftTesting(true);
      try {
        return await send(path, method, { ...payload, routeMode: mode });
      } finally {
        queriesRunning.current--;
        if (path === "query/test") setDraftTesting(false);
      }
    },
    [send],
  );
  // Keep the route stable for the entire operation and merge canonical balance
  // updates even if the initiating panel has since closed or changed accounts.
  const sendCheckin = useCallback<Send>(async <T = unknown,>(path: string, method = "GET", data?: unknown): Promise<T> => {
    if (method !== "POST") return send<T>(path, method, data);
    if (!routingRef.current || routingSaving.current)
      throw new Error("查询线路尚未就绪，请稍后重试");
    const session = authVersion.current;
    const finishWrite = accountReads.current.beginWrite();
    queriesRunning.current++; checkinRequests.current++; setCheckinBusy(true);
    try {
      const response = await send<T>(path, method, data);
      if (session === authVersion.current && (path === "checkin/batch" || /^accounts\/[^/]+\/checkin$/.test(path))) {
        const body = response as CheckinResult | { results: CheckinResult[] };
        const results = "results" in body ? body.results : [body];
        const updates = results.flatMap((result) => result.account ? [result.account] : []);
        if (updates.length) setAccounts((old) => mergeLatestAccounts(old, updates));
      }
      return response;
    } finally {
      finishWrite(); queriesRunning.current--; checkinRequests.current--;
      setCheckinBusy(checkinRequests.current > 0);
    }
  }, [send]);
  const sendInvitation = useCallback<Send>(async <T = unknown,>(path: string, method = "GET", data?: unknown): Promise<T> => {
    if (method !== "POST" || !path.endsWith("/invitation/fetch")) return send<T>(path, method, data);
    const status = routingRef.current;
    if (!status || routingSaving.current) throw new Error("查询线路尚未就绪，请稍后重试");
    queriesRunning.current++; invitationRequests.current++; setInvitationBusy(true);
    const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
    try { return await send<T>(path, method, { ...payload, routeMode: status.mode }); }
    finally { queriesRunning.current--; invitationRequests.current--; setInvitationBusy(invitationRequests.current > 0); }
  }, [send]);
  async function updateQueryRoute(mode: QueryRouteMode) {
    if (
      !routingRef.current ||
      mode === routingRef.current.mode ||
      routingSaving.current ||
      queriesRunning.current ||
      batchRunning.current
    )
      return;
    routingSaving.current = true;
    routingVersion.current++;
    setRoutingBusy(true);
    try {
      const status = await send<QueryRoutingStatus>("query/routing", "POST", {
        mode,
      });
      routingRef.current = status;
      setQueryRouting(status);
      notify(
        `已切换${mode === "proxy" ? "代理" : "直连"}线路；下次点击查询时使用`,
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      routingVersion.current++;
      routingSaving.current = false;
      setRoutingBusy(false);
    }
  }
  useEffect(() => {
    if (auth !== "ready") {
      authVersion.current++;
      setCheckinOpen(false);
      setInvitationOpen(false);
      setCheckinScope(null);
      setDataReady(false);
      setLoadError("");
      colorVersion.current++;
      colorRef.current = { revision: 0, colors: [] };
      setGroupColors(colorRef.current);
      setColorEditingGroup(null);
      routingVersion.current++;
      routingRef.current = null;
      setQueryRouting(null);
      layoutVersion.current++;
      layoutRef.current = { revision: 0, positions: [] };
      setGroupLayout(layoutRef.current);
    }
  }, [auth]);
  useEffect(() => {
    let active = true;
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        setConfigured(d.configured);
        if (d.authenticated) {
          setCsrf(d.csrf);
          setSettings(d.settings);
          setAuth("ready");
        } else setAuth("login");
      })
      .catch(() => {
        if (active) {
          setAuth("login");
          setConfigured(false);
        }
      });
    if (matchMedia("(max-width: 760px)").matches) setView("list");
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (auth === "ready") void load();
  }, [auth, load]);
  useEffect(() => {
    let key = (e: KeyboardEvent) => {
      if (auth !== "ready") return;
      if (e.defaultPrevented) return;
      if (e.key === "Escape" && document.querySelector('[role="dialog"]'))
        return;
      if (e.key === "Escape" && document.querySelector('[role="listbox"][data-state="open"]'))
        return;
      if (e.key === "Escape" && filterPanel.current?.open) {
        filterPanel.current.open = false;
        filterPanel.current.querySelector("summary")?.focus();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandSearch("");
        setCommands((v) => !v);
      }
      if (
        e.key === "Escape" &&
        !formOpen &&
        !balanceOpen &&
        !deleteOpen &&
        !commands &&
        !renamingGroup
      )
        closeAccount();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [
    auth,
    formOpen,
    balanceOpen,
    deleteOpen,
    commands,
    renamingGroup,
    settings.motion,
    selected,
  ]);
  useEffect(() => {
    const dismiss = (e: PointerEvent) => {
      const panel = filterPanel.current;
      const target = e.target as Element;
      if (
        panel?.open &&
        !panel.contains(target) &&
        !target.closest('[role="listbox"],[data-radix-popper-content-wrapper]')
      )
        panel.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const filters = useMemo<SavedViewFilters>(
    () => ({
      search,
      group,
      currency,
      favorites,
      onlyLow,
      archive,
      recordAge,
      sort,
    }),
    [search, group, currency, favorites, onlyLow, archive, recordAge, sort],
  );
  const filtered = useMemo(
    () => filterAccounts(accounts, filters, freshnessNow),
    [accounts, filters, freshnessNow],
  );
  const matchingIds = useMemo(
    () => new Set(filtered.map((a) => a.id)),
    [filtered],
  );
  const scopeIds = useMemo(
    () =>
      new Set(
        accounts
          .filter(
            (a) => archive === "all" || a.archived === (archive === "archived"),
          )
          .map((a) => a.id),
      ),
    [accounts, archive],
  );
  const filtering = hasAccountFilters(filters);
  useEffect(() => {
    setBatchSelection((old) => retainVisibleSelection(old, matchingIds));
  }, [matchingIds]);
  useEffect(() => {
    if (auth !== "ready" || page !== "sites") {
      setBatchMode(false);
      setBatchSelection(new Set());
    }
    if (auth !== "ready") setCollapsedGroups(new Set());
  }, [auth, page]);
  const current = accounts.find((a) => a.id === selected) || null,
    groups = [...new Set(accounts.map((a) => a.group || "未分组"))].sort(),
    units = [...new Set(accounts.filter((a) => !a.archived).map(unitKey))],
    summary = totals(filtered),
    lowCount = filtered.filter(isLow).length;
  const activeSavedView = savedViews.find((item) => item.id === activeViewId) || null;
  useEffect(() => {
    if (!activeViewId) return;
    const active = savedViews.find((item) => item.id === activeViewId);
    if (!active || JSON.stringify(active.filters) !== JSON.stringify(filters))
      setActiveViewId(null);
  }, [activeViewId, savedViews, filters]);
  const markBusy = (id: string, value: boolean) =>
    setBusy((old) => {
      let next = new Set(old);
      value ? next.add(id) : next.delete(id);
      return next;
    });
  async function sync(id: string, quiet = false, mode?: QueryRouteMode) {
    markBusy(id, true);
    try {
      let a = await sendQuery<Account>(
        `accounts/${id}/sync`,
        "POST",
        mode ? { routeMode: mode } : undefined,
      );
      setAccounts((old) => old.map((x) => (x.id === id ? a : x)));
      if (!quiet) notify("余额已同步，历史快照已记录");
      return true;
    } catch (e) {
      if (!quiet) notify((e as Error).message);
      await load();
      return false;
    } finally {
      markBusy(id, false);
    }
  }
  async function moveSite(id: string, group: string, beforeId: string | null) {
    const account = accounts.find((a) => a.id === id);
    if (!account || moving || busy.size || batch)
      throw new Error("站点正在处理，请稍后重试移动");
    setMoving(true);
    try {
      const result = await send<{ accounts: Account[] }>(
        "accounts/move",
        "POST",
        { id, group, beforeId, expectedUpdatedAt: account.updatedAt },
      );
      const changes = new globalThis.Map(result.accounts.map((a) => [a.id, a]));
      setAccounts((old) =>
        old.map((a) => {
          const changed = changes.get(a.id);
          return changed &&
            Date.parse(changed.updatedAt) >= Date.parse(a.updatedAt)
            ? changed
            : a;
        }),
      );
      const movedAccount = changes.get(id);
      if (movedAccount) revealAccount(movedAccount);
      notify(account.group === group ? "组内顺序已保存" : `已移入「${group}」`);
    } catch (error) {
      notify((error as Error).message);
      await load();
      throw error;
    } finally {
      setMoving(false);
    }
  }
  async function moveGroup(
    name: string,
    position: { x: number; y: number } | null,
  ) {
    if (layoutSaving.current || colorSaving.current || moving || busy.size || batch)
      throw new Error("地图正在处理，请稍后移动分组");
    layoutSaving.current = true;
    layoutVersion.current++;
    setMoving(true);
    try {
      const next = await send<GroupLayout>("map/groups/move", "POST", {
        name,
        position,
        expectedRevision: layoutRef.current.revision,
      });
      layoutRef.current = next;
      setGroupLayout(next);
      notify(position ? `「${name}」位置已保存` : `「${name}」已恢复自动布局`);
    } catch (error) {
      notify((error as Error).message);
      // Release the stale-load guard before reading the canonical conflict winner.
      layoutSaving.current = false;
      layoutVersion.current++;
      await load();
      throw error;
    } finally {
      layoutVersion.current++;
      layoutSaving.current = false;
      setMoving(false);
    }
  }
  async function renameGroup(name: string, newName: string) {
    if (layoutSaving.current || colorSaving.current || moving || busy.size || batch)
      throw new Error("地图正在处理，请稍后改名");
    layoutSaving.current = true;
    layoutVersion.current++;
    colorVersion.current++;
    setMoving(true);
    try {
      const result = await send<{
        accounts: Account[];
        groupLayout: GroupLayout;
        groupColors: GroupColors;
      }>("map/groups/rename", "POST", {
        name,
        newName,
        expectedRevision: layoutRef.current.revision,
      });
      const changes = new globalThis.Map(result.accounts.map((a) => [a.id, a]));
      setAccounts((old) => old.map((a) => changes.get(a.id) || a));
      layoutRef.current = result.groupLayout;
      setGroupLayout(result.groupLayout);
      colorRef.current = result.groupColors;
      setGroupColors(result.groupColors);
      if (group === name) setGroup(newName);
      setCollapsedGroups((old) => {
        if (!old.has(name)) return old;
        const next = new Set(old);
        next.delete(name);
        next.add(newName);
        return next;
      });
      notify(
        name === newName
          ? "分组名称未改变"
          : `已改名为「${newName}」，${result.accounts.length} 个账号已更新`,
      );
    } catch (error) {
      layoutSaving.current = false;
      layoutVersion.current++;
      await load();
      throw error;
    } finally {
      layoutVersion.current++;
      colorVersion.current++;
      layoutSaving.current = false;
      setMoving(false);
    }
  }
  async function saveGroupColor(name: string, color: string | null, expectedRevision: number) {
    if (colorSaving.current || layoutSaving.current) throw new Error("分组正在保存，请稍后重试");
    colorSaving.current = true;
    colorVersion.current++;
    setColorBusy(true);
    let failed = false;
    try {
      const result = await send<GroupColors>("map/groups/color", "POST", { name, color, expectedRevision });
      colorRef.current = result;
      setGroupColors(result);
      notify(color === null ? `「${name}」已恢复默认颜色` : `「${name}」的颜色已保存`);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      colorVersion.current++;
      colorSaving.current = false;
      setColorBusy(false);
      // Recovery must not keep the dialog busy or silently acknowledge a newer revision.
      if (failed) void load();
    }
  }
  async function refreshAll() {
    if (
      moving ||
      batchRunning.current ||
      routingSaving.current ||
      !routingRef.current
    )
      return;
    const routeMode = routingRef.current.mode;
    let queue = filtered.filter(
      (a) =>
        a.provider !== "manual" &&
        a.hasCredential &&
        !a.archived &&
        !busy.has(a.id),
    );
    if (!queue.length) {
      notify("当前视图没有可查询账号，请先配置平台和查询凭据");
      return;
    }
    batchRunning.current = true;
    setBatch(true);
    let index = 0,
      success = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (index < queue.length) {
          let a = queue[index++];
          if (await sync(a.id, true, routeMode)) success++;
        }
      }),
    );
    batchRunning.current = false;
    setBatch(false);
    notify(`查询结束：${success} 个成功，${queue.length - success} 个失败`);
  }
  async function undo() {
    const action = undoController.begin();
    if (!action) return;
    const session = authVersion.current;
    try {
      const result = await send<{
        accounts: Account[];
        skipped: Array<{ id: string; field: string }>;
      }>("accounts/undo", "POST", { entries: action.entries });
      if (session !== authVersion.current) return;
      undoController.succeed(action.id);
      setAccounts((old) => mergeLatestAccounts(old, result.accounts));
      notify(
        result.skipped.length
          ? "撤销未执行：账号已有后续修改"
          : "已撤销",
      );
      if (result.skipped.length) void load();
    } catch (e) {
      if (session !== authVersion.current) return;
      const problem = e as Error & { status?: number };
      const retryable = ![400, 401, 403, 404].includes(problem.status ?? 0);
      undoController.fail(action.id, problem.message, retryable);
      if (!retryable) notify(problem.message);
    }
  }
  async function patch(
    a: Account,
    changes: { favorite: boolean } | { archived: boolean },
  ) {
    const session = authVersion.current;
    try {
      let updated: Account;
      if ("favorite" in changes)
        updated = await send<Account>(`accounts/${a.id}/favorite`, "POST", {
          favorite: changes.favorite,
          expectedUpdatedAt: a.updatedAt,
        });
      else if ("archived" in changes) {
        const response = await send<{ accounts: Account[] }>(
          "accounts/batch",
          "POST",
          {
            ids: [a.id],
            expectedUpdatedAt: { [a.id]: a.updatedAt },
            operation: { kind: "archive", archived: changes.archived },
          },
        );
        updated = response.accounts[0];
      } else return;
      if (session !== authVersion.current) return;
      setAccounts((old) =>
        old.map((x) =>
          x.id === a.id &&
          Date.parse(updated.updatedAt) >= Date.parse(x.updatedAt)
            ? updated
            : x,
        ),
      );
      const restore = "favorite" in changes
        ? { favorite: a.favorite }
        : { archived: a.archived };
      const entry = makeUndoEntry(a.id, updated.updatedAt, restore);
      if (entry) {
        offerUndo(
          "favorite" in changes
            ? changes.favorite ? "已加入收藏" : "已取消收藏"
            : changes.archived ? "已归档账号" : "已取消归档",
          [entry],
        );
      }
    } catch (e) {
      if (session !== authVersion.current) return;
      notify((e as Error).message);
      if ((e as Error & { status?: number }).status === 409) void load();
    }
  }
  function add() {
    setEdit(null);
    setFormOpen(true);
  }
  const selectAccount = useCallback(
    (id: string) => {
      if (detailTimer.current) clearTimeout(detailTimer.current);
      setDetailClosing(false);
      setSelected(id);
      setPage("sites");
      const a = accounts.find((a) => a.id === id);
      if (a)
        setCollapsedGroups((old) => {
          const name = a.group || "未分组";
          if (!old.has(name)) return old;
          const next = new Set(old);
          next.delete(name);
          return next;
        });
    },
    [accounts],
  );
  function revealAccount(a: Account) {
    const f = revealAccountFilters(a, {
      search,
      group,
      currency,
      favorites,
      onlyLow,
      archive,
    });
    setSearch(f.search);
    setGroup(f.group);
    setCurrency(f.currency);
    setFavorites(f.favorites);
    setOnlyLow(f.onlyLow);
    setArchive(f.archive as SavedViewFilters["archive"]);
    setRecordAge(recordAge === "any" || isOlderThanSevenDays(a, freshnessNow) ? recordAge : "any");
    if (detailTimer.current) clearTimeout(detailTimer.current);
    setDetailClosing(false);
    setSelected(a.id);
    setPage("sites");
    setCollapsedGroups((old) => {
      if (!old.has(a.group)) return old;
      const next = new Set(old);
      next.delete(a.group);
      return next;
    });
    setFocusVersion((v) => v + 1);
  }
  useEffect(() => {
    if (page !== "sites" || view !== "list" || !selected || !focusVersion)
      return;
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector(
        `[data-site-row="${CSS.escape(selected)}"]`,
      );
      row?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusVersion, page, view, selected]);
  function toggleGroup(name: string) {
    setCollapsedGroups((old) => {
      const next = new Set(old);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }
  function closeAccount() {
    if (!selected) return;
    if (detailTimer.current) clearTimeout(detailTimer.current);
    if (
      !settings.motion ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setSelected(null);
      setDetailClosing(false);
      return;
    }
    setDetailClosing(true);
    detailTimer.current = setTimeout(() => {
      setSelected(null);
      setDetailClosing(false);
      detailTimer.current = null;
    }, 180);
  }
  function applySavedView(saved: SavedView) {
    setSearch(saved.filters.search);
    setGroup(saved.filters.group);
    setCurrency(saved.filters.currency);
    setFavorites(saved.filters.favorites);
    setOnlyLow(saved.filters.onlyLow);
    setArchive(saved.filters.archive);
    setRecordAge(saved.filters.recordAge);
    setSort(saved.filters.sort);
    setActiveViewId(saved.id);
    setSelected(null);
    setPage("sites");
    notify(`已切换视图「${saved.name}」`);
  }
  function openSaveView() {
    setViewName(activeSavedView?.name || "");
    setSaveViewOpen(true);
  }
  async function saveCurrentView(id: string | undefined, name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      notify("请输入视图名称");
      return;
    }
    try {
      const saved = await send<SavedView>("views", "PUT", {
        ...(id ? { id } : {}),
        name: trimmed,
        filters,
      });
      setSavedViews((old) =>
        old.some((item) => item.id === saved.id)
          ? old.map((item) => (item.id === saved.id ? saved : item))
          : [...old, saved],
      );
      setActiveViewId(saved.id);
      setSaveViewOpen(false);
      setViewName("");
      notify(id ? `已覆盖视图「${saved.name}」` : `已保存视图「${saved.name}」`);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function overwriteSavedView() {
    if (!activeSavedView) return;
    await saveCurrentView(activeSavedView.id, activeSavedView.name);
  }
  async function removeSavedView() {
    if (!activeSavedView) return;
    try {
      const result = await send<{ views: SavedView[] }>(
        `views/${activeSavedView.id}`,
        "DELETE",
      );
      setSavedViews(result.views);
      setActiveViewId(null);
      notify(`已删除视图「${activeSavedView.name}」`);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function updateSettings(next: Settings) {
    if (settingsSaving.current) return;
    settingsVersion.current++;
    settingsSaving.current = true;
    setSettingsBusy(true);
    const previous = settings;
    setSettings(next);
    try {
      await send("settings", "PATCH", next);
    } catch (e) {
      setSettings(previous);
      notify((e as Error).message);
    } finally {
      settingsVersion.current++;
      settingsSaving.current = false;
      setSettingsBusy(false);
    }
  }
  async function logout() {
    try {
      await send("auth/logout", "POST");
      setAuth("login");
      setAccounts([]);
      setSelected(null);
      setCsrf("");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify("API 地址已复制");
    } catch {
      notify("复制失败，请在安全 HTTPS 或本机页面使用复制功能");
    }
  }
  if (auth === "loading" || (auth === "ready" && !dataReady && !loadError))
    return <WorkspaceLoading brand={<Brand />} />;
  if (auth === "login")
    return (
      <>
        <Login
          configured={configured}
          onLogin={(c, s) => {
            setCsrf(c);
            setSettings(s);
            setAuth("ready");
          }}
        />
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </>
    );
  return (
    <div className={"app-shell" + (page === "sites" ? " is-sites" : "")}>
      <header className="app-header">
        <Brand />
        <nav aria-label="主要导航">
          <button
            className={page === "sites" ? "active" : ""}
            onClick={() => setPage("sites")}
          >
            <Map size={16} />
            站点
          </button>
          <button
            className={page === "history" ? "active" : ""}
            onClick={() => setPage("history")}
          >
            <History size={16} />
            余额记录
          </button>
          <button
            className={page === "settings" ? "active" : ""}
            onClick={() => setPage("settings")}
          >
            <SettingsIcon size={16} />
            设置
          </button>
        </nav>
        <div className="header-actions">
          <button
            className="icon-button theme-toggle"
            aria-label={resolvedTheme === "dark" ? "切换到浅色" : "切换到深色"}
            title={resolvedTheme === "dark" ? "切换到浅色" : "切换到深色"}
            disabled={settingsBusy}
            onClick={() =>
              void updateSettings({
                ...settings,
                theme: resolvedTheme === "dark" ? "light" : "dark",
              })
            }
          >
            <span className="theme-toggle-glyph" key={resolvedTheme}>
              {resolvedTheme === "dark" ? (
                <Sun size={18} />
              ) : (
                <Moon size={18} />
              )}
            </span>
          </button>
          <button
            className="icon-button command-trigger"
            onClick={() => {
              setCommandSearch("");
              setCommands(true);
            }}
            aria-label="打开命令面板"
          >
            <Command size={17} />
            <kbd> K</kbd>
          </button>
          <button
            className="icon-button"
            onClick={logout}
            aria-label="退出登录"
          >
            <LogOut size={17} />
          </button>
          <button className="button primary add-button" onClick={add}>
            <Plus size={16} />
            <span>添加站点</span>
          </button>
        </div>
      </header>
      {(toast || undoAction) && !noticesBlocked && <div className={"toast-stack" + (current && page === "sites" ? " with-detail" : "")}>
      {toast && (
        <div
          className={
            "toast" + (current && page === "sites" ? " with-detail" : "")
          }
          role="status"
        >
          <Check size={16} />
          {toast}
          <button
            aria-label="关闭提示"
            onClick={() => {
              setToast("");
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {undoAction && <UndoNotice action={undoAction} controller={undoController} onUndo={() => void undo()} />}
      </div>}
      {page === "sites" ? (
        <main className="sites-page">
          <div className="workspace-heading">
            <div className="workspace-heading-copy">
              <span className="workspace-eyebrow"><span className="eyebrow-dot" /> LOCAL-FIRST / LIVE MAP</span>
              <h1>站点群岛</h1>
              <p>
                {filtered.length} 个账号
                {lowCount > 0 && (
                  <button
                    className="attention-link"
                    onClick={() => setOnlyLow((v) => !v)}
                  >
                    <span /> {lowCount} 个需要关注
                  </button>
                )}
                <span className="heading-note">每一次更新，都由你决定。</span>
              </p>
            </div>
            <div className="balance-summary">
              {Object.entries(summary)
                .slice(0, 3)
                .map(([u, v]) => (
                  <div key={u}>
                    <strong>{displayAmount(v, u.split("::")[0])}</strong>
                    <span>
                      {u.includes("::")
                        ? u.split("::")[0] +
                          " · " +
                          new URL(u.split("::")[1]).hostname
                        : u}{" "}
                      · 已记录余额
                    </span>
                  </div>
                ))}
              {Object.keys(summary).length === 0 && (
                <div>
                  <strong className="summary-empty">—</strong>
                  <span>等待第一笔余额记录</span>
                </div>
              )}
            </div>
          </div>
          <div className="workspace-toolbar" data-toolbar="floating">
            <div className="search-box">
              <Search size={16} />
              <input
                ref={searchRef}
                aria-label="搜索站点"
                placeholder="搜索站点、账号或标签"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  className="icon-button"
                  aria-label="清除搜索"
                  onClick={() => setSearch("")}
                >
                  <X size={14} />
                </button>
              )}
              <kbd>⌘ K</kbd>
            </div>
            <div className="toolbar-filters">
              <AtlasSelect
                label="筛选分组"
                value={group}
                onValueChange={setGroup}
                options={[
                  { value: "all", label: "所有分组" },
                  ...groups.map((g) => ({ value: g, label: g })),
                ]}
              />
              <button
                className="icon-button toolbar-action"
                aria-label="分组颜色"
                title="分组颜色"
                disabled={!groups.length || moving || colorBusy || busy.size > 0 || batch}
                onClick={() => {
                  setToast("");
                  setColorEditingGroup(
                    group !== "all" ? group : current ? current.group || "未分组" : groups[0],
                  );
                }}
              >
                <Palette size={17} /><span>配色</span>
              </button>
              <AtlasSelect
                label="筛选币种"
                value={currency}
                onValueChange={setCurrency}
                options={[
                  { value: "all", label: "所有单位" },
                  ...units.map((u) => ({
                    value: u,
                    label: u.includes("::")
                      ? u.split("::")[0] +
                        " · " +
                        new URL(u.split("::")[1]).hostname
                      : u,
                  })),
                ]}
              />
              <button
                className={
                  "icon-button toolbar-action favorite-filter " + (favorites ? "selected" : "")
                }
                aria-label="只看收藏"
                title="只显示已收藏的账号"
                aria-pressed={favorites}
                onClick={() => setFavorites((v) => !v)}
              >
                <Star size={17} fill={favorites ? "currentColor" : "none"} /><span>收藏</span>
              </button>
              <details ref={filterPanel} className="filter-menu">
                <summary aria-label="更多筛选" title="筛选归档、记录时间、排序和低余额" className="toolbar-action">
                  <SlidersHorizontal size={17} /><span>筛选</span>
                </summary>
                <div>
                  <label>
                    档案范围
                    <AtlasSelect
                      label="档案范围"
                      value={archive}
                      onValueChange={(value) => setArchive(value as SavedViewFilters["archive"])}
                      options={[
                        { value: "active", label: "使用中的账号" },
                        { value: "archived", label: "已归档账号" },
                        { value: "all", label: "所有档案" },
                      ]}
                    />
                  </label>
                  <label>
                    余额记录
                    <AtlasSelect
                      label="记录时间"
                      value={recordAge}
                      onValueChange={(value) =>
                        setRecordAge(value as SavedViewFilters["recordAge"])
                      }
                      options={[
                        { value: "any", label: "不限记录时间" },
                        { value: "older-than-7d", label: "超过七天未记录" },
                      ]}
                    />
                  </label>
                  <label>
                    排序
                    <AtlasSelect
                      label="排序"
                      value={sort}
                      onValueChange={(value) => setSort(value as SavedViewFilters["sort"])}
                      options={[
                        { value: "name", label: "名称" },
                        { value: "recent", label: "最近记录" },
                        { value: "favorite", label: "收藏优先" },
                      ]}
                    />
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={onlyLow}
                      onChange={(e) => setOnlyLow(e.target.checked)}
                    />
                    只看低余额
                  </label>
                  <button type="button" className="button" disabled={!groups.length || moving || colorBusy || busy.size > 0 || batch}
                    onClick={() => {
                      if (filterPanel.current) filterPanel.current.open = false;
                      setRenamingGroup(group !== "all" ? group : current ? current.group || "未分组" : groups[0]);
                    }}>
                    <PenLine size={15} />分组改名
                  </button>
                </div>
              </details>
            </div>
            <div className="saved-view-tools" data-testid="saved-view-controls">
              <AtlasSelect
                label="已保存视图"
                value={activeViewId || "current"}
                onValueChange={(value) => {
                  if (value === "current") {
                    setActiveViewId(null);
                    return;
                  }
                  const saved = savedViews.find((item) => item.id === value);
                  if (saved) applySavedView(saved);
                }}
                options={[
                  { value: "current", label: "当前筛选", description: savedViews.length ? "正在使用的条件，可另存为视图" : "尚未保存视图，点击旁边的「保存视图」创建" },
                  ...savedViews.map((saved) => ({
                    value: saved.id,
                    label: saved.name,
                  })),
                ]}
              />
              <button
                className="icon-button toolbar-action"
                aria-label="保存当前视图"
                title="把当前搜索和筛选保存为常用视图"
                onClick={openSaveView}
              >
                <Bookmark size={16} /><span>保存视图</span>
              </button>
              {activeSavedView && (
                <>
                  <button
                    className="button compact-button"
                    onClick={() => void overwriteSavedView()}
                  >
                    覆盖
                  </button>
                  <button
                    className="icon-button danger-icon-button"
                    aria-label={`删除视图 ${activeSavedView.name}`}
                    title="删除保存视图"
                    onClick={() => void removeSavedView()}
                  >
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </div>
            <div className="query-tools">
              <div
                className="view-switch"
                data-view={view}
                role="group"
                aria-label="视图"
              >
                <button
                  aria-label="地图视图"
                  aria-pressed={view === "map"}
                  className={view === "map" ? "active" : ""}
                  onClick={() => setView("map")}
                >
                  <Map size={15} />
                </button>
                <button
                  aria-label="列表视图"
                  aria-pressed={view === "list"}
                  className={view === "list" ? "active" : ""}
                  onClick={() => setView("list")}
                >
                  <LayoutList size={15} />
                </button>
              </div>
              <QueryRouteSwitch
                status={queryRouting}
                saving={routingBusy}
                disabled={routingBusy || batch || busy.size > 0 || draftTesting || checkinBusy}
                onChange={(mode) => void updateQueryRoute(mode)}
              />
              <button
                className="button refresh-button"
                onClick={refreshAll}
                disabled={
                  batch ||
                  routingBusy ||
                  !queryRouting ||
                  !filtered.some(
                    (a) =>
                      a.provider !== "manual" && a.hasCredential && !a.archived,
                  )
                }
              >
                <RefreshCw size={15} className={batch ? "spin" : ""} />
                <span>{batch ? "查询中" : "刷新余额"}</span>
              </button>
              <button type="button" className="button" disabled={checkinBusy || batch || !filtered.length}
                onClick={() => {
                  const selectedScope = batchSelection.size > 0;
                  setCheckinScope({
                    accounts: (selectedScope ? filtered.filter((account) => batchSelection.has(account.id)) : filtered).map((account) => ({ ...account })),
                    scope: selectedScope ? "selected" : "filtered",
                  });
                }}><CalendarCheck size={15} /><span>批量签到</span></button>
            </div>
          </div>
          {loadError && (
            <p className="form-error" role="alert">
              {loadError} <button onClick={load}>重新读取</button>
            </p>
          )}
          <div className={"workspace-body " + (current ? "has-detail" : "")}>
            {!dataReady && loadError ? (
              <div className="empty-state"><AlertCircle size={28} /><h2>工作台暂时无法读取</h2><p>账号没有被删除，请重试读取。</p><button className="button" onClick={load}>重新读取工作台</button></div>
            ) : accounts.length === 0 ? (
              <div className="empty-state first-island">
                <div className="empty-island">
                  <Compass size={38} strokeWidth={1} />
                </div>
                <h2>你的第一片群岛，还未落笔</h2>
                <p>
                  添加一个站点，记录余额和入口。
                  <br />
                  其他站点，慢慢收拢进来。
                </p>
                <button className="button primary" onClick={add}>
                  <Plus size={16} />
                  添加第一个站点
                </button>
                <span className="empty-footnote">
                  未知余额会保持“未记录”，不会自动变成零。
                </span>
              </div>
            ) : (
                view === "list" ? filtered.length === 0 : scopeIds.size === 0
              ) ? (
              <div className="empty-state">
                <Search size={28} />
                <h2>这片视野里，还没有站点</h2>
                <p>试试更短的关键词，或清除筛选。</p>
                <button
                  className="button"
                  onClick={() => {
                    setSearch("");
                    setGroup("all");
                    setCurrency("all");
                    setFavorites(false);
                    setOnlyLow(false);
                    setArchive("active");
                    setRecordAge("any");
                  }}
                >
                  清除筛选
                </button>
              </div>
            ) : view === "map" ? (
              <AtlasMap
                accounts={accounts}
                matchingIds={matchingIds}
                scopeIds={scopeIds}
                filtering={filtering}
                collapsedGroups={collapsedGroups}
                onToggleGroup={toggleGroup}
                selected={selected}
                focusVersion={focusVersion}
                onSelect={selectAccount}
                motion={settings.motion}
                freshnessNow={freshnessNow}
                background={settings.mapBackground || "dots"}
                backgroundOpacity={settings.mapOpacity ?? 100}
                density={settings.mapDensity || "standard"}
                inkColor={settings.inkColor ?? null}
                inkOpacity={settings.inkOpacity ?? 100}
                onBackgroundChange={(background) =>
                  updateSettings({ ...settings, mapBackground: background })
                }
                appearanceBusy={settingsBusy}
                onMove={moveSite}
                moveDisabled={moving || busy.size > 0 || batch}
                groupPositions={groupLayout.positions}
                groupColors={groupColors.colors}
                onMoveGroup={moveGroup}
                onRenameGroup={setRenamingGroup}
              />
            ) : (
              <div
                className={"site-list " + (batchMode ? "is-batch" : "")}
                data-testid="site-list"
              >
                <BatchManagement
                  accounts={filtered}
                  groups={groups}
                  enabled={batchMode}
                  onEnabledChange={setBatchMode}
                  selection={batchSelection}
                  onSelectionChange={setBatchSelection}
                  send={send}
                  onDialogOpenChange={setBatchDialogOpen}
                  onConflict={() => void load()}
                  notify={notify}
                  onSaved={(updated, undo) => {
                    setAccounts((old) => mergeLatestAccounts(old, updated));
                    if (undo?.entries.length) offerUndo(undo.message, undo.entries);
                    else if (undo) notify(undo.message);
                  }}
                />
                <div className="list-header">
                  {batchMode && (
                    <SelectionBox
                      label="选择当前结果"
                      checked={
                        filtered.length > 0 &&
                        filtered
                          .slice(0, 500)
                          .every((a) => batchSelection.has(a.id))
                      }
                      mixed={
                        batchSelection.size > 0 &&
                        !filtered
                          .slice(0, 500)
                          .every((a) => batchSelection.has(a.id))
                      }
                      onChange={(value) =>
                        setBatchSelection(
                          value
                            ? new Set(filtered.slice(0, 500).map((a) => a.id))
                            : new Set(),
                        )
                      }
                    />
                  )}
                  <span className="list-identity-head">站点账号</span>
                  <span className="list-group-head">分组</span>
                  <span className="list-balance-head">已记录余额</span>
                  <span className="list-query-head">最近查询</span>
                  <span className="list-action-head" />
                </div>
                {filtered.map((a) => (
                  <div
                    key={a.id}
                    data-site-row={a.id}
                    className={
                      "site-row " + (selected === a.id ? "is-selected" : "")
                    }
                  >
                    {batchMode && (
                      <SelectionBox
                        label={`选择 ${a.name} ${a.alias}`}
                        checked={batchSelection.has(a.id)}
                        disabled={
                          !batchSelection.has(a.id) &&
                          batchSelection.size >= 500
                        }
                        onChange={(value) =>
                          setBatchSelection((old) => {
                            const next = new Set(old);
                            value ? next.add(a.id) : next.delete(a.id);
                            return next;
                          })
                        }
                      />
                    )}
                    <button
                      className="site-identity"
                      onClick={() => selectAccount(a.id)}
                    >
                      <span
                        className={"site-avatar group-color-" + groupColorIndex(a.group) + (isLow(a) ? " has-low-balance" : "")}
                        style={groupColorStyle(a.group, groupColors.colors)}
                      >
                        {Array.from(a.name)[0]}
                      </span>
                      <span>
                        <strong>
                          {a.name}
                          {a.favorite && <Star size={12} fill="currentColor" />}
                        </strong>
                        <small>{a.alias || new URL(a.siteUrl).hostname}</small>
                      </span>
                    </button>
                    <span className="list-group">{a.group}</span>
                    <button
                      className={"list-amount " + (isLow(a) ? "low" : "")}
                      aria-label={`${a.name} ${a.alias}，${displayAmount(a.balance, a.balanceUnit)} ${a.balanceUnit}，${balanceFreshness(a, freshnessNow).accessibleLabel}`}
                      onClick={() => selectAccount(a.id)}
                    >
                      {a.lastSyncStatus === "error" && a.balance !== null && (
                        <span className="balance-caption">上次余额</span>
                      )}
                      <strong>{displayAmount(a.balance, a.balanceUnit)}</strong>
                      <small>{a.balanceUnit}</small>
                      <BalanceFreshness account={a} now={freshnessNow} />
                    </button>
                    <span className="balance-query-cell">
                      <BalanceFreshness
                        account={a}
                        now={freshnessNow}
                        section="query"
                      />
                    </span>
                    <button
                      className="icon-button"
                      aria-label={`查看 ${a.name}`}
                      onClick={() => selectAccount(a.id)}
                    >
                      <ArrowUpRight size={17} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {current && (
              <aside
                key={current.id}
                className="account-detail"
                data-state={detailClosing ? "closing" : "open"}
                aria-label="当前账号详情"
              >
                <div className="detail-top">
                  <span>当前账号</span>
                  <button
                    className="icon-button"
                    aria-label="关闭账号详情"
                    onClick={closeAccount}
                  >
                    <X size={17} />
                  </button>
                </div>
                <div className="detail-identity">
                  <span className={"site-avatar group-color-" + groupColorIndex(current.group)} style={groupColorStyle(current.group, groupColors.colors)}>
                    {Array.from(current.name)[0]}
                  </span>
                  <div>
                    <h2>{current.name}</h2>
                    {current.alias && <p>{current.alias}</p>}
                  </div>
                  <button
                    className={
                      "icon-button " + (current.favorite ? "selected" : "")
                    }
                    aria-label={current.favorite ? "取消收藏" : "收藏账号"}
                    onClick={() =>
                      patch(current, { favorite: !current.favorite })
                    }
                  >
                    <Star
                      size={16}
                      fill={current.favorite ? "currentColor" : "none"}
                    />
                  </button>
                </div>
                <div
                  className={"detail-balance " + (isLow(current) ? "low" : "")}
                >
                  <span className="balance-caption">
                    {balanceFreshness(current, freshnessNow).amountLabel}
                  </span>
                  <strong key={current.lastSnapshotAt}>
                    {displayAmount(current.balance, current.balanceUnit)}
                  </strong>
                  <span>{current.balanceUnit}</span>
                  <BalanceFreshness
                    account={current}
                    now={freshnessNow}
                    section="record"
                    detailed
                  />
                </div>
                {isLow(current) && (
                  <p className="low-warning">
                    <AlertCircle size={14} />
                    低于提醒阈值{" "}
                    {displayAmount(current.lowThreshold, current.unit)}
                  </p>
                )}
                <dl className="detail-meta">
                  <div>
                    <dt>网站</dt>
                    <dd>
                      <a
                        href={current.siteUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {new URL(current.siteUrl).hostname}
                        <ExternalLink size={12} />
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt>分组</dt>
                    <dd>{current.group}</dd>
                  </div>
                  <div>
                    <dt>查询平台</dt>
                    <dd>{platformOf(current.provider).label}</dd>
                  </div>
                  <div>
                    <dt>最近查询</dt>
                    <dd>
                      {busy.has(current.id) ? (
                        "查询中…"
                      ) : (
                        <BalanceFreshness
                          account={current}
                          now={freshnessNow}
                          section="query"
                          detailed
                        />
                      )}
                    </dd>
                  </div>
                </dl>
                {current.lastSyncError && (
                  <p className="query-error">
                    <AlertCircle size={14} />
                    {current.lastSyncError}
                  </p>
                )}
                {(current.provider === "newapi" ||
                  current.provider === "newapi-token") &&
                  !current.quotaPerUnit && (
                    <p className="hint">
                      换算尚未确认：接口余额将以原始配额记录。
                    </p>
                  )}
                {current.tags.length > 0 && (
                  <div className="tag-list">
                    {current.tags.map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                  </div>
                )}
                {current.notes && (
                  <p className="account-notes">{current.notes}</p>
                )}
                <div className="detail-actions">
                  <a
                    className="button primary"
                    href={current.consoleUrl || current.siteUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开控制台
                    <ArrowUpRight size={15} />
                  </a>
                  <button
                    className="button"
                    disabled={busy.has(current.id)}
                    onClick={() => setBalanceOpen(true)}
                  >
                    <PenLine size={15} />
                    记录余额
                  </button>
                  {current.provider !== "manual" && (
                    <button
                      className="button"
                      disabled={
                        busy.has(current.id) ||
                        current.archived ||
                        routingBusy ||
                        !queryRouting
                      }
                      onClick={() => sync(current.id)}
                    >
                      <RefreshCw
                        size={15}
                        className={busy.has(current.id) ? "spin" : ""}
                      />
                      {busy.has(current.id) ? "查询中…" : "刷新余额"}
                    </button>
                  )}
                  {current.apiUrl && (
                    <button
                      className="button text-button"
                      onClick={() => copy(current.apiUrl)}
                    >
                      <Copy size={14} />
                      复制 API 地址
                    </button>
                  )}
                  {current.provider === "newapi" && (
                    <button className="button" onClick={() => setModelOpen(true)}>
                      <Activity size={15} />
                      模型表现
                    </button>
                  )}
                  {current.provider === "newapi" && (
                    <button type="button" className="button" onClick={() => setCheckinOpen(true)}>
                      <CalendarCheck size={15} />签到与月历
                    </button>
                  )}
                  {current.provider === "newapi" && (
                    <button type="button" className="button" onClick={() => setInvitationOpen(true)}>
                      <ExternalLink size={15} />邀请链接
                    </button>
                  )}
                  <div className="detail-link-row">
                    {current.rechargeUrl && (
                      <a
                        href={current.rechargeUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        充值入口
                        <ArrowUpRight size={13} />
                      </a>
                    )}
                    {current.docsUrl && (
                      <a
                        href={current.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        文档
                        <ArrowUpRight size={13} />
                      </a>
                    )}
                  </div>
                </div>
                <div className="detail-secondary">
                  <button
                    onClick={() => {
                      setEdit(current);
                      setFormOpen(true);
                    }}
                    disabled={busy.has(current.id)}
                  >
                    编辑档案
                  </button>
                  {current.provider !== "manual" && (
                    <button
                      disabled={
                        busy.has(current.id) || routingBusy || !queryRouting
                      }
                      onClick={async () => {
                        markBusy(current.id, true);
                        try {
                          let d = await sendQuery<{ message: string }>(
                            `accounts/${current.id}/test`,
                            "POST",
                          );
                          notify(d.message);
                        } catch (e) {
                          notify((e as Error).message);
                        } finally {
                          await load();
                          markBusy(current.id, false);
                        }
                      }}
                    >
                      测试连接
                    </button>
                  )}
                  <details>
                    <summary aria-label="更多账号操作">
                      <MoreHorizontal size={17} />
                    </summary>
                    <div>
                      <button
                        disabled={busy.has(current.id)}
                        onClick={() => {
                          patch(current, { archived: !current.archived });
                          setSelected(null);
                        }}
                      >
                        <Archive size={14} />
                        {current.archived ? "取消归档" : "归档账号"}
                      </button>
                      <button
                        className="danger"
                        disabled={busy.has(current.id)}
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2 size={14} />
                        删除账号
                      </button>
                    </div>
                  </details>
                </div>
                {(current.provider !== "manual" ||
                  current.lastQueryDiagnostic) && (
                  <QueryDiagnosticPanel
                    key={current.id}
                    diagnostic={current.lastQueryDiagnostic}
                    busy={busy.has(current.id)}
                  />
                )}
                <p className="detail-footnote">
                  记录时间不是实时余额。只在点击时查询，不监测服务可用率。
                </p>
                {current.provider !== "newapi" && (
                  <p className="detail-footnote">模型表现目前支持 New API 账户管理模板。</p>
                )}
              </aside>
            )}
          </div>
          <footer className="workspace-footer">
            <span>
              <span className="quiet-dot" />
              私有记录，留在你的部署中
            </span>
            <span>不用急，按自己的节奏。</span>
          </footer>
        </main>
      ) : page === "history" ? (
        <HistoryPage accounts={accounts} send={send} />
      ) : (
        <SettingsPage
          settings={settings}
          onSettings={updateSettings}
          appearanceBusy={settingsBusy}
          queryRouting={queryRouting}
          routingBusy={routingBusy}
          queryBusy={batch || busy.size > 0 || draftTesting || checkinBusy || invitationBusy}
          onQueryRoute={(mode) => void updateQueryRoute(mode)}
          send={send}
          onImported={load}
          onLogout={() => {
            setAuth("login");
            setCsrf("");
            setAccounts([]);
          }}
          notify={notify}
        />
      )}
      {modelOpen && current && (
        <ModelInsightPanel
          key={current.id}
          account={current}
          send={send}
          routeMode={queryRouting?.mode ?? null}
          routingBusy={routingBusy}
          onClose={() => setModelOpen(false)}
        />
      )}
      {checkinOpen && current && (
        <CheckinPanel key={current.id} account={current} send={sendCheckin}
          routeMode={queryRouting?.mode ?? null} routingBusy={routingBusy}
          onClose={() => setCheckinOpen(false)} />
      )}
      {checkinScope && (
        <CheckinBatchPanel accounts={checkinScope.accounts} scope={checkinScope.scope} send={sendCheckin}
          routeMode={queryRouting?.mode ?? null} routingBusy={routingBusy}
          onClose={() => setCheckinScope(null)} />
      )}
      {formOpen && (
        <AccountForm
          key={edit?.id || "new"}
          account={edit}
          groups={groups}
          open
          onClose={() => setFormOpen(false)}
          onSaved={(saved) => {
            setAccounts((old) =>
              old.some((a) => a.id === saved.id)
                ? old.map((a) => (a.id === saved.id ? saved : a))
                : [...old, saved],
            );
            revealAccount(saved);
            notify(edit ? "站点档案已更新" : "站点已添加");
          }}
          send={sendQuery}
        />
      )}
      {renamingGroup !== null && (
        <GroupRename
          name={renamingGroup}
          groups={groups}
          count={(name) => accounts.filter((a) => (a.group || "未分组") === name).length}
          onClose={() => setRenamingGroup(null)}
          onSave={renameGroup}
        />
      )}
      {invitationOpen && current && (
        <InvitationPanel key={current.id} account={current} open send={sendInvitation}
          routeMode={queryRouting?.mode ?? null} routingBusy={routingBusy} onClose={() => setInvitationOpen(false)} />
      )}
      {colorEditingGroup !== null && (
        <GroupColorEditor name={colorEditingGroup} groups={groups} model={groupColors} theme={resolvedTheme}
          count={(name) => accounts.filter((a) => (a.group || "未分组") === name).length}
          sampleName={(name) => accounts.find((a) => (a.group || "未分组") === name)?.name || "站点"}
          onClose={() => setColorEditingGroup(null)} onSave={saveGroupColor} />
      )}
      {balanceOpen && current && (
        <BalanceForm
          account={current}
          open
          onClose={() => setBalanceOpen(false)}
          onSaved={() => {
            void load();
            notify("余额已记录");
          }}
          send={send}
        />
      )}
      <Modal
        open={saveViewOpen}
        onClose={() => setSaveViewOpen(false)}
        title="保存常用视图"
        description="保存当前筛选组合；以后切换只筛选已有账号，不会触发查询。"
      >
        <label className="field">
          <span>视图名称</span>
          <input
            autoFocus
            value={viewName}
            maxLength={40}
            aria-label="视图名称"
            placeholder="例如：低余额且未归档"
            onChange={(event) => setViewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveCurrentView(undefined, viewName);
              }
            }}
          />
        </label>
        <p className="body-note">
          只保存筛选条件，不保存凭据、余额历史或查询结果。
        </p>
        <div className="modal-actions">
          <button className="button" onClick={() => setSaveViewOpen(false)}>
            取消
          </button>
          <button
            className="button primary"
            disabled={!viewName.trim()}
            onClick={() => void saveCurrentView(undefined, viewName)}
          >
            保存视图
          </button>
        </div>
      </Modal>      <Modal
        open={deleteOpen && !!current}
        onClose={() => setDeleteOpen(false)}
        title="删除这个账号？"
        description="删除站点档案及其全部余额历史，不能撤销。不会修改远端站点。"
      >
        <p className="body-note">
          {current?.name} {current?.alias}
        </p>
        <div className="modal-actions">
          <button className="button" onClick={() => setDeleteOpen(false)}>
            保留账号
          </button>
          <button
            className="button danger-button"
            onClick={async () => {
              if (!current) return;
              try {
                await send(`accounts/${current.id}`, "DELETE");
                setDeleteOpen(false);
                setSelected(null);
                await load();
                notify("账号与余额历史已删除");
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            确认删除
          </button>
        </div>
      </Modal>
      <Modal
        open={commands}
        onClose={() => setCommands(false)}
        title="去往你的站点"
        description="搜索名称、账号、标签；或直接选择操作。"
      >
        <div className="command-search">
          <Search size={17} />
          <input
            autoFocus
            placeholder="搜索站点或操作"
            aria-label="命令搜索"
            value={commandSearch}
            onChange={(e) => setCommandSearch(e.target.value)}
          />
        </div>
        <div className="command-results">
          {!commandSearch && (
            <>
              <button
                onClick={() => {
                  setCommands(false);
                  add();
                }}
              >
                <Plus size={16} />
                添加站点
              </button>
              <button
                onClick={() => {
                  setCommands(false);
                  setPage("sites");
                  setOnlyLow(true);
                }}
              >
                <AlertCircle size={16} />
                查看低余额账号
              </button>
              <button
                onClick={() => {
                  setCommands(false);
                  setPage("settings");
                }}
              >
                <SettingsIcon size={16} />
                外观与备份
              </button>
            </>
          )}
          {accounts
            .filter(
              (a) =>
                !a.archived &&
                [a.name, a.alias, ...a.tags]
                  .join(" ")
                  .toLowerCase()
                  .includes(commandSearch.toLowerCase()),
            )
            .slice(0, 12)
            .map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  setCommands(false);
                  setSearch("");
                  setGroup("all");
                  setCurrency("all");
                  setFavorites(false);
                  setOnlyLow(false);
                  setArchive("active");
                    setRecordAge("any");
                  selectAccount(a.id);
                }}
              >
                <span className={"site-avatar group-color-" + groupColorIndex(a.group)} style={groupColorStyle(a.group, groupColors.colors)}>{Array.from(a.name)[0]}</span>
                <span>
                  {a.name}
                  <small>{a.alias || a.group}</small>
                </span>
                <strong>{displayAmount(a.balance, a.balanceUnit)}</strong>
              </button>
            ))}
        </div>
      </Modal>
    </div>
  );
}

















