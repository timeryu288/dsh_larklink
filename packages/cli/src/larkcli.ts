/**
 * lark-cli 子进程封装。所有 spawn 只走这里——命令一律 argv 数组，绝不安字符串拼接
 * （lark-shared 安全红线）。runner 以接口注入，测试用 mock 替换。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface LarkRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface LarkRunnerOptions {
  timeoutMs?: number;
  stdin?: string;
}

export type LarkRunner = (args: string[], opts?: LarkRunnerOptions) => Promise<LarkRunResult>;

/** 解析 lark-cli 可执行文件：env 覆盖 > PATH 上的原生 exe > npm 全局已知位置。Windows 只接受 .exe（shim 脚本无法被 spawn(shell:false) 执行）。 */
export function resolveLarkCli(): string {
  const envOverride = process.env["LARKLINK_LARK_CLI"];
  if (envOverride && envOverride.trim() !== "") return envOverride;

  const isWin = process.platform === "win32";
  const candidates: string[] = [];
  const pathDirs = (process.env["PATH"] ?? "").split(delimiter).filter((d) => d.trim() !== "");
  for (const dir of pathDirs) {
    if (isWin) candidates.push(join(dir, "lark-cli.exe"));
    else candidates.push(join(dir, "lark-cli"));
  }
  const home = process.env["USERPROFILE"] ?? process.env["HOME"];
  if (home) {
    candidates.push(
      join(home, ".npm-global", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe"),
    );
  }
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* existsSync 不抛，防御性忽略 */
    }
  }
  throw new Error(
    `找不到可执行的 lark-cli${isWin ? "（Windows 需要 lark-cli.exe 原生二进制）" : ""}：请安装 lark-cli（npm i -g @larksuite/cli）或设置 LARKLINK_LARK_CLI 指向其原生可执行路径`,
  );
}

/** 默认 runner：spawn 原生 exe，超时击杀并标记 timedOut（Q7：超时=结果未知）。 */
export const defaultLarkRunner: LarkRunner = (args, opts = {}) => {
  const bin = resolveLarkCli();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? -1 : (code ?? -1), stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
  });
};

/** lark-cli 输出信封解析：stdout JSON 优先，退回 stderr JSON（lark-shared：成功看 ok/exit 0，非 code==0）。 */
export function parseEnvelope(result: LarkRunResult): { ok: boolean; payload: unknown; error: unknown } {
  const out = safeJson(result.stdout);
  const err = safeJson(result.stderr);
  if (result.timedOut) return { ok: false, payload: out, error: { type: "timeout", message: "lark-cli 超时被击杀，服务端结果未知（Q7）" } };
  if (result.exitCode === 0 && out !== null) return { ok: true, payload: out, error: null };
  if (result.exitCode === 0) return { ok: true, payload: { raw: result.stdout }, error: null };
  return { ok: false, payload: out, error: err ?? { type: "unknown", message: result.stderr || result.stdout || `exit ${result.exitCode}` } };
}

export function safeJson(text: string): unknown {
  const t = text.trim();
  if (t === "") return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}

/** 从任意输出文本中提取授权/验证 URL（split-flow 展示用）。 */
export function extractVerificationUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s"']*?(?:verification|device|authorize|oauth)[^\s"']*/i);
  return m ? m[0]! : null;
}
