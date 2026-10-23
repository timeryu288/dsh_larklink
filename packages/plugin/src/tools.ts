/**
 * larklink 工具注册：三个模型可见工具，全部薄适配到 CLI 命令函数（同一执行引擎）。
 * 信封经 emit 缝捕获后作为工具结果返回。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { cmdResolve } from "@timeryu288/larklink-cli/commands/resolve";
import { cmdExec } from "@timeryu288/larklink-cli/commands/exec";
import { cmdAdopt, cmdAuth, cmdList, cmdPin, type Emit } from "@timeryu288/larklink-cli/commands/bindings";

/** 结构等价于 cli 层 LarkRunner（dts 打包不透传子路径类型，故本地声明）。 */
export interface LarkRunnerLike {
  (args: string[], opts?: { timeoutMs?: number; stdin?: string; cwd?: string }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
  }>;
}

export interface LarklinkToolConfig {
  home?: string;
  execTimeoutMs?: number;
  probeTimeoutMs?: number;
}

interface ToolService {
  register(tool: unknown): unknown;
}

/** defineTool 泛型按字面量收窄过严（动态 spec 推断为 never）；宽松壳仅放宽类型，运行时原样。 */
const defineToolLoose = defineTool as unknown as (spec: Record<string, unknown>) => unknown;

