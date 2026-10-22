/**
 * genui 绑定管理面板（web client）。
 * 挂载契约照 browser-skill 先例：sidebarRightTabs.register + slots
 * （"sidebar.right.pane.tab" / "sidebar.right.pane.tab.title"）。
 * 数据来自后端 /larklink/* 路由（同源 fetch）；仅无敏感操作。
 */
import React, { useEffect, useRef, useState } from "react";

export const inject = ["slots"];

const TAB_ID = "@timeryu288/dsh-larklink/bindings";
const TAB_KIND = "larklink-bindings";
const TAB_TITLE = "Lark 绑定";
const BODY_SLOT = "sidebar.right.pane.tab";
const TITLE_SLOT = "sidebar.right.pane.tab.title";
const API_BASE = "/larklink";

interface BindingView {
  profile: string;
  brand: string;
  appId: string;
  userName?: string;
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

function usePanelData(): { data: PanelData | null; loading: boolean; error: string | null; refresh: (live?: boolean) => void; act: (path: string) => Promise<void> } {
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

  const act = (path: string): Promise<void> =>
    fetch(`${API_BASE}/${path}`, { method: "POST" })
      .then((r) => r.json() as Promise<PanelData>)
      .then((d) => {
        if (alive.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (alive.current) setError(e.message);
      });

  useEffect(() => {
    alive.current = true;
    refresh();
    const timer = setInterval(() => refresh(), 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, loading, error, refresh, act };
}

function BindingRow({ b }: { b: BindingView }): React.ReactElement {
  const color = STATUS_COLOR[b.status] ?? "#9ca3af";
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
      ),
      React.createElement(
        "div",
        { style: { fontSize: 10, opacity: 0.65, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        `${b.userName ?? "（未登录用户）"} · ${b.status}`,
      ),
    ),
  );
}

function PanelBody(): React.ReactElement {
  const { data, loading, error, refresh, act } = usePanelData();
  const [busy, setBusy] = useState<string | null>(null);

  const run = (label: string, path: string): void => {
    setBusy(label);
    void act(path).finally(() => setBusy(null));
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
    data?.warnings?.map((w, i) =>
      React.createElement("div", { key: i, style: { color: "#f59e0b", fontSize: 11 } }, w),
    ),
    data !== null && data.bindings.length === 0
      ? React.createElement("div", { style: { opacity: 0.7 } }, "尚无绑定。点「导入 profile(adopt)」导入本机 lark-cli profile，或在终端运行 larklink bindings add 新增账号。")
      : null,
    data?.bindings.map((b) => React.createElement(BindingRow, { key: b.profile, b })),
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
      "add / auth（扫码）/ remove 需在终端执行——密钥不经面板与模型。",
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
    register(slot: { name: string; key: string }, component: (props: unknown) => React.ReactElement): unknown;
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

  return () => {
    for (const d of [...disposers].reverse()) d();
  };
}
