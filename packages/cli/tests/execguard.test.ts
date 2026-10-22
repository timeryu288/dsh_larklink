import { describe, expect, it } from "vitest";
import {
  EXEC_DOMAINS,
  checkTargets,
  computeConfirmationId,
  domainOf,
  extractTargets,
  findArgvAs,
} from "../src/execguard.js";
import { parseDoc } from "@timeryu288/larklink-core";
import { redactArgv, redactValue } from "../src/audit.js";

describe("execguard：域白名单与身份（Q9/Q6）", () => {
  it("domainOf 提取首个参数", () => {
    expect(domainOf(["docs", "+update"])).toBe("docs");
  });

  it("文档域在白名单，im/mail/task 不在", () => {
    expect(EXEC_DOMAINS.has("docs")).toBe(true);
    expect(EXEC_DOMAINS.has("markdown")).toBe(true);
    for (const d of ["im", "mail", "task", "calendar", "contact"]) {
      expect(EXEC_DOMAINS.has(d)).toBe(false);
    }
  });

  it("findArgvAs 检出 --as 两种形态", () => {
    expect(findArgvAs(["docs", "+update", "--as", "bot"])).toMatchObject({ value: "bot" });
    expect(findArgvAs(["docs", "+update", "--as=user"])).toMatchObject({ value: "user" });
    expect(findArgvAs(["docs", "--assign", "x"])).toBeNull();
  });

  it("extractTargets 提取目标旗标（含 = 形态）", () => {
    const t = extractTargets(["docs", "+update", "--doc", "https://x.feishu.cn/docx/Abc", "--mode=x"]);
    expect(t).toEqual([{ flag: "--doc", value: "https://x.feishu.cn/docx/Abc" }]);
    expect(extractTargets(["drive", "+inspect", "--url=https://x.feishu.cn/wiki/wikcnW"])).toEqual([
      { flag: "--url", value: "https://x.feishu.cn/wiki/wikcnW" },
    ]);
  });
});

describe("execguard：目标一致性（Q5-①）", () => {
  const routed = parseDoc("https://mycompany.feishu.cn/docx/Abc123");

  it("目标与路由一致 → 放行", () => {
    expect(checkTargets([{ flag: "--doc", value: "https://x.feishu.cn/docx/Abc123" }], routed)).toEqual({ ok: true });
    expect(checkTargets([{ flag: "--doc", value: "Abc123" }], routed)).toEqual({ ok: true });
  });

  it("目标指向另一文档 → 拒绝", () => {
    const r = checkTargets([{ flag: "--doc", value: "https://x.feishu.cn/docx/Other999" }], routed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("target-mismatch");
  });

  it("未识别形态（非 URL/token）→ fail-open 放行", () => {
    expect(checkTargets([{ flag: "--doc", value: "标题搜索词" }], routed)).toEqual({ ok: true });
  });
});

describe("execguard：确认指纹（Q6-②）", () => {
  const argv = ["docs", "+update", "--doc", "Abc", "--content", "hi"];

  it("确定性：同输入同指纹", () => {
    expect(computeConfirmationId("p", "user", argv)).toBe(computeConfirmationId("p", "user", argv));
  });

  it("profile / as / argv 任一变化即失效", () => {
    const base = computeConfirmationId("p", "user", argv);
    expect(computeConfirmationId("q", "user", argv)).not.toBe(base);
    expect(computeConfirmationId("p", "bot", argv)).not.toBe(base);
    expect(computeConfirmationId("p", "user", [...argv, "--yes"])).not.toBe(base);
  });
});

describe("audit：载荷脱敏（Q10-③）", () => {
  it("PAYLOAD_FLAGS 的值替换为 len+sha1，其余原样", () => {
    const secret = "这是文档正文内容";
    const out = redactArgv(["docs", "+update", "--doc", "Abc", "--content", secret]);
    expect(out[5]).toMatch(/^<redacted len=\d+ sha1=[0-9a-f]{12}>$/);
    expect(out.join(" ")).not.toContain(secret);
    expect(out[3]).toBe("Abc");
  });

  it("--content=x 形态同样脱敏", () => {
    const out = redactArgv(["docs", "--content=正文"]);
    expect(out[1]).toMatch(/^--content=<redacted len=\d+ sha1=[0-9a-f]{12}>$/);
  });
});
