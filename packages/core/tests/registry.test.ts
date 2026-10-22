import { describe, expect, it } from "vitest";
import {
  createRegistry,
  findBinding,
  findPin,
  removeBinding,
  removePin,
  routableBindings,
  upsertBinding,
  upsertPin,
  validateRegistry,
} from "../src/registry.js";
import type { Binding, Registry } from "../src/types.js";

function binding(partial: Partial<Binding> & Pick<Binding, "profile" | "brand" | "appId">): Binding {
  return { status: "ready", ...partial } as Binding;
}

describe("registry：绑定与 pin 操作", () => {
  it("空 registry", () => {
    const reg = createRegistry();
    expect(reg.bindings).toEqual([]);
    expect(reg.pins).toEqual([]);
  });

  it("upsertBinding 按 profile 去重更新", () => {
    let reg = createRegistry();
    reg = upsertBinding(reg, binding({ profile: "a", brand: "feishu", appId: "cli_1", status: "incomplete" }));
    reg = upsertBinding(reg, binding({ profile: "a", brand: "feishu", appId: "cli_1", status: "ready" }));
    expect(reg.bindings).toHaveLength(1);
    expect(reg.bindings[0]!.status).toBe("ready");
    expect(findBinding(reg, "a")?.status).toBe("ready");
  });

  it("routableBindings 排除 incomplete（Q8），品牌过滤（§5 步骤 3）", () => {
    let reg = createRegistry();
    reg = upsertBinding(reg, binding({ profile: "fw", brand: "feishu", appId: "cli_1" }));
    reg = upsertBinding(reg, binding({ profile: "fp", brand: "feishu", appId: "cli_2", status: "unauthorized" }));
    reg = upsertBinding(reg, binding({ profile: "li", brand: "lark", appId: "cli_3" }));
    reg = upsertBinding(reg, binding({ profile: "lx", brand: "lark", appId: "cli_4", status: "incomplete" }));

    expect(routableBindings(reg, "feishu").map((b) => b.profile)).toEqual(["fw", "fp"]);
    expect(routableBindings(reg, "lark").map((b) => b.profile)).toEqual(["li"]);
    expect(routableBindings(reg, "none").map((b) => b.profile)).toEqual(["fw", "fp", "li"]);
  });

  it("pin 以 token 为键 upsert 去重", () => {
    let reg = createRegistry();
    reg = upsertPin(reg, { token: "Abc123", profile: "fw", updatedAt: "t1" });
    reg = upsertPin(reg, { token: "Abc123", profile: "fp", updatedAt: "t2" });
    expect(reg.pins).toHaveLength(1);
    expect(findPin(reg, "Abc123")?.profile).toBe("fp");
    reg = removePin(reg, "Abc123");
    expect(findPin(reg, "Abc123")).toBeUndefined();
  });

  it("removeBinding 默认保留 pins（health 清理），dropPins 立即清理（Q10）", () => {
    let reg: Registry = createRegistry();
    reg = upsertBinding(reg, binding({ profile: "fw", brand: "feishu", appId: "cli_1" }));
    reg = upsertPin(reg, { token: "Abc123", profile: "fw" });
    reg = removeBinding(reg, "fw");
    expect(findBinding(reg, "fw")).toBeUndefined();
    expect(findPin(reg, "Abc123")).toBeDefined();
    let reg2: Registry = upsertBinding(reg, binding({ profile: "fw", brand: "feishu", appId: "cli_1" }));
    reg2 = upsertPin(reg2, { token: "Abc123", profile: "fw" });
    reg2 = removeBinding(reg2, "fw", { dropPins: true });
    expect(findPin(reg2, "Abc123")).toBeUndefined();
  });
});

describe("validateRegistry：结构不变量", () => {
  it("干净 registry 无问题", () => {
    let reg = createRegistry();
    reg = upsertBinding(reg, binding({ profile: "fw", brand: "feishu", appId: "cli_1" }));
    reg = upsertPin(reg, { token: "Abc123", profile: "fw" });
    expect(validateRegistry(reg)).toEqual([]);
  });

  it("profile 重复 / appId 重复（ADR-0001）/ 悬空 pin 均报 issue", () => {
    let reg = createRegistry();
    reg = upsertBinding(reg, binding({ profile: "a", brand: "feishu", appId: "cli_1" }));
    reg = { ...reg, bindings: [...reg.bindings, binding({ profile: "a", brand: "feishu", appId: "cli_9" })] };
    reg = upsertBinding(reg, binding({ profile: "b", brand: "feishu", appId: "cli_1" }));
    reg = upsertPin(reg, { token: "Xyz", profile: "ghost" });
    const issues = validateRegistry(reg);
    expect(issues.some((i) => i.message.includes("重复"))).toBe(true);
    expect(issues.some((i) => i.message.includes("ADR-0001"))).toBe(true);
    expect(issues.some((i) => i.message.includes("ghost"))).toBe(true);
  });
});
