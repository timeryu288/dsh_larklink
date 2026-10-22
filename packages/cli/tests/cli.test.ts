import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, upsertBinding, upsertPin } from "@timeryu288/larklink-core";
import { cmdResolve, classifyProbe } from "../src/commands/resolve.js";
import { cmdExec } from "../src/commands/exec.js";
import { cmdAdopt, cmdPin, mapStatus } from "../src/commands/bindings.js";
import type { LarkRunResult } from "../src/larkcli.js";
import { appendAudit, auditPath } from "../src/audit.js";
import { loadRegistry, saveRegistry } from "../src/store.js";
import { computeConfirmationId } from "../src/execguard.js";

let home: string;
let savedHome: string | undefined;
let savedAudit: string | undefined;

beforeEach(async () => {
  savedHome = process.env["LARKLINK_HOME"];
  savedAudit = process.env["LARKLINK_AUDIT"];
  home = await mkdtemp(join(tmpdir(), "larklink-test-"));
  process.env["LARKLINK_HOME"] = home;
  delete process.env["LARKLINK_AUDIT"];
  delete process.env["LARKLINK_AUDIT_VERBOSE"];
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env["LARKLINK_HOME"];
  else process.env["LARKLINK_HOME"] = savedHome;
  if (savedAudit === undefined) delete process.env["LARKLINK_AUDIT"];
  else process.env["LARKLINK_AUDIT"] = savedAudit;
  await rm(home, { recursive: true, force: true });
});

function okResult(stdout = '{"ok":true}'): LarkRunResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 5, timedOut: false };
}
function confirmationResult(): LarkRunResult {
  return {
    exitCode: 10,
    stdout: "",
    stderr: JSON.stringify({ ok: false, error: { type: "confirmation", action: "docs.update", risk: "high" } }),
    durationMs: 5,
    timedOut: false,
  };
}

/** 记录调用并按序回放结果的 mock runner。 */
function recorder(results: LarkRunResult[]) {
  const calls: string[][] = [];
  const runner = (args: string[]): Promise<LarkRunResult> => {
    calls.push(args);
    const r = results.shift() ?? okResult();
    return Promise.resolve(r);
  };
  return { runner, calls };
}

async function seedTwoFeishu() {
  let reg = createRegistry();
  reg = upsertBinding(reg, { profile: "work-feishu", brand: "feishu", appId: "cli_1", status: "ready", tenantHints: ["mycompany.feishu.cn"] });
  reg = upsertBinding(reg, { profile: "personal-feishu", brand: "feishu", appId: "cli_2", status: "ready" });
  await saveRegistry(reg, home);
}

describe("cmdResolve：路由与探测", () => {
  it("唯一 lark 绑定 → sole 返回 0", async () => {
    let reg = createRegistry();
    reg = upsertBinding(reg, { profile: "intl-lark", brand: "lark", appId: "cli_3", status: "ready" });
    await saveRegistry(reg, home);
    const { runner, calls } = recorder([]);
    expect(await cmdResolve(runner, { input: "https://x.larksuite.com/docx/Abc" }, home)).toBe(0);
    expect(calls).toHaveLength(0); // sole 无歧义，不探测
  });

  it("双 feishu 歧义 → exit 3 并对两候选只读探测（Q4）", async () => {
    await seedTwoFeishu();
    const probe = recorder([
      okResult(), // work-feishu → accessible
      { exitCode: 1, stdout: "", stderr: JSON.stringify({ error: { code: 403, message: "permission denied" } }), durationMs: 3, timedOut: false },
    ]);
    const code = await cmdResolve(probe.runner, { input: "https://mycompany.feishu.cn/docx/Abc" }, home);
    expect(code).toBe(3);
    expect(probe.calls.filter((c) => c.includes("+inspect"))).toHaveLength(2);
  });

  it("--asked --pin 落 pin 且不探测（Q3-③）", async () => {
    await seedTwoFeishu();
    const { runner, calls } = recorder([]);
    expect(await cmdResolve(runner, { input: "https://mycompany.feishu.cn/docx/Abc", askedProfile: "personal-feishu", pin: true }, home)).toBe(0);
    expect(calls).toHaveLength(0);
    const reg = await loadRegistry(home);
    expect(reg.pins).toEqual([{ token: "Abc", profile: "personal-feishu", updatedAt: expect.any(String) }]);
  });

  it("classifyProbe 分类", () => {
    expect(classifyProbe({ exitCode: 0, stdout: "", stderr: "", timedOut: false })).toBe("accessible");
    expect(classifyProbe({ exitCode: 1, stdout: "", stderr: '{"error":{"code":403}}', timedOut: false })).toBe("no-permission");
    expect(classifyProbe({ exitCode: 1, stdout: "", stderr: '{"error":{"message":"invalid authentication token"}}', timedOut: false })).toBe("auth-failed");
    expect(classifyProbe({ exitCode: 1, stdout: "", stderr: "", timedOut: true })).toBe("timeout");
  });
});

