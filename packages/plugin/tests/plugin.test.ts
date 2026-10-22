import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, upsertBinding } from "@timeryu288/larklink-core";
import { saveRegistry } from "@timeryu288/larklink-cli/store";
import { apply, name, inject } from "../src/index.js";
import { LARKLINK_SKILL_MARKDOWN } from "../src/skill-content.js";
import type { LarkRunResult } from "@timeryu288/larklink-cli/larkcli";

let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  savedHome = process.env["LARKLINK_HOME"];
  home = await mkdtemp(join(tmpdir(), "larklink-plugin-"));
  process.env["LARKLINK_HOME"] = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["LARKLINK_HOME"];
  else process.env["LARKLINK_HOME"] = savedHome;
  await rm(home, { recursive: true, force: true });
});

function okResult(stdout = '{"ok":true}'): LarkRunResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 3, timedOut: false };
}

interface RegisteredTool {
  name: string;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

function fakeCtx() {
  const tools: RegisteredTool[] = [];
  let skillDef: { name: string; content: string } | null = null;
  const cleanups: Array<() => void> = [];
  const ctx = {
    tools: {
      register(tool: never) {
        const t = tool as unknown as RegisteredTool;
        tools.push(t);
        return () => {
          const i = tools.indexOf(t);
          if (i >= 0) tools.splice(i, 1);
        };
      },
    },
    get(service: string) {
      if (service !== "skills") return null;
      return {
        register(def: { name: string; content: string }) {
          skillDef = { name: def.name, content: def.content };
          return () => {
            skillDef = null;
          };
        },
      };
    },
    effect(fn: () => () => void) {
      cleanups.push(fn());
    },
  };
  return { ctx, tools, skill: () => skillDef, cleanup: () => cleanups.forEach((c) => c()) };
}

async function seedSolo() {
  let reg = createRegistry();
  reg = upsertBinding(reg, { profile: "solo", brand: "feishu", appId: "cli_1", status: "ready" });
  await saveRegistry(reg, home);
}

describe("插件：注册与契约", () => {
  it("导出 cordis 契约字段", () => {
    expect(name).toBe("@timeryu288/dsh-larklink");
    expect(inject).toEqual(["tools"]);
  });

  it("apply 注册 3 个工具 + 内嵌 SKILL；cleanup 全部注销", () => {
    const { ctx, tools, skill, cleanup } = fakeCtx();
    const calls: string[][] = [];
    apply(ctx, {}, { runner: (args) => { calls.push(args); return Promise.resolve(okResult()); } });
    expect(tools.map((t) => t.name).sort()).toEqual(["larklink_bindings", "larklink_exec", "larklink_resolve"]);
    const s = skill();
    expect(s?.name).toBe("larklink");
    expect(s?.content).toBe(LARKLINK_SKILL_MARKDOWN);
    expect(LARKLINK_SKILL_MARKDOWN).toContain("硬纪律");
    cleanup();
    expect(tools).toHaveLength(0);
    expect(skill()).toBeNull();
  });
});

describe("插件：工具执行（emit 缝 + 守卫链）", () => {
  it("larklink_resolve：唯一绑定 → resolved 信封", async () => {
    await seedSolo();
    const { ctx, tools } = fakeCtx();
    apply(ctx, { home }, { runner: (args) => { void args; return Promise.resolve(okResult()); } });
    const resolveTool = tools.find((t) => t.name === "larklink_resolve")!;
    const out = (await resolveTool.execute({ input: "https://x.feishu.cn/docx/Abc1", probe: false })) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    expect(out["profile"]).toBe("solo");
    expect(out["confidence"]).toBe("sole");
  });

  it("larklink_exec：白名单外拒绝；成功路径注入 --as user 与 --profile", async () => {
    await seedSolo();
    const calls: string[][] = [];
    const { ctx, tools } = fakeCtx();
    apply(ctx, { home }, { runner: (args) => { calls.push(args); return Promise.resolve(okResult()); } });
    const execTool = tools.find((t) => t.name === "larklink_exec")!;

    const rejected = (await execTool.execute({ args: ["im", "message", "send"], profile: "solo" })) as Record<string, unknown>;
    expect(rejected["code"]).toBe("domain-not-allowed");
    expect(calls).toHaveLength(0);

    const ok = (await execTool.execute({
      args: ["docs", "+fetch", "--doc", "https://x.feishu.cn/docx/Abc1"],
      url: "https://x.feishu.cn/docx/Abc1",
    })) as Record<string, unknown>;
    expect(ok["ok"]).toBe(true);
    expect(ok["status"]).toBe("success");
    expect(calls[0]).toEqual(["--profile", "solo", "docs", "+fetch", "--doc", "https://x.feishu.cn/docx/Abc1", "--as", "user"]);
  });

  it("larklink_exec：确认指纹重试路径（needs-confirmation → --yes+confirmationId）", async () => {
    await seedSolo();
    const results: LarkRunResult[] = [
      { exitCode: 10, stdout: "", stderr: JSON.stringify({ error: { type: "confirmation", action: "docs.update", risk: "high" } }), durationMs: 2, timedOut: false },
      okResult(),
    ];
    const calls: string[][] = [];
    const { ctx, tools } = fakeCtx();
    apply(ctx, { home }, { runner: (args) => { calls.push(args); return Promise.resolve(results.shift()!); } });
    const execTool = tools.find((t) => t.name === "larklink_exec")!;
    const rawArgs = ["docs", "+update", "--doc", "https://x.feishu.cn/docx/Abc1", "--content", "x"];

    const blocked = (await execTool.execute({ args: rawArgs, url: "https://x.feishu.cn/docx/Abc1" })) as Record<string, unknown>;
    expect(blocked["status"]).toBe("needs-confirmation");
    const confirmationId = blocked["confirmationId"] as string;

    const ok = (await execTool.execute({ args: rawArgs, url: "https://x.feishu.cn/docx/Abc1", yes: true, confirmationId })) as Record<string, unknown>;
    expect(ok["ok"]).toBe(true);
    expect(calls[1]!.includes("--yes")).toBe(true);
  });

  it("larklink_bindings：list 动作走 emit 缝返回信封", async () => {
    await seedSolo();
    const { ctx, tools } = fakeCtx();
    apply(ctx, { home }, { runner: () => Promise.resolve(okResult()) });
    const bindingsTool = tools.find((t) => t.name === "larklink_bindings")!;
    const out = (await bindingsTool.execute({ action: "list", fast: true })) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    expect((out["bindings"] as Array<{ profile: string }>)[0]!.profile).toBe("solo");
  });
});
