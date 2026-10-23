/**
 * genui larklink 客户端（web）：
 *  - 侧栏「Lark 绑定」面板（sidebarRightTabs + sidebar.right.pane.tab 槽）
 *  - 设置页「LarkLink 账号管理」（settings.section 槽：账户/授权状态总览 + 扫码登录）
 * 数据来自后端 /larklink/* 路由（同源 fetch）；仅无敏感操作（add/remove 仍限终端）。
 */
import React, { useEffect, useRef, useState } from "react";

export const inject = ["slots"];

const TAB_ID = "@timeryu/dsh-larklink/bindings";
const TAB_KIND = "larklink-bindings";
const TAB_TITLE = "Lark 绑定";
const BODY_SLOT = "sidebar.right.pane.tab";
const TITLE_SLOT = "sidebar.right.pane.tab.title";
const SETTINGS_SECTION_ID = "larklink";
const API_BASE = "/larklink";

interface BindingView {
  profile: string;
  brand: string;
  appId: string;
  userName?: string;
  openId?: string;
  /** 实时核验（live=1）时返回：refresh token 过期时刻（ISO）。 */
  refreshExpiresAt?: string;
  status: string;
  adopted: boolean;
}

interface PanelData {
  ok: boolean;
  bindings: BindingView[];
  pins: Array<{ token: string; profile: string }>;
  warnings?: string[];
}

const STATUS_COLOR: Record<string, string> = {
  ready: "#22c55e",
  needs_refresh: "#f59e0b",
  unauthorized: "#ef4444",
  incomplete: "#9ca3af",
};

function TabIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return React.createElement(
    "svg",
    { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
    React.createElement("path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }),
    React.createElement("path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }),
  );
}

function usePanelData(opts?: { initialLive?: boolean }): { data: PanelData | null; loading: boolean; error: string | null; refresh: (live?: boolean) => void; act: (path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>> } {
  const [data, setData] = useState<PanelData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = (live = false): void => {
    setLoading(true);
    fetch(`${API_BASE}/bindings${live ? "?live=1" : ""}`)
      .then((r) => r.json() as Promise<PanelData>)
      .then((d) => {
        if (alive.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (alive.current) setError(e.message);
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
  };

  const act = (path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> =>
    fetch(`${API_BASE}/${path}`, {
      method: "POST",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
      .then((r) => r.json() as Promise<Record<string, unknown>>)
      .then((d) => {
        if (alive.current && (d as { bindings?: unknown }).bindings !== undefined) {
          setData(d as unknown as PanelData);
          setError(null);
        }
        return d;
      })
      .catch((e: Error) => {
        if (alive.current) setError(e.message);
        return { ok: false, error: e.message };
      });

  useEffect(() => {
    alive.current = true;
    refresh(opts?.initialLive === true);
    const timer = setInterval(() => refresh(), 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, loading, error, refresh, act };
}

interface AuthFlowView {
  profile: string;
  verificationUrl?: string;
  qrcode?: string;
  browserOpened?: boolean;
}

function BindingRow({ b, onStartAuth, busy }: { b: BindingView; onStartAuth: (profile: string) => void; busy: string | null }): React.ReactElement {
  const color = STATUS_COLOR[b.status] ?? "#9ca3af";
  const needAuth = b.status !== "ready";
  const busyKey = `auth:${b.profile}`;
  return React.createElement(
    "div",
    {
      style: {
        display: "flex", alignItems: "center", gap: 8, padding: "6px 0",
        borderBottom: "1px solid rgba(128,128,128,.2)",
      },
    },
    React.createElement("span", {
      title: b.status,
      style: { width: 8, height: 8, borderRadius: 999, background: color, flexShrink: 0 },
    }),
    React.createElement(
      "div",
      { style: { minWidth: 0, flex: 1 } },
      React.createElement(
        "div",
        { style: { display: "flex", gap: 6, alignItems: "baseline" } },
        React.createElement("strong", { style: { fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, b.profile),
        React.createElement("span", { style: { fontSize: 10, opacity: 0.7 } }, b.brand),
        b.adopted ? React.createElement("span", { style: { fontSize: 10, opacity: 0.6 } }, "导入") : null,
        needAuth
          ? button(
              busy === busyKey ? "发起中…" : "扫码登录",
              () => onStartAuth(b.profile),
              busy === busyKey,
            )
          : null,
      ),
      React.createElement(
        "div",
        { style: { fontSize: 10, opacity: 0.65, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        `${b.userName ?? "（未登录用户）"} · ${b.status}`,
      ),
    ),
  );
}

function AuthFlowCard({ flow, onCompleteAuth, busy }: { flow: AuthFlowView; onCompleteAuth: (profile: string) => void; busy: string | null }): React.ReactElement {
  return React.createElement(
    "div",
    {
      style: {
        marginTop: 6, padding: 8, borderRadius: 8, fontSize: 11,
        border: "1px solid rgba(128,128,128,.35)", display: "flex", flexDirection: "column", gap: 6,
      },
    },
    React.createElement("div", { style: { fontWeight: 600 } }, `登录授权进行中（${flow.profile}）`),
    flow.verificationUrl !== undefined
      ? React.createElement(
          "a",
          { href: flow.verificationUrl, target: "_blank", rel: "noreferrer", style: { wordBreak: "break-all", color: "#3b82f6" } },
          flow.browserOpened ? "已在浏览器打开授权页（点此重开）" : "点此打开授权页",
        )
      : null,
    flow.qrcode !== undefined
      ? React.createElement("div", { style: { opacity: 0.7 } }, `二维码文件：${flow.qrcode}`)
      : null,
    React.createElement("div", { style: { opacity: 0.75 } }, "在浏览器确认授权后，点「我已授权」完成登录（10 分钟内有效）。"),
    button(busy === "auth-complete" ? "完成中…" : "我已授权，完成登录", () => onCompleteAuth(flow.profile), busy === "auth-complete"),
  );
}

function PanelBody(): React.ReactElement {
  const { data, loading, error, refresh, act } = usePanelData();
  const [busy, setBusy] = useState<string | null>(null);
  const [authFlow, setAuthFlow] = useState<AuthFlowView | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const run = (label: string, path: string): void => {
    setBusy(label);
    void act(path).finally(() => setBusy(null));
  };

  const startAuth = (profile: string): void => {
    setBusy(`auth:${profile}`);
    setAuthError(null);
    void act("auth-start", { profile })
      .then((d) => {
        if (d["ok"] === true) {
          setAuthFlow({
            profile,
            verificationUrl: typeof d["verificationUrl"] === "string" ? d["verificationUrl"] : undefined,
            qrcode: typeof d["qrcode"] === "string" ? d["qrcode"] : undefined,
            browserOpened: d["browserOpened"] === true,
          });
        } else {
          setAuthError(typeof d["message"] === "string" ? d["message"] : typeof d["error"] === "string" ? d["error"] : "auth-start 失败");
        }
      })
      .finally(() => setBusy(null));
  };

  const completeAuth = (profile: string): void => {
    setBusy("auth-complete");
    setAuthError(null);
    void act("auth-complete", { profile })
      .then((d) => {
        if (d["ok"] === true) {
          setAuthFlow(null);
          refresh(true);
        } else {
          setAuthError(typeof d["message"] === "string" ? d["message"] : typeof d["error"] === "string" ? d["error"] : "auth-complete 失败（用户是否已在浏览器确认？）");
        }
      })
      .finally(() => setBusy(null));
  };

  return React.createElement(
    "div",
    { style: { padding: 10, fontSize: 12, display: "flex", flexDirection: "column", gap: 8 } },
    React.createElement(
      "div",
      { style: { display: "flex", gap: 6 } },
      button("同步状态(health)", () => run("health", "health"), busy === "health"),
      button("导入 profile(adopt)", () => run("adopt", "adopt"), busy === "adopt"),
      loading ? React.createElement("span", { style: { opacity: 0.6, alignSelf: "center" } }, "…") : null,
    ),
    error !== null
      ? React.createElement("div", { style: { color: "#ef4444" } }, `加载失败：${error}（插件后端未运行？）`)
      : null,
    authError !== null
      ? React.createElement("div", { style: { color: "#ef4444" } }, authError)
      : null,
    authFlow !== null
      ? React.createElement(AuthFlowCard, { flow: authFlow, onCompleteAuth: completeAuth, busy })
      : null,
    data?.warnings?.map((w, i) =>
      React.createElement("div", { key: i, style: { color: "#f59e0b", fontSize: 11 } }, w),
    ),
    data !== null && data.bindings.length === 0
      ? React.createElement("div", { style: { opacity: 0.7 } }, "尚无绑定。点「导入 profile(adopt)」导入本机 lark-cli profile，或在终端运行 larklink bindings add 新增账号。")
      : null,
    data?.bindings.map((b) => React.createElement(BindingRow, { key: b.profile, b, onStartAuth: startAuth, busy })),
    data !== null && data.pins.length > 0
      ? React.createElement(
          "div",
          { style: { marginTop: 4 } },
          React.createElement("div", { style: { fontWeight: 600, marginBottom: 4 } }, `文档偏好（pin，${data.pins.length}）`),
          data.pins.map((p) =>
            React.createElement(
              "div",
              { key: p.token, style: { fontSize: 10, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              `${p.token.slice(0, 14)}… → ${p.profile}`,
            ),
          ),
        )
      : null,
    React.createElement(
      "div",
      { style: { fontSize: 10, opacity: 0.55, marginTop: 4 } },
      "add / remove 涉及 app secret 或破坏性操作，需在终端执行；登录授权（扫码）可直接在面板或让 Agent 触发。",
    ),
  );
}

function button(label: string, onClick: () => void, disabled: boolean): React.ReactElement {
  return React.createElement(
    "button",
    {
      onClick,
      disabled,
      style: {
        fontSize: 11, padding: "4px 8px", borderRadius: 6, cursor: disabled ? "default" : "pointer",
        border: "1px solid rgba(128,128,128,.4)", background: "transparent", opacity: disabled ? 0.5 : 1,
      },
    },
    label,
  );
}

const STATUS_LABEL: Record<string, string> = {
  ready: "可用",
  needs_refresh: "需刷新授权",
  unauthorized: "授权失效",
  incomplete: "未完成授权",
};

/** refreshExpiresAt → 本地时间 + 剩余时长。 */
function formatExpiry(iso: string | undefined): string {
  if (iso === undefined || iso === "") return "未知（点「实时核验」获取）";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const hours = (t - Date.now()) / 3_600_000;
  const remain = hours < 0 ? "已过期，需重新授权" : hours < 48 ? `剩余 ${hours.toFixed(1)} 小时` : `剩余 ${(hours / 24).toFixed(1)} 天`;
  return `${local}（${remain}）`;
}

function infoRow(label: string, value: string | undefined, mono = false): React.ReactElement {
  return React.createElement(
    "div",
    { style: { display: "flex", gap: 8, fontSize: 11, lineHeight: 1.6 } },
    React.createElement("span", { style: { opacity: 0.55, width: 88, flexShrink: 0 } }, label),
    React.createElement(
      "span",
      { style: { opacity: 0.9, wordBreak: "break-all", fontFamily: mono ? "var(--dsh-mono, ui-monospace, monospace)" : undefined } },
      value === undefined || value === "" ? "—" : value,
    ),
  );
}

function AccountCard({ b, onStartAuth, busy }: { b: BindingView; onStartAuth: (profile: string) => void; busy: string | null }): React.ReactElement {
  const color = STATUS_COLOR[b.status] ?? "#9ca3af";
  const ready = b.status === "ready";
  return React.createElement(
    "div",
    {
      style: {
        border: "1px solid rgba(128,128,128,.3)", borderRadius: 10, padding: "10px 12px",
        display: "flex", flexDirection: "column", gap: 6,
      },
    },
    React.createElement(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8 } },
      React.createElement("span", { style: { width: 9, height: 9, borderRadius: 999, background: color, flexShrink: 0 }, title: b.status }),
      React.createElement("strong", { style: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, b.profile),
      React.createElement("span", { style: { fontSize: 10, opacity: 0.65, border: "1px solid rgba(128,128,128,.4)", borderRadius: 4, padding: "0 4px" } }, b.brand === "feishu" ? "飞书" : "Lark"),
      b.adopted ? React.createElement("span", { style: { fontSize: 10, opacity: 0.55 } }, "导入") : null,
      React.createElement(
        "span",
        { style: { marginLeft: "auto", fontSize: 11, color, flexShrink: 0 } },
        STATUS_LABEL[b.status] ?? b.status,
      ),
      button(ready ? "重新授权" : "扫码登录/修复", () => onStartAuth(b.profile), busy === `auth:${b.profile}`),
    ),
    infoRow("登录用户", b.userName ?? "（未登录用户）"),
    infoRow("open_id", b.openId, true),
    infoRow("应用 App ID", b.appId, true),
    infoRow("授权有效期至", formatExpiry(b.refreshExpiresAt)),
  );
}

function SettingsSection(): React.ReactElement {
  const { data, loading, error, refresh, act } = usePanelData({ initialLive: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [authFlow, setAuthFlow] = useState<AuthFlowView | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const run = (label: string, path: string, live = false): void => {
    setBusy(label);
    void act(path)
      .then(() => { if (live) refresh(true); })
      .finally(() => setBusy(null));
  };

  const startAuth = (profile: string): void => {
    setBusy(`auth:${profile}`);
    setAuthError(null);
    void act("auth-start", { profile })
      .then((d) => {
        if (d["ok"] === true) {
          setAuthFlow({
            profile,
            verificationUrl: typeof d["verificationUrl"] === "string" ? d["verificationUrl"] : undefined,
            qrcode: typeof d["qrcode"] === "string" ? d["qrcode"] : undefined,
            browserOpened: d["browserOpened"] === true,
          });
        } else {
          setAuthError(typeof d["message"] === "string" ? d["message"] : typeof d["error"] === "string" ? d["error"] : "auth-start 失败");
        }
      })
      .finally(() => setBusy(null));
  };

  const completeAuth = (profile: string): void => {
    setBusy("auth-complete");
    setAuthError(null);
    void act("auth-complete", { profile })
      .then((d) => {
        if (d["ok"] === true) {
          setAuthFlow(null);
          refresh(true);
        } else {
          setAuthError(typeof d["message"] === "string" ? d["message"] : typeof d["error"] === "string" ? d["error"] : "auth-complete 失败（用户是否已在浏览器确认？）");
        }
      })
      .finally(() => setBusy(null));
  };

  const readyCount = data?.bindings.filter((b) => b.status === "ready").length ?? 0;

  return React.createElement(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 12, fontSize: 12, maxWidth: 640 } },
    React.createElement(
      "div",
      { style: { display: "flex", alignItems: "baseline", gap: 10 } },
      React.createElement("h3", { style: { margin: 0, fontSize: 14 } }, "LarkLink 账号管理"),
      React.createElement("span", { style: { opacity: 0.65, fontSize: 11 } },
        data !== null ? `${data.bindings.length} 个绑定 · ${readyCount} 个可用` : loading ? "加载中…" : ""),
      React.createElement(
        "span",
        { style: { marginLeft: "auto", display: "flex", gap: 6 } },
        button(busy === "live" ? "核验中…" : "实时核验", () => { setBusy("live"); refresh(true); setTimeout(() => setBusy(null), 400); }, busy === "live"),
        button("导入 profile(adopt)", () => run("adopt", "adopt", true), busy === "adopt"),
      ),
    ),
    error !== null ? React.createElement("div", { style: { color: "#ef4444" } }, `加载失败：${error}（插件后端未运行？）`) : null,
    authError !== null ? React.createElement("div", { style: { color: "#ef4444" } }, authError) : null,
    authFlow !== null ? React.createElement(AuthFlowCard, { flow: authFlow, onCompleteAuth: completeAuth, busy }) : null,
    data?.warnings?.map((w, i) => React.createElement("div", { key: i, style: { color: "#f59e0b", fontSize: 11 } }, w)) ?? null,
    data !== null && data.bindings.length === 0
      ? React.createElement("div", { style: { opacity: 0.7, border: "1px dashed rgba(128,128,128,.4)", borderRadius: 10, padding: 14 } },
          "尚无绑定。点「导入 profile(adopt)」导入本机 lark-cli profile；全新机器需在终端运行 larklink bindings add 新增账号（app secret 不经界面）。",
        )
      : null,
    data?.bindings.map((b) => React.createElement(AccountCard, { key: b.profile, b, onStartAuth: startAuth, busy })),
    data !== null && data.pins.length > 0
      ? React.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 4 } },
          React.createElement("div", { style: { fontWeight: 600 } }, `文档账号偏好（pin，${data.pins.length}）`),
          data.pins.map((p) =>
            React.createElement(
              "div",
              { key: p.token, style: { fontSize: 11, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              `${p.token.slice(0, 16)}… → ${p.profile}`,
            ),
          ),
        )
      : null,
    React.createElement(
      "div",
      { style: { fontSize: 10, opacity: 0.55 } },
      "会话中粘贴飞书/Lark 文档链接即自动路由；Agent 遇未登录会自动发起扫码登录。新增应用与删除绑定涉及 app secret / 破坏性操作，请在终端执行 larklink bindings add / remove。",
    ),
  );
}

function PanelTitle(): React.ReactElement {
  return React.createElement(
    "span",
    { style: { display: "inline-flex", alignItems: "center", gap: 6 } },
    React.createElement(TabIcon, null),
    TAB_TITLE,
  );
}

interface ClientCtx {
  slots: {
    /** 侧栏槽用 {name,key}；settings.section 用 {name,id,order,label}——统一收宽为 name + 任意选项。 */
    register(slot: { name: string } & Record<string, unknown>, component: (props: never) => React.ReactElement): unknown;
    inject(slotName: string, fn: () => unknown): unknown;
  };
  inject(services: string[], fn: (host: { get(name: string): unknown; slots: ClientCtx["slots"] }) => (() => void) | void): (() => void) | void;
}

export function apply(ctx: ClientCtx): (() => void) | void {
  const disposers: Array<() => void> = [];
  const push = (d: unknown): void => {
    if (typeof d === "function") disposers.push(d as () => void);
  };
  const pushInner = (inner: Array<() => void>, d: unknown): void => {
    if (typeof d === "function") inner.push(d as () => void);
  };

  push(
    ctx.inject(["sidebarRight", "sidebarRightTabs"], (host) => {
      const tabs = host.get("sidebarRightTabs") as { register?(tab: Record<string, unknown>): unknown } | null;
      if (tabs === null || typeof tabs.register !== "function") return () => {};
      const inner: Array<() => void> = [];
      pushInner(
        inner,
        host.slots.inject(BODY_SLOT, () =>
          host.slots.inject(TITLE_SLOT, () => {
            inner.push(
              (() => {
                const d = tabs.register!({
                  id: TAB_ID,
                  kind: TAB_KIND,
                  title: () => TAB_TITLE,
                  guide: [
                    {
                      order: 70,
                      title: () => TAB_TITLE,
                      description: () => "lark 多账号绑定状态与文档路由偏好（adopt / health / pins）",
                      icon: TabIcon,
                    },
                  ],
                });
                return typeof d === "function" ? (d as () => void) : () => {};
              })(),
            );
            pushInner(inner, host.slots.register({ name: BODY_SLOT, key: TAB_ID }, () => React.createElement(PanelBody)));
            pushInner(inner, host.slots.register({ name: TITLE_SLOT, key: TAB_ID }, () => React.createElement(PanelTitle)));
            return () => {
              for (const d of [...inner].reverse()) d();
            };
          }),
        ),
      );
      return () => {
        for (const d of [...inner].reverse()) d();
      };
    }),
  );

  // 设置页：「LarkLink 账户管理」（settings.section 列表槽；照 dshmarket 先例 id/order/label + 内容组件）
  if (ctx.slots != null && typeof ctx.slots.register === "function") {
    // 防护：宿主未声明该槽时 register 会 throw（dsh-client-ui-slots:165）——降级跳过设置页，
    // 不让异常逃逸导致整个客户端半边（含侧栏面板）被连带判失败。
    try {
    push(
      ctx.slots.register(
        { name: "settings.section", id: SETTINGS_SECTION_ID, order: 50, label: () => "LarkLink 账号管理" },
        () => React.createElement(SettingsSection),
      ),
    );
    } catch (e) {
      console.warn("[dsh-larklink] settings.section 槽不可用（宿主未声明？），设置页已跳过，侧栏面板不受影响", e);
    }
  }

  return () => {
    for (const d of [...disposers].reverse()) d();
  };
}
