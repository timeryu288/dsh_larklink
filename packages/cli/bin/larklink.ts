#!/usr/bin/env node
/**
 * larklink CLI 入口（M2）。无外部依赖，手写参数解析。
 * 用法：
 *   larklink bindings adopt [--profile <名>]…
 *   larklink bindings add --name <名> --brand <feishu|lark> --app-id <id> --app-secret-stdin
 *   larklink bindings auth <profile> [--domain docs] [--device-code <code>]
 *   larklink bindings list [--fast] | health
 *   larklink bindings remove <profile> [--purge|--keep-profile] --yes
 *   larklink bindings pin add <token> <profile> | remove <token> | list
 *   larklink resolve <url|token> [--explicit <p>|--asked <p>] [--pin] [--no-probe]
 *   larklink exec (--url <u>|--profile <p>) [--as user|bot] [--dry-run] [--yes --confirmation-id <id>] -- <lark-cli 命令…>
 */
import { readFileSync } from "node:fs";
import { defaultLarkRunner } from "../src/larkcli.js";
import { larklinkHome } from "../src/store.js";
import { cmdAdd, cmdAdopt, cmdAuth, cmdList, cmdPin, cmdRemove, type BindingsCtx } from "../src/commands/bindings.js";
import { cmdResolve } from "../src/commands/resolve.js";
import { cmdExec } from "../src/commands/exec.js";

/** 把 ["--name","x","--yes"] 解析为 {name:"x", yes:true, _: [...]}。 */
function parseFlags(tokens: string[], valueFlags: ReadonlySet<string>): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      if (valueFlags.has(key) && i + 1 < tokens.length) {
        flags[key] = tokens[i + 1]!;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(t);
    }
  }
  return { flags, rest };
}

