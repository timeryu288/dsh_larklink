import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, upsertBinding } from "@timeryu288/larklink-core";
import { saveRegistry } from "@timeryu288/larklink-cli/store";
import { apply, name, inject } from "../src/index.js";

/** 测试侧宽松入口（假 ctx 结构宽于 PluginCtx，运行时一致）。 */
const applyTo = (ctx: unknown, config: Record<string, unknown> = {}, options: Record<string, unknown> = {}): void =>
  apply(ctx as never, config as never, options as never);
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
  output?: { render(args: Record<string, unknown>, value: unknown): unknown };
}

function fakeCtx() {
  const tools: RegisteredTool[] = [];
  let skillDef: { name: string; content: string } | null = null;
  const cleanups: Array<() => void> = [];
  const routes: Array<{ kind: string; path: string; handler: (req: FakeReq, res: FakeRes) => void }> = [];
  const webServer = {
    register(route: { kind: string; path: string; handler: (req: FakeReq, res: FakeRes) => void }) {
      routes.push(route);
      return () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  };
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
    get(service: string): unknown {
      if (service === "skills") {
        return {
          register(def: { name: string; content: string }): () => void {
            skillDef = { name: def.name, content: def.content };
            return () => {
              skillDef = null;
            };
          },
        };
      }
      if (service === "webServer") return webServer;
      return null;
    },
    inject(_services: string[], fn: (injected: { get(name: string): unknown }) => (() => void) | void) {
      const dispose = fn({ get: (name: string) => (name === "webServer" ? webServer : null) });
      if (typeof dispose === "function") cleanups.push(dispose);
      return () => {};
    },
    effect(fn: () => () => void) {
      cleanups.push(fn());
    },
  };
  return { ctx, tools, routes, skill: () => skillDef, cleanup: () => cleanups.forEach((c) => c()) };
}

interface FakeReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  on(event: string, cb: (chunk?: Buffer) => void): void;
}