describe("cmdExec：守卫链端到端", () => {
  const url = "https://mycompany.feishu.cn/docx/Abc123";
  const updateArgs = ["docs", "+update", "--doc", url, "--content", "新内容"];

  it("域白名单外 → exit 2（Q9）", async () => {
    await seedTwoFeishu();
    const { runner, calls } = recorder([]);
    expect(await cmdExec(runner, { profile: "work-feishu", rawArgs: ["im", "message", "send"] }, home)).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("argv 夹带 --as → exit 2（Q6-①）", async () => {
    await seedTwoFeishu();
    const { runner } = recorder([]);
    expect(await cmdExec(runner, { profile: "work-feishu", rawArgs: ["docs", "+fetch", "--as", "bot"] }, home)).toBe(2);
  });

  it("成功路径：URL 路由 + --as 注入 + 信封透传（exit 0）", async () => {
    await seedTwoFeishu();
    const { runner, calls } = recorder([okResult('{"ok":true,"data":{"title":"x"}}')]);
    expect(await cmdExec(runner, { url, profile: "work-feishu", rawArgs: updateArgs }, home)).toBe(0);
    expect(calls[0]).toEqual(["--profile", "work-feishu", ...updateArgs, "--as", "user"]);
  });

  it("pin 命中的绑定用于 exec（Q1-b）", async () => {
    await seedTwoFeishu();
    let reg = await loadRegistry(home);
    reg = upsertPin(reg, { token: "Abc123", profile: "personal-feishu", updatedAt: "t" });
    await saveRegistry(reg, home);
    const { runner, calls } = recorder([okResult()]);
    expect(await cmdExec(runner, { url, rawArgs: updateArgs }, home)).toBe(0);
    expect(calls[0]![1]).toBe("personal-feishu");
  });

  it("目标不一致 → exit 2 拒绝执行（Q5-①）", async () => {
    await seedTwoFeishu();
    const { runner, calls } = recorder([]);
    const code = await cmdExec(runner, { url, profile: "work-feishu", rawArgs: ["docs", "+update", "--doc", "https://x.feishu.cn/docx/Other999", "--content", "x"] }, home);
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("exit 10 门禁 → 下发 confirmationId（exit 10）；指纹正确的 --yes 重试通过", async () => {
    await seedTwoFeishu();
    const first = recorder([confirmationResult()]);
    expect(await cmdExec(first.runner, { url, profile: "work-feishu", rawArgs: updateArgs }, home)).toBe(10);
    const confirmationId = computeConfirmationId("work-feishu", "user", updateArgs);
    const retry = recorder([okResult()]);
    expect(await cmdExec(retry.runner, { url, profile: "work-feishu", rawArgs: updateArgs, yes: true, confirmationId }, home)).toBe(0);
    expect(retry.calls[0]!.includes("--yes")).toBe(true);
  });

  it("指纹不符的 --yes → exit 2（确认不可挪用，Q6-②）", async () => {
    await seedTwoFeishu();
    const { runner, calls } = recorder([]);
    const code = await cmdExec(runner, { url, profile: "work-feishu", rawArgs: updateArgs, yes: true, confirmationId: "deadbeef".repeat(4) }, home);
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("--yes 无 confirmationId → exit 2", async () => {
    await seedTwoFeishu();
    const { runner } = recorder([]);
    expect(await cmdExec(runner, { url, profile: "work-feishu", rawArgs: updateArgs, yes: true }, home)).toBe(2);
  });

  it("超时 → exit 11 timeout-unknown（Q7）", async () => {
    await seedTwoFeishu();
    const { runner } = recorder([{ exitCode: -1, stdout: "", stderr: "", durationMs: 60_000, timedOut: true }]);
    expect(await cmdExec(runner, { url, profile: "work-feishu", rawArgs: updateArgs }, home)).toBe(11);
  });

  it("dry-run 不触达 lark-cli", async () => {
    await seedTwoFeishu();
    const { runner, calls } = recorder([]);
    expect(await cmdExec(runner, { url, profile: "work-feishu", rawArgs: updateArgs, dryRun: true }, home)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("路由命中 needs_refresh 绑定 → exit 2 提示修复，不换绑定（Q1）", async () => {
    let reg = createRegistry();
    reg = upsertBinding(reg, { profile: "only", brand: "feishu", appId: "cli_1", status: "needs_refresh" });
    await saveRegistry(reg, home);
    const { runner, calls } = recorder([]);
    expect(await cmdExec(runner, { url, profile: "work-feishu", rawArgs: updateArgs }, home)).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("审计落盘且载荷脱敏（Q10-③）", async () => {
    await seedTwoFeishu();
    const { runner } = recorder([okResult()]);
    await cmdExec(runner, { url, profile: "work-feishu", rawArgs: updateArgs }, home);
    const lines = (await readFile(auditPath(home), "utf8")).trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.kind).toBe("exec");
    expect(JSON.stringify(last)).not.toContain("新内容");
    expect(last.argv.join(" ")).toContain("<redacted");
  });
});

describe("bindings：adopt / pin / 状态映射", () => {
  it("mapStatus 映射", () => {
    expect(mapStatus(undefined, false)).toBe("incomplete");
    expect(mapStatus("needs_refresh", true)).toBe("needs_refresh");
    expect(mapStatus("", true)).toBe("ready");
    expect(mapStatus("revoked", true)).toBe("unauthorized");
  });

  it("adopt 导入 profile list（不动 lark-cli 侧）", async () => {
    const { runner, calls } = recorder([
      okResult(
        JSON.stringify([
          { name: "cli_a93", app_id: "cli_a93270c74823dcd3", brand: "feishu", user: { name: "于跃", open_id: "ou_1" }, token_status: "needs_refresh" },
          { name: "ghost", app_id: "cli_x", brand: undefined, user: null },
        ]),
      ),
    ]);
    expect(await cmdAdopt({ runner, home }, {})).toBe(0);
    const reg = await loadRegistry(home);
    expect(reg.bindings).toHaveLength(1);
    expect(reg.bindings[0]).toMatchObject({ profile: "cli_a93", brand: "feishu", status: "needs_refresh", adopted: true, userName: "于跃" });
    expect(calls[0]).toEqual(["profile", "list"]);
  });

  it("pin add/list/remove；指向不存在绑定被拒", async () => {
    await seedTwoFeishu();
    expect(await cmdPin({ op: "add", token: "Tok1", profile: "work-feishu" }, home)).toBe(0);
    const reg = await loadRegistry(home);
    expect(reg.pins[0]!.profile).toBe("work-feishu");
    expect(await cmdPin({ op: "add", token: "Tok1", profile: "ghost" }, home)).toBe(2);
    expect(await cmdPin({ op: "remove", token: "Tok1" }, home)).toBe(0);
    expect((await loadRegistry(home)).pins).toHaveLength(0);
  });
});

describe("store：持久化", () => {
  it("save/load 往返；pin 键去重", async () => {
    await seedTwoFeishu();
    let reg = await loadRegistry(home);
    reg = upsertPin(reg, { token: "T", profile: "work-feishu" });
    reg = upsertPin(reg, { token: "T", profile: "personal-feishu" });
    await saveRegistry(reg, home);
    const re = await loadRegistry(home);
    expect(re.pins).toHaveLength(1);
    expect(re.pins[0]!.profile).toBe("personal-feishu");
  });

  it("损坏文件报错而非静默重建", async () => {
    await writeFile(join(home, "registry.json"), "{oops", "utf8");
    await expect(loadRegistry(home)).rejects.toThrow(/损坏/);
  });
});

describe("audit：开关", () => {
  it("LARKLINK_AUDIT=off 时静默跳过", async () => {
    process.env["LARKLINK_AUDIT"] = "off";
    await appendAudit({ kind: "resolve", argv: ["x"] }, home);
    process.env["LARKLINK_AUDIT"] = "";
    await appendAudit({ kind: "resolve", argv: ["y"], message: "m" }, home);
    const text = await readFile(auditPath(home), "utf8");
    expect(text).toContain('"y"');
    expect(text).not.toContain('"x"');
  });
});
