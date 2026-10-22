/**
 * bindings 生命周期命令（design.md §6，决议 Q8/Q10）。
 * 所有 lark-cli 调用经注入的 runner，便于测试 mock。
 */
import {
  findBinding,
  findPin,
  removeBinding,
  upsertBinding,
  upsertPin,
  type Binding,
  type BindingStatus,
} from "@timeryu288/larklink-core";
import type { LarkRunner } from "../larkcli.js";
import { safeJson } from "../larkcli.js";
import { loadRegistry, larklinkHome, saveRegistry } from "../store.js";
import { appendAudit } from "../audit.js";

export interface BindingsCtx {
  runner: LarkRunner;
  home?: string;
}

interface ProfileListEntry {
  name?: string;
  app_id?: string;
  appId?: string;
  brand?: string;
  active?: boolean;
  user?: { name?: string; open_id?: string } | string | null;
  tokenStatus?: string;
  token_status?: string;
}

/** lark-cli 状态字符串 → BindingStatus。无已登录用户 = incomplete（Q8：不可路由）。 */
export function mapStatus(raw: string | undefined, hasUser: boolean): BindingStatus {
  const s = (raw ?? "").toLowerCase();
  if (!hasUser) return "incomplete";
  if (s.includes("refresh") || s.includes("expire")) return "needs_refresh";
  if (s.includes("unauthorized") || s.includes("revoked") || s.includes("invalid")) return "unauthorized";
  return "ready";
}

export function bindingFromProfileList(e: ProfileListEntry): Binding | null {
  const profile = e.name;
  if (!profile || !e.brand || e.brand !== "feishu" && e.brand !== "lark") return null;
  const hasUser = e.user !== undefined && e.user !== null && e.user !== "";
  return {
    profile,
    brand: e.brand,
    appId: (e.appId ?? e.app_id ?? "").toString(),
    userName: userNameOf(e.user),
    status: mapStatus(e.tokenStatus ?? e.token_status, hasUser),
    adopted: true,
    addedAt: new Date().toISOString(),
  };
}

function userNameOf(user: ProfileListEntry["user"]): string | undefined {
  if (typeof user === "string") return user || undefined;
  return user?.name || undefined;
}

/** adopt：导入既有 lark-cli profile（不动原 profile，Q8-①）。 */
export async function cmdAdopt(ctx: BindingsCtx, opts: { profiles?: string[] }): Promise<number> {
  const home = ctx.home ?? larklinkHome();
  const res = await ctx.runner(["profile", "list"], { timeoutMs: 20_000 });
  const payload = safeJson(res.stdout);
  const entries = Array.isArray(payload) ? (payload as ProfileListEntry[]) : [];
  if (entries.length === 0) {
    console.log(JSON.stringify({ ok: false, code: "lark-cli-error", message: `profile list 无结果（exit ${res.exitCode}）：${res.stderr.slice(0, 300)}` }));
    return 1;
  }
  const wanted = opts.profiles ? new Set(opts.profiles) : null;
  let registry = await loadRegistry(home);
  const adopted: string[] = [];
  const skipped: string[] = [];
  for (const e of entries) {
    const b = bindingFromProfileList(e);
    if (!b) { skipped.push(e.name ?? "(未知)"); continue; }
    if (wanted && !wanted.has(b.profile)) continue;
    const existing = findBinding(registry, b.profile);
    registry = upsertBinding(registry, existing ? { ...existing, ...b, adopted: existing.adopted ?? b.adopted } : b);
    adopted.push(b.profile);
  }
  await saveRegistry(registry, home);
  await appendAudit({ kind: "bindings", message: `adopt: ${adopted.join(", ") || "(none)"}`, profile: adopted.join(",") }, home);
  console.log(JSON.stringify({ ok: true, adopted, skipped, hint: skipped.length ? "跳过项为无 brand/用户的 profile" : undefined }, null, 2));
  return 0;
}

