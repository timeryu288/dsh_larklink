/**
 * 审计日志（Q10-③：默认脱敏）。每行一个 JSON：resolve/exec 的决策与结果摘要。
 * 载荷参数（--content/--data 等）不记值，只记长度与 sha1；LARKLINK_AUDIT_VERBOSE=1 记全量。
 */
import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { auditPath, larklinkHome } from "./store.js";

export { auditPath };

/** 值即文档内容/记录数据的参数（Q10-③ 脱敏对象）。 */
export const PAYLOAD_FLAGS: readonly string[] = [
  "--content",
  "--data",
  "--body",
  "--markdown",
  "--html",
  "--text",
  "--payload",
  "--blocks",
];

export interface AuditEntry {
  /** 写入时自动填充。 */
  ts?: string;
  kind: "resolve" | "exec" | "bindings";
  profile?: string;
  domain?: string;
  target?: string;
  as?: "user" | "bot";
  outcome?: string;
  confidence?: string;
  durationMs?: number;
  argv?: string[];
  message?: string;
}

export function redactValue(value: string): string {
  const sha1 = createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
  return `<redacted len=${value.length} sha1=${sha1}>`;
}

export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  const verbose = process.env["LARKLINK_AUDIT_VERBOSE"] === "1";
  while (i < argv.length) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const bare = eq === -1 ? arg : arg.slice(0, eq);
    if (PAYLOAD_FLAGS.includes(bare)) {
      if (eq !== -1) {
        out.push(verbose ? arg : `${bare}=${redactValue(arg.slice(eq + 1))}`);
        i += 1;
      } else if (i + 1 < argv.length) {
        out.push(arg);
        out.push(verbose ? argv[i + 1]! : redactValue(argv[i + 1]!));
        i += 2;
      } else {
        out.push(arg);
        i += 1;
      }
    } else {
      out.push(arg);
      i += 1;
    }
  }
  return out;
}

/** 追加一条审计记录；审计关闭（LARKLINK_AUDIT=off）时静默跳过。 */
export async function appendAudit(entry: AuditEntry, home = larklinkHome()): Promise<void> {
  if (process.env["LARKLINK_AUDIT"] === "off") return;
  const record: AuditEntry = { ts: new Date().toISOString(), ...entry };
  if (record.argv !== undefined) record.argv = redactArgv(record.argv);
  await mkdir(home, { recursive: true });
  await appendFile(auditPath(home), JSON.stringify(record) + "\n", "utf8");
}
