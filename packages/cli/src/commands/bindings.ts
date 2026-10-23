/**
 * bindings 生命周期命令（design.md §6，决议 Q8/Q10）。
 * 所有 lark-cli 调用经注入的 runner，便于测试 mock。
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** 输出缝：默认打印 JSON（bin 行为）；插件进程内调用时捕获信封。多余参数（null, 2）被忽略。 */
export type Emit = (payload: unknown, _indent?: unknown, _extra?: unknown) => void;
export const stdEmit: Emit = (payload) => console.log(JSON.stringify(payload, null, 2));

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
export async function cmdAdopt(ctx: BindingsCtx, opts: { profiles?: string[] }, emit: Emit = stdEmit): Promise<number> {
  const home = ctx.home ?? larklinkHome();
  const res = await ctx.runner(["profile", "list"], { timeoutMs: 20_000 });
  const payload = safeJson(res.stdout);
  const entries = Array.isArray(payload) ? (payload as ProfileListEntry[]) : [];
  if (entries.length === 0) {
    emit({ ok: false, code: "lark-cli-error", message: `profile list 无结果（exit ${res.exitCode}）：${res.stderr.slice(0, 300)}` });
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
  emit({ ok: true, adopted, skipped, hint: skipped.length ? "跳过项为无 brand/用户的 profile" : undefined }, null, 2);
  return 0;
}

/** add：注册新应用+用户（app-id + secret via stdin；--new 交互式建应用暂不封装，见 README）。 */
export async function cmdAdd(
  ctx: BindingsCtx,
  opts: { name: string; brand: "feishu" | "lark"; appId: string; appSecret: string },
  emit: Emit = stdEmit,
): Promise<number> {
  const home = ctx.home ?? larklinkHome();
  const res = await ctx.runner(
    ["profile", "add", "--name", opts.name, "--app-id", opts.appId, "--brand", opts.brand, "--app-secret-stdin"],
    { timeoutMs: 30_000, stdin: opts.appSecret + "\n" },
  );
  if (res.exitCode !== 0) {
    emit({ ok: false, code: "lark-cli-error", exitCode: res.exitCode, error: safeJson(res.stderr) ?? res.stderr.slice(0, 400) });
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
  emit({ ok: true, profile: opts.name, next: `larklink bindings auth ${opts.name}` }, null, 2);
  return 0;
}

/** 进行中 split-flow 的暂存（收尾用；auth-start 每次整体覆盖，过期即作废——Q8-②：绝不缓存旧授权码跨流程复用）。 */
export interface PendingAuthFlow {
  profile: string;
  deviceCode: string;
  verificationUrl: string;
  startedAt: string;
  /** ISO 时间；超过即过期，必须重新 auth-start。 */
  expiresAt: string;
}

function pendingAuthPath(home: string): string {
  return join(home, "pending-auth.json");
}

async function readPendingAuth(home: string): Promise<PendingAuthFlow | null> {
  try {
    const text = await readFile(pendingAuthPath(home), "utf8");
    const parsed = safeJson(text) as PendingAuthFlow | null;
    if (parsed === null || typeof parsed !== "object" || !parsed.profile || !parsed.deviceCode) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writePendingAuth(home: string, flow: PendingAuthFlow): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(pendingAuthPath(home), JSON.stringify(flow, null, 2) + "\n", "utf8");
}

async function clearPendingAuth(home: string): Promise<void> {
  await rm(pendingAuthPath(home), { force: true });
}

/** 尽力打开系统浏览器（DSH 宿主运行在用户本机；失败不阻塞，envelope 里报告）。 */
export function openInBrowser(url: string): boolean {
  try {
    const cmd = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(cmd, args, { shell: false, stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface AuthOptions {
  profile: string;
  domain?: string;
  /** 显式设备码收尾（CLI 直用；不传则读暂存的进行中流程）。 */
  deviceCode?: string;
  /** true = 收尾步骤（工具/CLI 在用户完成浏览器授权后调用）。 */
  complete?: boolean;
  /** false = 不自动打开浏览器（默认打开）。 */
  open?: boolean;
}

/**
 * auth：split-flow 授权/恢复（Q8-②：中断后每次都发起新流程，绝不缓存授权码复用）。
 * 全程无密钥经手——app secret 留在 lark-cli profile 里，lark-cli 官方 agent 契约本身就要求
 * agent 展示 verification_url/二维码并自行执行 --device-code 收尾。
 * - 发起：`auth login --domain <域> --no-wait --json` → verification_url + device_code + 二维码 →（默认）自动开浏览器 → 暂存待收尾
 * - 收尾：`auth login --device-code <code>`（码取自参数或暂存）→ 同步绑定状态
 */
export async function cmdAuth(
  ctx: BindingsCtx,
  opts: AuthOptions,
  emit: Emit = stdEmit,
): Promise<number> {
  const home = ctx.home ?? larklinkHome();

  // ---- 收尾步骤 ----
  if (opts.complete === true || opts.deviceCode !== undefined) {
    let deviceCode = opts.deviceCode;
    let fromStash = false;
    if (deviceCode === undefined) {
      const pending = await readPendingAuth(home);
      if (pending === null) {
        emit({ ok: false, code: "no-pending-auth", message: `没有进行中的授权流程（${pendingAuthPath(home)} 不存在）。先执行 auth-start 发起新流程。` });
        return 2;
      }
      if (pending.profile !== opts.profile) {
        emit({ ok: false, code: "pending-auth-mismatch", message: `进行中的授权流程属于绑定 ${pending.profile}，与请求的 ${opts.profile} 不符。请先对 ${pending.profile} 收尾或重新发起。` });
        return 2;
      }
      if (Date.parse(pending.expiresAt) <= Date.now()) {
        await clearPendingAuth(home);
        emit({ ok: false, code: "pending-auth-expired", message: `授权流程已过期（发起于 ${pending.startedAt}）。请重新 auth-start 发起全新流程（Q8-②：不缓存旧授权码）。` });
        return 2;
      }
      deviceCode = pending.deviceCode;
      fromStash = true;
    }
    const res = await ctx.runner(
      ["--profile", opts.profile, "auth", "login", "--device-code", deviceCode, "--json"],
      { timeoutMs: 60_000 },
    );
    if (res.exitCode !== 0) {
      // 收尾失败不清暂存：用户可能还没在浏览器里确认，允许再次收尾重试轮询
      emit({ ok: false, code: "lark-cli-error", exitCode: res.exitCode, error: safeJson(res.stderr) ?? res.stderr.slice(0, 400), hint: "若用户尚未在浏览器完成授权，请等用户确认后重新 auth-complete（轮询重试）" });
      return 1;
    }
    if (fromStash) await clearPendingAuth(home);
    const health = await syncBindingStatus(ctx, home, opts.profile);
    await appendAudit({ kind: "bindings", profile: opts.profile, message: `auth complete（status=${health.status ?? "?"}）` }, home);
    emit({ ok: true, profile: opts.profile, status: health.status, userName: health.userName, warning: health.warning, next: health.status === "ready" ? "授权恢复，可继续原操作" : `状态仍为 ${health.status}，可能需要检查应用配置后重新授权` }, null, 2);
    return 0;
  }

  // ---- 发起步骤 ----
  const domain = opts.domain ?? "docs";
  const res = await ctx.runner(
    ["--profile", opts.profile, "auth", "login", "--domain", domain, "--no-wait", "--json"],
    { timeoutMs: 30_000 },
  );
  const payload = safeJson(res.stdout) as Record<string, unknown> | null;
  const errPayload = safeJson(res.stderr);
  if (res.exitCode !== 0 || payload === null) {
    emit({ ok: false, code: "lark-cli-error", exitCode: res.exitCode, error: errPayload ?? res.stderr.slice(0, 400) });
    return 1;
  }
  const url = (payload["verification_url"] ?? payload["url"]) as string | undefined;
  const deviceCode = (payload["device_code"] ?? payload["deviceCode"]) as string | undefined;
  if (!url) {
    emit({ ok: false, code: "no-verification-url", message: "lark-cli 未返回 verification_url", payload });
    return 1;
  }
  const expiresInSec = typeof payload["expires_in"] === "number" ? (payload["expires_in"] as number) : 600;

  // 二维码（尽力而为，失败不阻塞）。lark-cli 的 --output 只接受 cwd 内相对路径 → 用 cwd=home + 相对名。
  let qrcode: string | undefined;
  try {
    await mkdir(home, { recursive: true });
    const qrName = `qrcode-${opts.profile}.png`;
    const qr = await ctx.runner(["auth", "qrcode", url, "--output", qrName], { timeoutMs: 15_000, cwd: home });
    if (qr.exitCode === 0) qrcode = join(home, qrName);
  } catch { /* 忽略 */ }

  // 暂存进行中流程（auth-complete 免携带 device_code）
  const flow: PendingAuthFlow = {
    profile: opts.profile,
    deviceCode: deviceCode ?? "",
    verificationUrl: url,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
  };
  if (deviceCode !== undefined) await writePendingAuth(home, flow);

  // 自动打开浏览器（默认；尽力而为）
  const browserOpened = opts.open !== false ? openInBrowser(url) : false;

  await appendAudit({ kind: "bindings", profile: opts.profile, message: `auth start（domain=${domain}，expiresIn=${expiresInSec}s）` }, home);
  emit({
    ok: true,
    profile: opts.profile,
    status: "auth-started",
    verificationUrl: url,
    qrcode,
    expiresInSeconds: expiresInSec,
    browserOpened,
    next: [
      "1. 让用户在浏览器（已自动打开；未打开则手动访问 verificationUrl 或扫码二维码）完成授权确认",
      "2. 用户确认后调用 auth-complete（device_code 已暂存，无需携带）",
      "3. 授权 URL 10 分钟内有效，过期须重新 auth-start（Q8-②）",
    ].join("\n"),
  }, null, 2);
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
): Promise<{ status?: BindingStatus; userName?: string; openId?: string; refreshExpiresAt?: string; warning?: string }> {
  const res = await ctx.runner(["--profile", profile, "auth", "status", "--json", "--verify"], { timeoutMs: 20_000 });
  const payload = safeJson(res.stdout) as AuthStatusPayload | null;
  const user = payload?.identities?.user;
  if (user === undefined) {
    const updated = await setBindingStatus(home, profile, "incomplete");
    void updated;
    return { status: "incomplete", warning: `绑定 ${profile} 无 user 身份（bot-only）→ incomplete，不可路由` };
  }
  const status = mapStatus(user.tokenStatus ?? user.status, true);
  const refreshExpiresAt = user.refreshExpiresAt;
  let warning: string | undefined;
  if (refreshExpiresAt !== undefined) {
    const expiry = Date.parse(refreshExpiresAt);
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
  return { status, userName: user.userName, openId: user.openId, refreshExpiresAt, warning };
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
export async function cmdList(ctx: BindingsCtx, opts: { fast?: boolean; health?: boolean }, emit: Emit = stdEmit): Promise<number> {
  const home = ctx.home ?? larklinkHome();
  let registry = await loadRegistry(home);
  const warnings: string[] = [];
  /** 实时核验结果（openId / refreshExpiresAt 不落 registry，仅随本次信封透出）。 */
  const liveInfo = new Map<string, { openId?: string; refreshExpiresAt?: string }>();
  if (!opts.fast) {
    for (const b of registry.bindings) {
      try {
        const s = await syncBindingStatus(ctx, home, b.profile);
        if (s.warning) warnings.push(s.warning);
        if (s.openId !== undefined || s.refreshExpiresAt !== undefined) {
          liveInfo.set(b.profile, { openId: s.openId, refreshExpiresAt: s.refreshExpiresAt });
        }
        if (opts.health && s.status && s.status !== "ready" && s.status !== "incomplete") {
          warnings.push(`绑定 ${b.profile} 状态 ${s.status}：调用 larklink_bindings(action=auth-start, profile=${b.profile}) 发起登录修复`);
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
  emit({
    ok: true,
    bindings: registry.bindings.map((b) => ({
      profile: b.profile,
      brand: b.brand,
      appId: b.appId,
      userName: b.userName,
      openId: liveInfo.get(b.profile)?.openId ?? b.openId,
      refreshExpiresAt: liveInfo.get(b.profile)?.refreshExpiresAt,
      status: b.status,
      adopted: b.adopted ?? false,
    })),
    pins: registry.pins,
    warnings,
  }, null, 2);
  return 0;
}

/** remove：Q8-③ 破坏边界。adopted 默认保 profile（--purge 才删）；自建默认删（--keep-profile 保）。 */
export async function cmdRemove(
  ctx: BindingsCtx,
  opts: { profile: string; purge?: boolean; keepProfile?: boolean; yes?: boolean },
  emit: Emit = stdEmit,
): Promise<number> {
  const home = ctx.home ?? larklinkHome();
  const registry = await loadRegistry(home);
  const binding = findBinding(registry, opts.profile);
  if (!binding) {
    emit({ ok: false, code: "binding-not-found", message: `绑定 ${opts.profile} 不存在` });
    return 2;
  }
  const willDeleteProfile = opts.purge === true || (opts.keepProfile !== true && binding.adopted !== true);
  const affectedPins = registry.pins.filter((p) => p.profile === opts.profile);
  if (!opts.yes) {
    emit({
      ok: false,
      code: "confirmation-required",
      message: "破坏性操作需 --yes 确认；请核对以下影响后重试",
      plan: {
        profile: opts.profile,
        willDeleteLarkCliProfile: willDeleteProfile,
        adopted: binding.adopted ?? false,
        affectedPins: affectedPins.map((p) => p.token),
      },
    }, null, 2);
    return 2;
  }
  if (willDeleteProfile) {
    const res = await ctx.runner(["profile", "remove", "--name", opts.profile, "--yes"], { timeoutMs: 20_000 });
    if (res.exitCode !== 0) {
      emit({ ok: false, code: "lark-cli-error", message: `profile remove 失败（未删除注册表）`, exitCode: res.exitCode, error: safeJson(res.stderr) ?? res.stderr.slice(0, 300) });
      return 1;
    }
  }
  let updated = removeBinding(registry, opts.profile, { dropPins: true });
  await saveRegistry(updated, home);
  await appendAudit({ kind: "bindings", profile: opts.profile, message: `remove（deletedProfile=${willDeleteProfile}，pins=${affectedPins.length}）` }, home);
  emit({ ok: true, removed: opts.profile, deletedLarkCliProfile: willDeleteProfile, removedPins: affectedPins.length }, null, 2);
  return 0;
}

/** pin：手动增删查（兜底入口）。 */
export async function cmdPin(
  opts: { op: "add" | "remove" | "list"; token?: string; profile?: string },
  home = larklinkHome(),
  emit: Emit = stdEmit,
): Promise<number> {
  const registry = await loadRegistry(home);
  if (opts.op === "list") {
    emit({ ok: true, pins: registry.pins }, null, 2);
    return 0;
  }
  if (!opts.token || (opts.op === "add" && !opts.profile)) {
    emit({ ok: false, code: "usage", message: "pin add 需要 --token 与 --profile；remove 只需 --token" });
    return 2;
  }
  if (opts.op === "add") {
    const token = opts.token;
    const profile = opts.profile;
    if (!token || !profile) {
      emit({ ok: false, code: "usage", message: "pin add 需要 --token 与 --profile" });
      return 2;
    }
    if (!findBinding(registry, profile)) {
      emit({ ok: false, code: "binding-not-found", message: `绑定 ${profile} 不存在` });
      return 2;
    }
    const updated = upsertPin(registry, { token, profile, updatedAt: new Date().toISOString() });
    await saveRegistry(updated, home);
    emit({ ok: true, pinned: token, profile });
    return 0;
  }
  const updated = { ...registry, pins: registry.pins.filter((p) => p.token !== opts.token) };
  await saveRegistry(updated, home);
  emit({ ok: true, removed: opts.token && findPin(registry, opts.token) ? opts.token : null });
  return 0;
}
