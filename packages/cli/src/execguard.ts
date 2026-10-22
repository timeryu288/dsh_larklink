/**
 * exec 守卫链（决议 Q5/Q6/Q7/Q9 落地）：
 *  - Q9：命令域白名单（文档域）
 *  - Q6：执行身份只能来自工具参数 as；argv 夹带 --as 一律拒绝
 *  - Q5：argv 提取目标与路由结果比对，不一致即拒；未识别形态放行（fail-open）
 *  - Q6-②：confirmationId = profile+as+argv 指纹；--yes 重试必须携带一致指纹
 */
import { createHash } from "node:crypto";
import { parseDoc } from "@timeryu288/larklink-core";
import type { ParsedDoc } from "@timeryu288/larklink-core";

/** Q9-①：v1 仅文档域。 */
export const EXEC_DOMAINS: ReadonlySet<string> = new Set([
  "docs",
  "drive",
  "sheets",
  "markdown",
  "slides",
  "base",
  "whiteboard",
  "wiki",
  "mindnotes",
]);

/** Q5-①：从 argv 提取目标文档的白名单旗标（fail-open：未收录旗标不比对）。 */
export const TARGET_FLAGS: readonly string[] = ["--doc", "--url", "--file", "--token"];

export interface GuardError {
  code:
    | "domain-not-allowed"
    | "argv-as-forbidden"
    | "target-mismatch"
    | "confirmation-id-required"
    | "confirmation-id-mismatch";
  message: string;
}

export function domainOf(argv: readonly string[]): string {
  return (argv[0] ?? "").replace(/^:+/, "");
}

/** argv 中出现 --as / --as=... → 拒绝（显式声明唯一入口是工具参数 as）。 */
export function findArgvAs(argv: readonly string[]): { value: string; index: number } | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--as") return { value: argv[i + 1] ?? "", index: i };
    if (a.startsWith("--as=")) return { value: a.slice(5), index: i };
  }
  return null;
}

export function extractTargets(argv: readonly string[]): Array<{ flag: string; value: string }> {
  const out: Array<{ flag: string; value: string }> = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const bare = eq === -1 ? a : a.slice(0, eq);
    if (TARGET_FLAGS.includes(bare)) {
      if (eq !== -1) out.push({ flag: bare, value: a.slice(eq + 1) });
      else if (i + 1 < argv.length) out.push({ flag: bare, value: argv[i + 1]! });
    }
  }
  return out;
}

/**
 * Q5-① 目标一致性：能解析出的目标 token 与路由 token 全量比对。
 * 解析不出 token 的目标值放行（fail-open，M3 扩白名单）。
 */
export function checkTargets(
  targets: ReadonlyArray<{ flag: string; value: string }>,
  resolved: ParsedDoc,
): { ok: true } | { ok: false; error: GuardError } {
  for (const t of targets) {
    if (t.value === resolved.token || t.value === resolved.input) continue;
    const p = parseDoc(t.value);
    if (p.token === "" ) continue; // 未识别形态：放行（fail-open）
    if (p.token !== resolved.token) {
      return {
        ok: false,
        error: {
          code: "target-mismatch",
          message: `argv ${t.flag} 的目标与路由结果不符：路由=${resolved.input}（token ${resolved.token}），命令指向 ${t.value}（token ${p.token}）。拒绝执行，防错账写入。`,
        },
      };
    }
  }
  return { ok: true };
}

/** Q6-② 确认指纹：覆盖 profile + 执行身份 + 去除确认旗标后的最终 argv。 */
export function computeConfirmationId(profile: string, as: "user" | "bot", argv: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ profile, as, argv }), "utf8")
    .digest("hex")
    .slice(0, 32);
}