interface FakeRes {
  status: number;
  body: string;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function fakeReq(method: string, path: string, headers: Record<string, string> = {}, body = ""): FakeReq {
  return {
    method,
    url: path,
    headers,
    on(event, cb) {
      if (event === "data" && body !== "") setTimeout(() => cb(Buffer.from(body)), 0);
      if (event === "end") setTimeout(() => cb(), 0);
    },
  };
}

function waitFor(res: FakeRes, ms = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (res.status !== 0) resolve();
      else if (Date.now() - start > ms) reject(new Error("route handler 超时未响应"));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

function fakeRes(): FakeRes {
  const res = {
    status: 0,
    body: "",
    writeHead(status: number) {
      res.status = status;
    },
    end(body?: string) {
      res.body = body ?? "";
    },
  };
  return res;
}

async function seedSolo() {
  let reg = createRegistry();
  reg = upsertBinding(reg, { profile: "solo", brand: "feishu", appId: "cli_1", status: "ready" });
  await saveRegistry(reg, home);
}

describe("插件：注册与契约", () => {
  it("导出 cordis 契约字段", () => {
    expect(name).toBe("@timeryu/dsh-larklink");
    expect(inject).toEqual(["tools"]);
  });

  it("apply 注册 3 个工具 + 内嵌 SKILL；cleanup 全部注销", () => {
    const { ctx, tools, skill, cleanup } = fakeCtx();
    const calls: string[][] = [];
    applyTo(ctx, {}, { runner: (args: string[]) => { calls.push(args); return Promise.resolve(okResult()); } });
    expect(tools.map((t) => t.name).sort()).toEqual(["larklink_bindings", "larklink_exec", "larklink_resolve"]);
    const s = skill();
    expect(s?.name).toBe("larklink");
    expect(s?.content).toBe(LARKLINK_SKILL_MARKDOWN);
    expect(LARKLINK_SKILL_MARKDOWN).toContain("硬纪律");
    // host 契约：render 必须返回内容块数组（[{type:"text",text}]），否则 result.content.some 崩溃
    const t = tools.find((x) => x.name === "larklink_bindings")!;
    const rendered = t.output!.render({}, { ok: true, bindings: [] });
    expect(Array.isArray(rendered)).toBe(true);
    expect((rendered as Array<{ type: string; text: string }>)[0]!.type).toBe("text");
    expect(JSON.parse((rendered as Array<{ text: string }>)[0]!.text)).toMatchObject({ ok: true });
    cleanup();
    expect(tools).toHaveLength(0);
    expect(skill()).toBeNull();
  });
});

describe("插件：genui 后端路由", () => {
  it("GET /larklink/bindings 返回 registry 信封；POST adopt 导入；跨源 403", async () => {
    await seedSolo();
    const calls: string[][] = [];
    const { ctx, routes, cleanup } = fakeCtx();
    applyTo(ctx, { home }, {
      runner: (args: string[]) => {
        calls.push(args);
        return Promise.resolve(okResult(
          args.includes("adopt") || (args.includes("profile") && args.includes("list"))
            ? JSON.stringify([{ name: "new-lark", app_id: "cli_9", brand: "lark", user: { name: "Test" }, token_status: "valid" }])
            : '{"ok":true}',
        ));
      },
    });
    expect(routes.map((r) => r.path).sort()).toEqual([
      "/larklink/adopt",
      "/larklink/auth-complete",
      "/larklink/auth-start",
      "/larklink/bindings",
      "/larklink/health",
    ]);

    const get = routes.find((r) => r.path === "/larklink/bindings")!;
    const res1 = fakeRes();
    get.handler(fakeReq("GET", "/larklink/bindings"), res1);
    await waitFor(res1);
    expect(res1.status).toBe(200);
    const payload1 = JSON.parse(res1.body) as { bindings: Array<{ profile: string }> };
    expect(payload1.bindings[0]!.profile).toBe("solo");

    const adopt = routes.find((r) => r.path === "/larklink/adopt")!;
    const res2 = fakeRes();
    adopt.handler(fakeReq("POST", "/larklink/adopt", { host: "x", origin: "http://x" }), res2);
    await waitFor(res2);
    expect(res2.status).toBe(200);
    expect((JSON.parse(res2.body) as { adopted: string[] }).adopted).toEqual(["new-lark"]);

    const res3 = fakeRes();
    get.handler(fakeReq("GET", "/larklink/bindings", { host: "x", origin: "http://evil" }), res3);
    expect(res3.status).toBe(403);

    // 超大 body（>64KB）→ readBody 拒绝 → 500 JSON（不炸 webServer）
    const res4 = fakeRes();
    adopt.handler(fakeReq("POST", "/larklink/adopt", { host: "x", origin: "http://x" }, "x".repeat(70_000)), res4);
    await waitFor(res4);
    expect(res4.status).toBe(500);
    expect((JSON.parse(res4.body) as { error: string }).error).toBe("body too large");

    cleanup();
  });
});

describe("插件：工具执行（emit 缝 + 守卫链）", () => {
  it("larklink_resolve：唯一绑定 → resolved 信封", async () => {
    await seedSolo();
    const { ctx, tools } = fakeCtx();
    applyTo(ctx, { home }, { runner: (args: string[]) => { void args; return Promise.resolve(okResult()); } });
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
    applyTo(ctx, { home }, { runner: (args: string[]) => { calls.push(args); return Promise.resolve(okResult()); } });
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
    applyTo(ctx, { home }, { runner: (args: string[]) => { calls.push(args); return Promise.resolve(results.shift()!); } });
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
    applyTo(ctx, { home }, { runner: () => Promise.resolve(okResult()) });
    const bindingsTool = tools.find((t) => t.name === "larklink_bindings")!;
    const out = (await bindingsTool.execute({ action: "list", fast: true })) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    expect((out["bindings"] as Array<{ profile: string }>)[0]!.profile).toBe("solo");
  });
});

const DEVICE_FLOW = JSON.stringify({
  device_code: "dev_1",
  expires_in: 600,
  verification_url: "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=x&user_code=CDXQ-LHM2",
});

describe("插件：自动登录（auth-start / auth-complete）", () => {
  /** 按调用顺序回放结果的 runner。 */
  function seqRunner(results: LarkRunResult[]) {
    const calls: string[][] = [];
    return {
      calls,
      runner: (args: string[]): Promise<LarkRunResult> => {
        calls.push(args);
        return Promise.resolve(results.shift() ?? okResult());
      },
    };
  }

  it("larklink_bindings auth-start → auth-started 信封（URL + 暂存 device flow）", async () => {
    await seedSolo();
    const { runner, calls } = seqRunner([okResult(DEVICE_FLOW), okResult()]);
    const { ctx, tools } = fakeCtx();
    applyTo(ctx, { home }, { runner: runner as never });
    const bindingsTool = tools.find((t) => t.name === "larklink_bindings")!;
    const out = (await bindingsTool.execute({ action: "auth-start", profile: "solo", open: false })) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    expect(out["status"]).toBe("auth-started");
    expect(out["verificationUrl"]).toContain("accounts.feishu.cn");
    expect(calls[0]).toEqual(["--profile", "solo", "auth", "login", "--domain", "docs", "--no-wait", "--json"]);
    const pending = JSON.parse(await readFile(join(home, "pending-auth.json"), "utf8")) as { deviceCode: string };
    expect(pending.deviceCode).toBe("dev_1");
  });

  it("larklink_bindings auth-complete → ready 并清暂存", async () => {
    await seedSolo();
    await writeFile(join(home, "pending-auth.json"), JSON.stringify({
      profile: "solo", deviceCode: "dev_1", verificationUrl: "https://x",
      startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }), "utf8");
    const { runner, calls } = seqRunner([
      okResult(),
      okResult(JSON.stringify({ identities: { user: { userName: "于跃", openId: "ou_1", tokenStatus: "valid" } } })),
    ]);
    const { ctx, tools } = fakeCtx();
    applyTo(ctx, { home }, { runner: runner as never });
    const bindingsTool = tools.find((t) => t.name === "larklink_bindings")!;
    const out = (await bindingsTool.execute({ action: "auth-complete", profile: "solo" })) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    expect(out["status"]).toBe("ready");
    expect(calls[0]).toEqual(["--profile", "solo", "auth", "login", "--device-code", "dev_1", "--json"]);
    await expect(readFile(join(home, "pending-auth.json"))).rejects.toThrow();
  });

  it("auth 动作缺 profile → 抛错；未知 action 被工具层 enum 校验拦截", async () => {
    await seedSolo();
    const { ctx, tools } = fakeCtx();
    applyTo(ctx, { home }, { runner: () => Promise.resolve(okResult()) });
    const bindingsTool = tools.find((t) => t.name === "larklink_bindings")!;
    await expect(bindingsTool.execute({ action: "auth-start" })).rejects.toThrow(/profile/);
    await expect(bindingsTool.execute({ action: "bogus" })).rejects.toThrow(/must be one of/);
  });

  it("genui POST /larklink/auth-start：body 带 profile → auth-started；缺 profile → 400", async () => {
    await seedSolo();
    const { runner } = seqRunner([okResult(DEVICE_FLOW), okResult()]);
    const { ctx, routes } = fakeCtx();
    applyTo(ctx, { home }, { runner: runner as never });
    const start = routes.find((r) => r.path === "/larklink/auth-start")!;

    const res1 = fakeRes();
    start.handler(fakeReq("POST", "/larklink/auth-start", { host: "x", origin: "http://x", "content-type": "application/json" }, JSON.stringify({ profile: "solo" })), res1);
    await waitFor(res1);
    expect(res1.status).toBe(200);
    const payload = JSON.parse(res1.body) as { status: string; verificationUrl: string };
    expect(payload.status).toBe("auth-started");
    expect(payload.verificationUrl).toContain("accounts.feishu.cn");

    const res2 = fakeRes();
    start.handler(fakeReq("POST", "/larklink/auth-start", { host: "x", origin: "http://x" }, ""), res2);
    await waitFor(res2);
    expect(res2.status).toBe(400);
  });
});

describe("插件：SKILL 触发条件（回归：单绑定也必须触发）", () => {
  it("描述不以多绑定为前提，且包含登录修复触发语", async () => {
    const { LARKLINK_SKILL_DESCRIPTION } = await import("../src/skill-content.js");
    expect(LARKLINK_SKILL_DESCRIPTION).not.toContain("more than one");
    expect(LARKLINK_SKILL_DESCRIPTION.toLowerCase()).toContain("proactively");
    expect(LARKLINK_SKILL_DESCRIPTION.toLowerCase()).toContain("auth");
  });

  it("正文包含无条件触发、登录修复流程与 adopt 自举", () => {
    expect(LARKLINK_SKILL_MARKDOWN).toContain("单一绑定也要走 larklink");
    expect(LARKLINK_SKILL_MARKDOWN).toContain("auth-start");
    expect(LARKLINK_SKILL_MARKDOWN).toContain("pending-auth-expired");
    expect(LARKLINK_SKILL_MARKDOWN).toContain("action=adopt");
  });
});
