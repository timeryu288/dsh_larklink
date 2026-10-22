/**
 * resolve 命令：core 消歧 + Q4 只读探测（标注不代选）+ pin 写入。
 */
import { parseDoc, resolve, upsertPin, type Candidate } from "@timeryu288/larklink-core";
import type { LarkRunner } from "../larkcli.js";
import { safeJson } from "../larkcli.js";
import { loadRegistry, larklinkHome, saveRegistry } from "../store.js";
import { appendAudit } from "../audit.js";

export interface ResolveOptions {
  input: string;
  explicitProfile?: string;
  askedProfile?: string;
  /** 用户对歧义询问的回答同时记 pin（Q3-③）。 */
  pin?: boolean;
  /** Q4：默认对歧义候选做只读探测；--no-probe 跳过。 */
  probe?: boolean;
  probeTimeoutMs?: number;
}

export type ProbeStatus = "accessible" | "no-permission" | "auth-failed" | "timeout" | "error";

export interface ProbedCandidate extends Candidate {
  probe?: ProbeStatus;
}

/** 只读探测（Q4：8s 超时，真实 API 调用会留租户审计痕迹；永不影响选择）。 */
export function classifyProbe(
  result: { exitCode: number; stdout: string; stderr: string; timedOut: boolean },
): ProbeStatus {
  if (result.timedOut) return "timeout";
  if (result.exitCode === 0) return "accessible";
  const raw = (safeJson(result.stderr) ?? safeJson(result.stdout)) as
    | { error?: { type?: string; code?: number; message?: string }; type?: string; code?: number; message?: string }
    | null;
  const err = raw?.error ?? raw;
  const text = `${err?.type ?? ""} ${err?.message ?? ""} ${result.stderr}`.toLowerCase();
  if (err?.code === 403 || text.includes("permission") || text.includes("forbidden")) return "no-permission";
  if (text.includes("auth") || text.includes("token") || text.includes("login")) return "auth-failed";
  return "error";
}

export async function probeCandidate(
  runner: LarkRunner,
  input: string,
  profile: string,
  timeoutMs = 8_000,
): Promise<ProbeStatus> {
  const res = await runner(["--profile", profile, "drive", "+inspect", "--url", input, "--json"], { timeoutMs });
  return classifyProbe(res);
}

export async function cmdResolve(runner: LarkRunner, opts: ResolveOptions, home = larklinkHome()): Promise<number> {
  let registry = await loadRegistry(home);
  const result = resolve(registry, opts.input, {
    explicitProfile: opts.explicitProfile,
    askedProfile: opts.askedProfile,
  });

  if (result.status === "ambiguous") {
    let candidates: ProbedCandidate[] = result.candidates;
    if (opts.probe !== false) {
      const probed = await Promise.all(
        result.candidates.map(async (c) => {
          try {
            return { ...c, probe: await probeCandidate(runner, opts.input, c.profile, opts.probeTimeoutMs) } satisfies ProbedCandidate;
          } catch {
            return { ...c, probe: "error" as ProbeStatus } satisfies ProbedCandidate;
          }
        }),
      );
      candidates = probed;
    }
    await appendAudit({ kind: "resolve", outcome: "ambiguous", confidence: "none", target: result.parsed.token, argv: [opts.input], message: `候选：${candidates.map((c) => c.profile).join(", ")}` }, home);
    console.log(JSON.stringify({
      ok: true,
      status: "ambiguous",
      parsed: result.parsed,
      candidates,
      reason: result.reason,
      next: `询问用户后：larklink resolve <input> --asked <profile> --pin`,
    }, null, 2));
    return 3;
  }

  if (opts.pin && (result.confidence === "asked" || result.confidence === "explicit")) {
    registry = upsertPin(registry, {
      token: result.parsed.token,
      profile: result.profile,
      updatedAt: new Date().toISOString(),
    });
    await saveRegistry(registry, home);
  }
  await appendAudit({
    kind: "resolve",
    outcome: "resolved",
    confidence: result.confidence,
    profile: result.profile,
    target: result.parsed.token,
    argv: [opts.input],
  }, home);
  console.log(JSON.stringify({
    ok: true,
    status: "resolved",
    profile: result.profile,
    brand: result.brand,
    confidence: result.confidence,
    bindingStatus: result.bindingStatus,
    reason: result.reason,
    parsed: result.parsed,
    wikiUnwrapNeeded: result.parsed.wikiUnwrapNeeded,
    pinned: opts.pin === true,
  }, null, 2));
  return 0;
}

export { parseDoc };