/** add：注册新应用+用户（app-id + secret via stdin；--new 交互式建应用暂不封装，见 README）。 */
export async function cmdAdd(
  ctx: BindingsCtx,
  opts: { name: string; brand: "feishu" | "lark"; appId: string; appSecret: string },
): Promise<number> {
  const home = ctx.home ?? larklinkHome();
  const res = await ctx.runner(
    ["profile", "add", "--name", opts.name, "--app-id", opts.appId, "--brand", opts.brand, "--app-secret-stdin"],
    { timeoutMs: 30_000, stdin: opts.appSecret + "\n" },
  );
  if (res.exitCode !== 0) {
    console.log(JSON.stringify({ ok: false, code: "lark-cli-error", exitCode: res.exitCode, error: safeJson(res.stderr) ?? res.stderr.slice(0, 400) }));
    return 1;
  }
  let registry = await loadRegistry(home);
  registry = upsertBinding(registry, {
    profile: opts.name,
    brand: opts.brand,
    appId: opts.appId,
    status: "incomplete", // 尚未 split-flow 授权
    addedAt: new Date().toISOString(),
  });
  await saveRegistry(registry, home);
  console.log(JSON.stringify({ ok: true, profile: opts.name, next: `larklink bindings auth ${opts.name}` }, null, 2));
  return 0;
}

/**
 * auth：split-flow 授权/恢复（Q8-②：中断后每次都发起新流程，绝不缓存授权码）。
 * 无 --device-code：发起（--no-wait 打印 verification_url，可选二维码）；
 * 有 --device-code：收尾。
 */