function usage(): void {
  console.log(`larklink —— 多账号 lark-cli 路由与守卫（docs/design.md）

  larklink bindings adopt [--profile <名>]…        导入既有 lark-cli profile（Q8）
  larklink bindings add --name N --brand B --app-id ID --app-secret-stdin
  larklink bindings auth <profile> [--domain docs] [--device-code CODE]
  larklink bindings list [--fast] / health
  larklink bindings remove <profile> [--purge|--keep-profile] --yes
  larklink bindings pin add|remove|list
  larklink resolve <url|token> [--explicit P|--asked P] [--pin] [--no-probe]
  larklink exec (--url U|--profile P) [--as user|bot] [--dry-run]
                [--yes --confirmation-id ID] [--timeout MS] -- <lark-cli 命令…>

环境：LARKLINK_HOME（默认 ~/.larklink）、LARKLINK_LARK_CLI、LARKLINK_AUDIT=off、LARKLINK_AUDIT_VERBOSE=1`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const home = larklinkHome();
  const ctx: BindingsCtx = { runner: defaultLarkRunner, home };

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    return 0;
  }

  if (cmd === "resolve") {
    const { flags, rest } = parseFlags(argv.slice(1), new Set(["explicit", "asked", "probe-timeout"]));
    const input = rest[0];
    if (!input) {
      console.log(JSON.stringify({ ok: false, code: "usage", message: "larklink resolve <url|token>" }));
      return 2;
    }
    return cmdResolve(ctx.runner, {
      input,
      explicitProfile: typeof flags["explicit"] === "string" ? flags["explicit"] : undefined,
      askedProfile: typeof flags["asked"] === "string" ? flags["asked"] : undefined,
      pin: flags["pin"] === true,
      probe: flags["no-probe"] !== true,
      probeTimeoutMs: typeof flags["probe-timeout"] === "string" ? Number(flags["probe-timeout"]) : undefined,
    }, home);
  }

  if (cmd === "exec") {
    const dashdash = argv.indexOf("--");
    const flagPart = dashdash === -1 ? argv.slice(1) : argv.slice(1, dashdash);
    const rawArgs = dashdash === -1 ? [] : argv.slice(dashdash + 1);
    const { flags } = parseFlags(flagPart, new Set(["url", "profile", "as", "confirmation-id", "timeout"]));
    const as = flags["as"] === "bot" ? "bot" : flags["as"] === "user" ? "user" : undefined;
    return cmdExec(ctx.runner, {
      url: typeof flags["url"] === "string" ? flags["url"] : undefined,
      profile: typeof flags["profile"] === "string" ? flags["profile"] : undefined,
      as,
      dryRun: flags["dry-run"] === true,
      yes: flags["yes"] === true,
      confirmationId: typeof flags["confirmation-id"] === "string" ? flags["confirmation-id"] : undefined,
      timeoutMs: typeof flags["timeout"] === "string" ? Number(flags["timeout"]) : undefined,
      rawArgs,
    }, home);
  }

  if (cmd === "bindings") {
    const sub = argv[1];
    const tokens = argv.slice(2);
    if (sub === "adopt") {
      const { flags, rest } = parseFlags(tokens, new Set(["profile"]));
      const profiles = (typeof flags["profile"] === "string" ? [flags["profile"]] : rest.length > 0 ? rest : undefined);
      return cmdAdopt(ctx, { profiles });
    }
    if (sub === "add") {
      const { flags } = parseFlags(tokens, new Set(["name", "brand", "app-id"]));
      const name = flags["name"], brand = flags["brand"], appId = flags["app-id"];
      if (typeof name !== "string" || typeof appId !== "string" || (brand !== "feishu" && brand !== "lark")) {
        console.log(JSON.stringify({ ok: false, code: "usage", message: "需要 --name、--brand feishu|lark、--app-id，且 --app-secret-stdin 从 stdin 读密钥" }));
        return 2;
      }
      if (flags["app-secret-stdin"] !== true) {
        console.log(JSON.stringify({ ok: false, code: "usage", message: "app secret 必须经 --app-secret-stdin 从 stdin 传入（不落 argv，不落审计）" }));
        return 2;
      }
      const secret = readFileSync(process.stdin.fd, "utf8").trim();
      if (!secret) {
        console.log(JSON.stringify({ ok: false, code: "usage", message: "stdin 为空：echo <app_secret> | larklink bindings add …" }));
        return 2;
      }
      return cmdAdd(ctx, { name, brand, appId, appSecret: secret });
    }
    if (sub === "auth") {
      const { flags, rest } = parseFlags(tokens, new Set(["domain", "device-code"]));
      const profile = rest[0];
      if (!profile) {
        console.log(JSON.stringify({ ok: false, code: "usage", message: "larklink bindings auth <profile> [--domain docs] [--device-code CODE]" }));
        return 2;
      }
      return cmdAuth(ctx, {
        profile,
        domain: typeof flags["domain"] === "string" ? flags["domain"] : undefined,
        deviceCode: typeof flags["device-code"] === "string" ? flags["device-code"] : undefined,
      });
    }
    if (sub === "list" || sub === "health") {
      const { flags } = parseFlags(tokens, new Set());
      return cmdList(ctx, { fast: flags["fast"] === true, health: sub === "health" });
    }
    if (sub === "remove") {
      const { flags, rest } = parseFlags(tokens, new Set());
      const profile = rest[0];
      if (!profile) {
        console.log(JSON.stringify({ ok: false, code: "usage", message: "larklink bindings remove <profile> --yes" }));
        return 2;
      }
      return cmdRemove(ctx, {
        profile,
        purge: flags["purge"] === true,
        keepProfile: flags["keep-profile"] === true,
        yes: flags["yes"] === true,
      });
    }
    if (sub === "pin") {
      const op = tokens[0] as "add" | "remove" | "list";
      const { rest } = parseFlags(tokens.slice(1), new Set());
      if (op === "list") return cmdPin({ op }, home);
      const token = rest[0], profile = rest[1];
      if (!token || !profile) {
        console.log(JSON.stringify({ ok: false, code: "usage", message: "larklink bindings pin add <token> <profile> | remove <token> | list" }));
        return 2;
      }
      return cmdPin({ op, token, profile }, home);
    }
    console.log(JSON.stringify({ ok: false, code: "usage", message: `未知子命令 bindings ${sub ?? ""}` }));
    return 2;
  }

  console.log(JSON.stringify({ ok: false, code: "usage", message: `未知命令 ${cmd}` }));
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.log(JSON.stringify({ ok: false, code: "internal", message: (e as Error).message }));
    process.exitCode = 2;
  },
);
