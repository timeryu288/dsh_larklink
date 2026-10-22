import { describe, expect, it } from "vitest";
import { resolve, ResolveError, upsertBinding, upsertPin, createRegistry } from "../src/index.js";
import type { Binding, Registry } from "../src/types.js";

function binding(partial: Partial<Binding> & Pick<Binding, "profile" | "brand" | "appId">): Binding {
  return { status: "ready", ...partial } as Binding;
}

/** 审查决议的标准多账号场景：工作飞书 + 个人飞书 + Lark 国际版 + 一个未完成绑定。 */
function fixture(): Registry {
  let reg = createRegistry();
  reg = upsertBinding(reg, binding({ profile: "work-feishu", brand: "feishu", appId: "cli_1", tenantHints: ["mycompany.feishu.cn"] }));
  reg = upsertBinding(reg, binding({ profile: "personal-feishu", brand: "feishu", appId: "cli_2" }));
  reg = upsertBinding(reg, binding({ profile: "intl-lark", brand: "lark", appId: "cli_3" }));
  reg = upsertBinding(reg, binding({ profile: "half-lark", brand: "lark", appId: "cli_4", status: "incomplete" }));
  return reg;
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error("expected ResolveError");
  } catch (e) {
    expect(e).toBeInstanceOf(ResolveError);
    expect((e as ResolveError).code).toBe(code);
  }
}

describe("resolve：输入契约（Q3）", () => {
  it("纯自然语言描述 → unrecognized-input", () => {
    expectCode(() => resolve(fixture(), "我昨天写的周报"), "unrecognized-input");
  });

  it("/page/ 妙搭链接 → unsupported-resource", () => {
    expectCode(() => resolve(fixture(), "https://x.feishu.cn/page/N1BWmMrq"), "unsupported-resource");
  });

  it("wiki 链接带解包标记", () => {
    const r = resolve(fixture(), "https://mycompany.feishu.cn/wiki/wikcnW1", { explicitProfile: "work-feishu" });
    expect(r.status === "resolved" && r.parsed.wikiUnwrapNeeded).toBe(true);
  });
});

describe("resolve：显式指定与守卫（Q1-a / Q5-②）", () => {
  it("explicitProfile 正常路径", () => {
    const r = resolve(fixture(), "https://mycompany.feishu.cn/docx/Abc123", { explicitProfile: "work-feishu" });
    expect(r).toMatchObject({ status: "resolved", profile: "work-feishu", confidence: "explicit" });
  });

  it("品牌校验不豁免：feishu URL + lark 绑定 → brand-mismatch", () => {
    expectCode(
      () => resolve(fixture(), "https://x.feishu.cn/docx/Abc123", { explicitProfile: "intl-lark" }),
      "brand-mismatch",
    );
  });

  it("无品牌证据输入（doubao/裸 token）+ 显式指定 → 通过，选择即品牌", () => {
    const r1 = resolve(fixture(), "https://www.doubao.com/docx/Abc123", { explicitProfile: "intl-lark" });
    expect(r1).toMatchObject({ status: "resolved", profile: "intl-lark", brand: "lark" });
    const r2 = resolve(fixture(), "doxcnAbc123", { explicitProfile: "personal-feishu" });
    expect(r2).toMatchObject({ status: "resolved", profile: "personal-feishu" });
  });

  it("绑定不存在 / incomplete → 对应错误", () => {
    expectCode(() => resolve(fixture(), "https://x.feishu.cn/docx/Abc", { explicitProfile: "nope" }), "binding-not-found");
    expectCode(() => resolve(fixture(), "https://x.larksuite.com/docx/Abc", { explicitProfile: "half-lark" }), "binding-incomplete");
  });

  it("歧义询问的回答 → confidence=asked", () => {
    const r = resolve(fixture(), "https://mycompany.feishu.cn/docx/Abc123", { askedProfile: "personal-feishu" });
    expect(r).toMatchObject({ status: "resolved", profile: "personal-feishu", confidence: "asked" });
  });
});