export async function cmdAuth(
  ctx: BindingsCtx,
  opts: { profile: string; domain?: string; deviceCode?: string },
): Promise<number> {
  const home = ctx.home ?? larklinkHome();
  if (opts.deviceCode !== undefined) {
    const res = await ctx.runner(
      ["--profile", opts.profile, "auth", "login", "--device-code", opts.deviceCode, "--json"],
      { timeoutMs: 30_000 },
    );
    if (res.exitCode !== 0) {
      console.log(JSON.stringify({ ok: false, code: "lark-cli-error", exitCode: res.exitCode, error: safeJson(res.stderr) ?? res.stderr.slice(0, 400) }));
      return 1;
    }
    const health = await syncBindingStatus(ctx, home, opts.profile);
    console.log(JSON.stringify({ ok: true, profile: opts.profile, ...health }, null, 2));
    return 0;
  }
  const domain = opts.domain ?? "docs";
  const res = await ctx.runner(
    ["--profile", opts.profile, "auth", "login", "--domain", domain, "--no-wait", "--json"],
    { timeoutMs: 30_000 },
  );
  const payload = safeJson(res.stdout) as Record<string, unknown> | null;
  const errPayload = safeJson(res.stderr);
  if (res.exitCode !== 0 || payload === null) {
    console.log(JSON.stringify({ ok: false, code: "lark-cli-error", exitCode: res.exitCode, error: errPayload ?? res.stderr.slice(0, 400) }));
    return 1;
  }
  const url = (payload["verification_url"] ?? payload["url"]) as string | undefined;
  if (!url) {
    console.log(JSON.stringify({ ok: false, code: "no-verification-url", message: "lark-cli 未返回 verification_url", payload }));
    return 1;
  }
  // 二维码（尽力而为，失败不阻塞）
  let qrcode: string | undefined;
  try {
    const { mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(home, { recursive: true });
    const png = join(home, `qrcode-${opts.profile}.png`);
    const qr = await ctx.runner(["auth", "qrcode", url, "--output", png], { timeoutMs: 15_000 });
    if (qr.exitCode === 0) qrcode = png;
  } catch { /* 忽略 */ }
  console.log(JSON.stringify({ ok: true, profile: opts.profile, verificationUrl: url, qrcode, next: `用户完成授权后执行：larklink bindings auth ${opts.profile} --device-code <code>` }, null, 2));
  return 0;
}

interface AuthStatusPayload {
  identities?: {
    user?: {
      status?: string;
      available?: boolean;
      userName?: string;
      openId?: string;
      tokenStatus?: string;
      refreshExpiresAt?: string;
    };
    bot?: { status?: string; available?: boolean };
  };
}

/**
 * 用真实 `auth status --json --verify` 结构同步（identities.user.{userName,tokenStatus,refreshExpiresAt}）。
 * 无 user 身份 → incomplete（绑定=app+user，bot-only 不可作用户身份路由）。
 */
async function syncBindingStatus(
  ctx: BindingsCtx,
  home: string,
  profile: string,
): Promise<{ status?: BindingStatus; userName?: string; openId?: string; warning?: string }> {
  const res = await ctx.runner(["--profile", profile, "auth", "status", "--json", "--verify"], { timeoutMs: 20_000 });
  const payload = safeJson(res.stdout) as AuthStatusPayload | null;
  const user = payload?.identities?.user;
  if (user === undefined) {
    const updated = await setBindingStatus(home, profile, "incomplete");
    void updated;
    return { status: "incomplete", warning: `绑定 ${profile} 无 user 身份（bot-only）→ incomplete，不可路由` };
  }
  const status = mapStatus(user.tokenStatus ?? user.status, true);
  let warning: string | undefined;
  if (user.refreshExpiresAt !== undefined) {
    const expiry = Date.parse(user.refreshExpiresAt);
    if (!Number.isNaN(expiry)) {
      const hoursLeft = (expiry - Date.now()) / 3_600_000;
      if (hoursLeft < 0) warning = `绑定 ${profile} refresh token 已过期，需重新授权`;
      else if (hoursLeft < 48) warning = `绑定 ${profile} refresh token ${hoursLeft.toFixed(1)}h 后过期，建议尽快重新授权`;
    }
  }
  let registry = await loadRegistry(home);
  const existing = findBinding(registry, profile);
  if (existing) {
    registry = upsertBinding(registry, {
      ...existing,
      status,
      userName: user.userName ?? existing.userName,
      openId: user.openId ?? existing.openId,
    });
    await saveRegistry(registry, home);
  }
  return { status, userName: user.userName, openId: user.openId, warning };
}

async function setBindingStatus(home: string, profile: string, status: BindingStatus): Promise<boolean> {
  let registry = await loadRegistry(home);
  const existing = findBinding(registry, profile);
  if (!existing) return false;
  registry = upsertBinding(registry, { ...existing, status });
  await saveRegistry(registry, home);
  return true;
}

/** list / health：同步各绑定真实状态；health 额外清理死 pin（Q10-①）。 */
export async function cmdList(ctx: BindingsCtx, opts: { fast?: boolean; health?: boolean }): Promise<number> {
  const home = ctx.home ?? larklinkHome();
  let registry = await loadRegistry(home);
  const warnings: string[] = [];
  if (!opts.fast) {
    for (const b of registry.bindings) {
      try {
        const s = await syncBindingStatus(ctx, home, b.profile);
        if (s.warning) warnings.push(s.warning);
        if (opts.health && s.status && s.status !== "ready" && s.status !== "incomplete") {
          warnings.push(`绑定 ${b.profile} 状态 ${s.status}：请 larklink bindings auth ${b.profile} 修复`);
        }
      } catch (e) {
        warnings.push(`绑定 ${b.profile} 状态同步失败：${(e as Error).message}`);
      }
    }
    registry = await loadRegistry(home);
  }
  if (opts.health) {
    const profiles = new Set(registry.bindings.map((b) => b.profile));
    const dead = registry.pins.filter((p) => !profiles.has(p.profile));
    if (dead.length > 0) {
      for (const d of dead) registry = { ...registry, pins: registry.pins.filter((p) => p.token !== d.token) };
      await saveRegistry(registry, home);
      warnings.push(`清理死 pin ${dead.length} 条`);
    }
  }
  console.log(JSON.stringify({
    ok: true,
    bindings: registry.bindings.map((b) => ({ profile: b.profile, brand: b.brand, appId: b.appId, userName: b.userName, status: b.status, adopted: b.adopted ?? false })),
    pins: registry.pins,
    warnings,
  }, null, 2));
  return 0;
}

/** remove：Q8-③ 破坏边界。adopted 默认保 profile（--purge 才删）；自建默认删（--keep-profile 保）。 */
export async function cmdRemove(
  ctx: BindingsCtx,
  opts: { profile: string; purge?: boolean; keepProfile?: boolean; yes?: boolean },
): Promise<number> {
  const home = ctx.home ?? larklinkHome();
  const registry = await loadRegistry(home);
  const binding = findBinding(registry, opts.profile);
  if (!binding) {
    console.log(JSON.stringify({ ok: false, code: "binding-not-found", message: `绑定 ${opts.profile} 不存在` }));
    return 2;
  }
  const willDeleteProfile = opts.purge === true || (opts.keepProfile !== true && binding.adopted !== true);
  const affectedPins = registry.pins.filter((p) => p.profile === opts.profile);
  if (!opts.yes) {
    console.log(JSON.stringify({
      ok: false,
      code: "confirmation-required",
      message: "破坏性操作需 --yes 确认；请核对以下影响后重试",
      plan: {
        profile: opts.profile,
        willDeleteLarkCliProfile: willDeleteProfile,
        adopted: binding.adopted ?? false,
        affectedPins: affectedPins.map((p) => p.token),
      },
    }, null, 2));
    return 2;
  }
  if (willDeleteProfile) {
    const res = await ctx.runner(["profile", "remove", "--name", opts.profile, "--yes"], { timeoutMs: 20_000 });
    if (res.exitCode !== 0) {
      console.log(JSON.stringify({ ok: false, code: "lark-cli-error", message: `profile remove 失败（未删除注册表）`, exitCode: res.exitCode, error: safeJson(res.stderr) ?? res.stderr.slice(0, 300) }));
      return 1;
    }
  }
  let updated = removeBinding(registry, opts.profile, { dropPins: true });
  await saveRegistry(updated, home);
  await appendAudit({ kind: "bindings", profile: opts.profile, message: `remove（deletedProfile=${willDeleteProfile}，pins=${affectedPins.length}）` }, home);
  console.log(JSON.stringify({ ok: true, removed: opts.profile, deletedLarkCliProfile: willDeleteProfile, removedPins: affectedPins.length }, null, 2));
  return 0;
}

/** pin：手动增删查（兜底入口）。 */
export async function cmdPin(
  opts: { op: "add" | "remove" | "list"; token?: string; profile?: string },
  home = larklinkHome(),
): Promise<number> {
  const registry = await loadRegistry(home);
  if (opts.op === "list") {
    console.log(JSON.stringify({ ok: true, pins: registry.pins }, null, 2));
    return 0;
  }
  if (!opts.token || (opts.op === "add" && !opts.profile)) {
    console.log(JSON.stringify({ ok: false, code: "usage", message: "pin add 需要 --token 与 --profile；remove 只需 --token" }));
    return 2;
  }
  if (opts.op === "add") {
    const token = opts.token;
    const profile = opts.profile;
    if (!token || !profile) {
      console.log(JSON.stringify({ ok: false, code: "usage", message: "pin add 需要 --token 与 --profile" }));
      return 2;
    }
    if (!findBinding(registry, profile)) {
      console.log(JSON.stringify({ ok: false, code: "binding-not-found", message: `绑定 ${profile} 不存在` }));
      return 2;
    }
    const updated = upsertPin(registry, { token, profile, updatedAt: new Date().toISOString() });
    await saveRegistry(updated, home);
    console.log(JSON.stringify({ ok: true, pinned: token, profile }));
    return 0;
  }
  const updated = { ...registry, pins: registry.pins.filter((p) => p.token !== opts.token) };
  await saveRegistry(updated, home);
  console.log(JSON.stringify({ ok: true, removed: opts.token && findPin(registry, opts.token) ? opts.token : null }));
  return 0;
}