/** 捕获 emit 信封（工具结果）。 */
function capture(): { emit: Emit; payload: () => unknown } {
  let value: unknown;
  const emit: Emit = (p) => {
    value = p;
  };
  return { emit, payload: () => value };
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${field} 必须是字符串数组（lark-cli 命令参数，逐个元素）`);
  }
  return value as string[];
}

export function registerLarklinkTools(deps: {
  ctx: { tools: ToolService };
  runner: LarkRunnerLike;
  config: LarklinkToolConfig;
}): Array<() => void> {
  const { ctx, runner, config } = deps;
  const home = config.home;
  const disposers: Array<() => void> = [];

  const register = (spec: Record<string, unknown>): void => {
    const dispose = ctx.tools.register(
      defineToolLoose({
        output: {
          schema: { type: "object", additionalProperties: true, description: "larklink JSON envelope" },
          render: (_args: unknown, value: unknown) => [
            { type: "text", text: JSON.stringify(value, null, 2) },
          ],
        },
        ...spec,
      }),
    );
    disposers.push(typeof dispose === "function" ? (dispose as () => void) : () => {});
  };

  register({
    name: "larklink_resolve",
        description:
      "Resolve which lark/feishu account (binding) should operate on a document URL or bare token, and manage lark-cli login lifecycle. Use PROACTIVELY whenever the user mentions a feishu.cn / larksuite.com / larkoffice.com / doubao.com document link or a bare token (doxcn/shtcn/wikcn/bascn/...), or when any lark-cli/larklink operation reports auth failure, token expiry, or not-logged-in — regardless of how many bindings exist. Returns the routing decision (profile, confidence, brand) or an ambiguous candidate list with read-only probe annotations (accessible / no-permission / auth-failed / timeout). Never auto-picks among multiple candidates — ask the user.",
        parameters: {
          input: { type: "string", required: true, description: "Document URL or bare token (doxcn/shtcn/wikcn/bascn/...)" },
          explicitProfile: { type: "string", description: "User explicitly named the binding to use this turn." },
          askedProfile: { type: "string", description: "The user's answer to an ambiguity question (records confidence=asked)." },
          pin: { type: "boolean", description: "Remember the asked/explicit choice for this document token (document-level preference)." },
          probe: { type: "boolean", description: "Read-only probe of ambiguous candidates via drive +inspect (default true)." },
        },
        async execute(args: Record<string, unknown>) {
          const cap = capture();
          await cmdResolve(
            runner,
            {
              input: String(args["input"]),
              explicitProfile: args["explicitProfile"] !== undefined ? String(args["explicitProfile"]) : undefined,
              askedProfile: args["askedProfile"] !== undefined ? String(args["askedProfile"]) : undefined,
              pin: args["pin"] === true,
              probe: args["probe"] !== false,
              probeTimeoutMs: config.probeTimeoutMs,
            },
            home,
            cap.emit,
          );
          return cap.payload();
        },
  });

  register({
    name: "larklink_exec",
        description:
          "Execute a guarded lark-cli document-domain command (docs/drive/sheets/markdown/slides/base/whiteboard/wiki/mindnotes) as the resolved or explicitly named binding. Use for every feishu/lark document read/write operation (single OR multiple bindings). Enforces: target consistency vs routing, no --as smuggling (use the as param), exit-10 confirmation fingerprint binding, timeout-unknown reporting. Prefer larklink_resolve first. On binding-needs-repair, run larklink_bindings auth-start immediately instead of asking the user to use a terminal.",
        parameters: {
          args: { type: "array", items: { type: "string" }, required: true, description: "lark-cli command after the profile flag, e.g. [\"docs\",\"+update\",\"--doc\",\"<url>\",\"--content\",\"…\"]" },
          url: { type: "string", description: "Document URL/token being operated on (enables routing + target guard)." },
          profile: { type: "string", description: "Explicit binding name (skips routing)." },
          as: { type: "string", enum: ["user", "bot"], description: "Execution identity; default user; bot requires explicit user request." },
          yes: { type: "boolean", description: "Confirmed retry after needs-confirmation; must carry the matching confirmationId." },
          confirmationId: { type: "string", description: "The confirmationId from the needs-confirmation envelope." },
          dryRun: { type: "boolean", description: "Return the final argv without touching lark-cli." },
        },
        async execute(args: Record<string, unknown>) {
          const cap = capture();
          await cmdExec(
            runner,
            {
              rawArgs: asStringArray(args["args"], "args"),
              url: args["url"] !== undefined ? String(args["url"]) : undefined,
              profile: args["profile"] !== undefined ? String(args["profile"]) : undefined,
              as: args["as"] === "bot" ? "bot" : "user",
              yes: args["yes"] === true,
              confirmationId: args["confirmationId"] !== undefined ? String(args["confirmationId"]) : undefined,
              dryRun: args["dryRun"] === true,
              timeoutMs: config.execTimeoutMs,
            },
            home,
            cap.emit,
          );
          return cap.payload();
        },
  });

  register({
    name: "larklink_bindings",
        description:
          "Binding management and lark-cli login lifecycle. Actions: adopt existing lark-cli profiles as larklink bindings; list bindings with live status; health sync (also cleans dead pins); manage document pins; auth-start initiates the QR login flow for a binding (auto-opens the browser, returns verification URL + QR code path; run it IMMEDIATELY whenever resolve/exec reports binding-needs-repair, auth-failed, needs_refresh, unauthorized, or incomplete — do not send the user to a terminal); auth-complete finishes login after the user confirms in the browser (device code is stashed server-side; no code needed). Only adding new apps (app secret via stdin) and removing bindings stay in the user's terminal (larklink bindings add|remove).",
        parameters: {
          action: {
            type: "string",
            required: true,
            enum: ["adopt", "list", "health", "pin-add", "pin-remove", "pin-list", "auth-start", "auth-complete"],
            description: "Management action.",
          },
          profile: { type: "string", description: "Binding profile name (adopt filter / pin target / auth-start & auth-complete target)." },
          token: { type: "string", description: "Document token for pin-add / pin-remove." },
          fast: { type: "boolean", description: "list: skip live status verification." },
          domain: { type: "string", description: "auth-start: lark-cli scope domains, comma-separated (default docs)." },
          open: { type: "boolean", description: "auth-start: open the browser at the verification URL (default true)." },
        },
        async execute(args: Record<string, unknown>) {
          const cap = capture();
          const action = String(args["action"]);
          const profile = args["profile"] !== undefined ? String(args["profile"]) : undefined;
          switch (action) {
            case "adopt":
              await cmdAdopt({ runner, home }, { profiles: profile ? [profile] : undefined }, cap.emit);
              break;
            case "list":
            case "health":
              await cmdList({ runner, home }, { fast: args["fast"] === true, health: action === "health" }, cap.emit);
              break;
            case "pin-add":
            case "pin-remove": {
              const token = args["token"];
              if (token === undefined || profile === undefined) throw new Error("pin-add / pin-remove 需要 token 与 profile");
              await cmdPin({ op: action === "pin-add" ? "add" : "remove", token: String(token), profile }, home, cap.emit);
              break;
            }
            case "pin-list":
              await cmdPin({ op: "list" }, home, cap.emit);
              break;
            case "auth-start":
            case "auth-complete": {
              if (profile === undefined) throw new Error(`${action} 需要 profile`);
              await cmdAuth(
                { runner, home },
                {
                  profile,
                  domain: args["domain"] !== undefined ? String(args["domain"]) : undefined,
                  complete: action === "auth-complete",
                  open: args["open"] !== false,
                },
                cap.emit,
              );
              break;
            }
            default:
              throw new Error(`未知 action: ${action}`);
          }
          return cap.payload();
        },
  });

  return disposers;
}
