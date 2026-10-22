/**
 * exec 命令：守卫链 + 信封透传（决议 Q5/Q6/Q7/Q9 全量落地）。
 * 退出码：0 成功 | 1 lark-cli 业务错误 | 2 larklink 守卫/路由错误 | 3 歧义待选择
 *        | 10 needsConfirmation（镜像 lark-cli） | 11 timeout-unknown
 */
import { findBinding, resolve } from "@timeryu288/larklink-core";
import { parseEnvelope, type LarkRunner } from "../larkcli.js";
import { safeJson } from "../larkcli.js";
import { loadRegistry, larklinkHome } from "../store.js";
import { appendAudit } from "../audit.js";
import { EXEC_DOMAINS, checkTargets, computeConfirmationId, domainOf, extractTargets, findArgvAs } from "../execguard.js";
import type { Emit } from "./bindings.js";
import { stdEmit } from "./bindings.js";

export interface ExecOptions {
  profile?: string;
  url?: string;
  as?: "user" | "bot";
  dryRun?: boolean;
  yes?: boolean;
  confirmationId?: string;
  timeoutMs?: number;
  /** `--` 之后的原样命令参数。 */
  rawArgs: string[];
}

export async function cmdExec(runner: LarkRunner, opts: ExecOptions, home = larklinkHome(), emit: Emit = stdEmit): Promise<number> {
  const fail = (code: string, message: string, extra?: Record<string, unknown>): number => {
    emit({ ok: false, code, message, ...extra }, null, 2);
    return 2;
  };
  const rawArgs = opts.rawArgs;
  if (rawArgs.length === 0) return fail("usage", "缺少命令：exec -- <lark-cli 命令参数…>");

  // Q9：域白名单
  const domain = domainOf(rawArgs);
  if (!EXEC_DOMAINS.has(domain)) {
    return fail(
      "domain-not-allowed",
      `域 "${domain}" 不在文档域白名单（Q9-①）：${[...EXEC_DOMAINS].join(", ")}。其他域请直接使用 lark-cli。`,
    );
  }

  // Q6-①：argv 夹带 --as 一律拒绝（显式声明唯一入口是本命令的 --as 参数）
  const argvAs = findArgvAs(rawArgs);
  if (argvAs !== null) {
    return fail("argv-as-forbidden", `argv 中的 --as（${argvAs.value || "…"}）被拒绝：执行身份只能用 exec 的 --as 参数显式声明（Q6-①）`);
  }
  const as: "user" | "bot" = opts.as ?? "user";

  // 路由（Q5-③：用最新 registry 重路由，不信任调用方快照）
  const registry = await loadRegistry(home);
  let profile: string;
  let confidence: string | undefined;
  let routedToken: string | null = null;
  if (opts.url !== undefined) {
    try {
      const result = resolve(registry, opts.url, { explicitProfile: opts.profile });
      if (result.status === "ambiguous") {
        emit({ ok: false, code: "ambiguous", message: result.reason, candidates: result.candidates, parsed: result.parsed, next: "larklink resolve 后用 --profile 显式指定" }, null, 2);        return 3;
      }
      profile = result.profile;
      confidence = result.confidence;
      routedToken = result.parsed.token;
      if (result.bindingStatus !== "ready") {
        // Q1：不换绑定，提示修复
        await appendAudit({ kind: "exec", profile, outcome: "blocked-auth", confidence, domain, as }, home);
        emit({ ok: false, code: "binding-needs-repair", profile, bindingStatus: result.bindingStatus, message: `绑定 ${profile} 状态 ${result.bindingStatus}，请 larklink bindings auth ${profile} 修复后重试（不自动换绑定，Q1）` }, null, 2);
        return 2;
      }
    } catch (e) {
      const err = e as { code?: string; message?: string };
      emit({ ok: false, code: err.code ?? "resolve-error", message: err.message }, null, 2);
      return 2;
    }
  } else if (opts.profile !== undefined) {
    const binding = findBinding(registry, opts.profile);
    if (!binding) return fail("binding-not-found", `绑定 ${opts.profile} 不存在`);
    if (binding.status === "incomplete") return fail("binding-incomplete", `绑定 ${opts.profile} 授权未完成（Q8）`);
    profile = opts.profile;
    confidence = "explicit";
  } else {
    return fail("usage", "需要 --url（自动路由）或 --profile（显式指定）之一");
  }

  // Q5-①：目标一致性（只在路由发生时比对；未识别旗标 fail-open）
  if (routedToken !== null) {
    const targets = extractTargets(rawArgs);
    const parsed = (await import("@timeryu288/larklink-core")).parseDoc(opts.url!);
    const check = checkTargets(targets, parsed);
    if (!check.ok) {
      await appendAudit({ kind: "exec", profile, outcome: "blocked-target-mismatch", confidence, domain, as, argv: rawArgs }, home);
      emit({ ok: false, code: check.error.code, message: check.error.message }, null, 2);
      return 2;
    }
  }

  // Q6-②：确认指纹。首次调用（无 --yes）在 exit 10 时下发 confirmationId；
  // 带 --yes 的重试必须携带一致指纹，确认不可挪用。
  const confirmationId = computeConfirmationId(profile, as, rawArgs);
  if (opts.yes === true) {
    if (!opts.confirmationId) {
      return fail("confirmation-id-required", "--yes 必须携带首次 needsConfirmation 返回的 --confirmation-id（Q6-②）");
    }
    if (opts.confirmationId !== confirmationId) {
      return fail("confirmation-id-mismatch", `确认指纹不符：本次命令与用户确认的不是同一条请求（期望 ${confirmationId}，收到 ${opts.confirmationId}）。确认不可挪用。`);
    }
  }

  const finalArgv = ["--profile", profile, ...rawArgs, "--as", as, ...(opts.yes ? ["--yes"] : [])];

  if (opts.dryRun) {
    emit({ ok: true, status: "dry-run", profile, confidence, as, argv: finalArgv, confirmationId }, null, 2);
    return 0;
  }

  const result = await runner(finalArgv, { timeoutMs: opts.timeoutMs });
  const envelope = parseEnvelope(result);
  const errObj = (envelope.error ?? {}) as { type?: string };
  const isConfirmation = result.exitCode === 10 || errObj["type"] === "confirmation";

  let status: string;
  let exit: number;
  if (result.timedOut) {
    status = "timeout-unknown";
    exit = 11;
  } else if (isConfirmation && opts.yes !== true) {
    status = "needs-confirmation";
    exit = 10;
  } else if (envelope.ok) {
    status = "success";
    exit = 0;
  } else {
    status = "error";
    exit = 1;
  }

  await appendAudit({ kind: "exec", profile, confidence, domain, as, outcome: status, durationMs: result.durationMs, argv: finalArgv }, home);

  const out: Record<string, unknown> = {
    ok: status === "success",
    status,
    profile,
    confidence,
    as,
    argv: finalArgv,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    result: envelope.payload ?? safeJson(result.stdout),
    error: envelope.error,
  };
  if (status === "needs-confirmation") {
    out["confirmationId"] = confirmationId;
    out["next"] = `用户同意后：原命令 + --yes --confirmation-id ${confirmationId}`;
    out["message"] = "高风险操作需用户确认（exit 10 门禁透传）。用户看到的就是这条 argv，同意的也是它。";
  }
  if (status === "timeout-unknown") {
    out["message"] = "超时被击杀，服务端结果未知（Q7）：禁止直接重试同 argv；先只读核查（如 drive +inspect）确认实际状态。";
  }
  emit(out, null, 2);
  return exit;
}