describe("resolve：pin（Q1-b / Q10）", () => {
  it("pin 命中 → pinned；命中失效绑定仍选中（修复不换号）", () => {
    let reg = fixture();
    reg = upsertBinding(reg, binding({ profile: "work-feishu", brand: "feishu", appId: "cli_1", status: "unauthorized" }));
    reg = upsertPin(reg, { token: "Abc123", profile: "work-feishu", updatedAt: "2026-10-01" });
    const r = resolve(reg, "https://mycompany.feishu.cn/docx/Abc123");
    expect(r).toMatchObject({ status: "resolved", profile: "work-feishu", confidence: "pinned", bindingStatus: "unauthorized" });
  });

  it("pin 以 token 为键跨域名命中（doubao 同 token）", () => {
    let reg = fixture();
    reg = upsertPin(reg, { token: "Abc123", profile: "work-feishu" });
    const r = resolve(reg, "https://www.doubao.com/docx/Abc123");
    expect(r).toMatchObject({ status: "resolved", profile: "work-feishu", confidence: "pinned" });
  });

  it("死 pin（绑定已删）与指向 incomplete 的 pin 被忽略，继续消歧", () => {
    let reg = fixture();
    reg = upsertPin(reg, { token: "Gone1", profile: "ghost" });
    reg = upsertPin(reg, { token: "Half1", profile: "half-lark" });
    expect(resolve(reg, "https://x.larksuite.com/docx/Gone1", { explicitProfile: "intl-lark" }).status).toBe("resolved");
    const r = resolve(reg, "https://x.larksuite.com/docx/Half1"); // lark 可路由仅 intl-lark → sole
    expect(r).toMatchObject({ status: "resolved", profile: "intl-lark", confidence: "sole" });
  });
});

describe("resolve：候选与歧义（Q3 / Q8）", () => {
  it("同品牌多候选 → ambiguous，仅列该品牌；tenantHint 命中仅作展示标注", () => {
    const r = resolve(fixture(), "https://mycompany.feishu.cn/docx/Abc123");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.candidates.map((c) => c.profile).sort()).toEqual(["personal-feishu", "work-feishu"]);
      const work = r.candidates.find((c) => c.profile === "work-feishu")!;
      expect(work.tenantHintMatch).toBe(true);
      expect(r.candidates.find((c) => c.profile === "personal-feishu")!.tenantHintMatch).toBe(false);
    }
  });

  it("无品牌证据 + 双品牌绑定 → ambiguous 列出全部可路由候选（排除 incomplete）", () => {
    const r = resolve(fixture(), "https://www.doubao.com/docx/Abc123");
    if (r.status === "ambiguous") {
      expect(r.candidates.map((c) => c.profile).sort()).toEqual(["intl-lark", "personal-feishu", "work-feishu"]);
    } else {
      throw new Error("expected ambiguous");
    }
  });

  it("候选集内唯一绑定 → sole（存在性判定，不看登录状态）", () => {
    let reg = createRegistry();
    reg = upsertBinding(reg, binding({ profile: "only-lark", brand: "lark", appId: "cli_3", status: "needs_refresh" }));
    const r = resolve(reg, "https://x.larksuite.com/docx/Abc");
    expect(r).toMatchObject({ status: "resolved", profile: "only-lark", confidence: "sole", bindingStatus: "needs_refresh" });
    if (r.status === "resolved") expect(r.reason).toContain("修复授权");
  });

  it("品牌过滤后为空 / registry 无绑定 → no-routable-binding", () => {
    let reg = createRegistry();
    reg = upsertBinding(reg, binding({ profile: "half", brand: "lark", appId: "cli_4", status: "incomplete" }));
    expectCode(() => resolve(reg, "https://x.larksuite.com/docx/Abc"), "no-routable-binding");
    expectCode(() => resolve(createRegistry(), "doxcnAbc123"), "no-routable-binding");
  });

  it("incomplete 不进候选：lark 品牌一个 ready 一个 incomplete → sole 而非 ambiguous", () => {
    const r = resolve(fixture(), "https://x.larksuite.com/docx/Any1");
    expect(r).toMatchObject({ status: "resolved", profile: "intl-lark", confidence: "sole" });
  });

  it("单绑定 + 无品牌证据输入（裸 token）→ sole", () => {
    let reg = createRegistry();
    reg = upsertBinding(reg, binding({ profile: "solo", brand: "feishu", appId: "cli_1" }));
    const r = resolve(reg, "doxcnAnything1");
    expect(r).toMatchObject({ status: "resolved", profile: "solo", confidence: "sole" });
  });
});
