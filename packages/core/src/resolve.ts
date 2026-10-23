import { findBinding, findPin, routableBindings } from "./registry.js";
import type { Binding, Brand, ParsedDoc } from "./types.js";
import { parseDoc } from "./url.js";

/** 路由决策（design.md §5，决议 Q1/Q3/Q5/Q8/Q10）。核心不变量：能力 ≠ 意图。 */

export type Confidence = "explicit" | "asked" | "pinned" | "sole";

export interface Candidate {
  profile: string;
  brand: Brand;
  status: Binding["status"];
  /** tenantHint 命中当前域名——仅展示辅助，不影响选择（Q1/Q4 决议）。 */
  tenantHintMatch: boolean;
}

export interface ResolveOk {
  status: "resolved";
  parsed: ParsedDoc;
  profile: string;
  brand: Brand;
  confidence: Confidence;
  /** 绑定当前状态；非 ready 时调用方应提示修复授权而非换绑定。 */
  bindingStatus: Binding["status"];
  reason: string;
}

export interface ResolveAmbiguous {
  status: "ambiguous";
  parsed: ParsedDoc;
  candidates: Candidate[];
  reason: string;
}

export type ResolveResult = ResolveOk | ResolveAmbiguous;

export type ResolveErrorCode =
  | "unrecognized-input"
  | "unsupported-resource"
  | "binding-not-found"
  | "binding-incomplete"
  | "brand-mismatch"
  | "no-routable-binding";

export class ResolveError extends Error {
  readonly code: ResolveErrorCode;
  readonly parsed?: ParsedDoc;
  constructor(code: ResolveErrorCode, message: string, parsed?: ParsedDoc) {
    super(message);
    this.name = "ResolveError";
    this.code = code;
    this.parsed = parsed;
  }
}

export interface ResolveOptions {
  /** 本次用户显式指定的绑定（Q1 优先级 a；Q5：品牌校验不豁免）。 */
  explicitProfile?: string;
  /** 用户对歧义询问的回答——同 explicit 的守卫，但 confidence 记为 asked。 */
  askedProfile?: string;
}

function toCandidate(b: Binding, domain: string | null): Candidate {
  return {
    profile: b.profile,
    brand: b.brand,
    status: b.status,
    tenantHintMatch: domain !== null && (b.tenantHints ?? []).includes(domain),
  };
}

export function resolve(registry: Parameters<typeof findBinding>[0], input: string, opts: ResolveOptions = {}): ResolveResult {
  const parsed = parseDoc(input);
  if (parsed.resourceType === null || parsed.token === "") {
    throw new ResolveError(
      "unrecognized-input",
      `无法识别的文档输入：${JSON.stringify(input)}（支持 URL / doubao 同构链接 / 已知前缀的裸 token；纯描述不支持）`,
      parsed,
    );
  }
  if (parsed.resourceType === "apps") {
    throw new ResolveError(
      "unsupported-resource",
      "/page/ 链接是妙搭创意模式应用，不属于文档域（lark-apps SKILL），不在 larklink 操作范围",
      parsed,
    );
  }

  // Q5-②：显式指定优先（explicit 用户点名 / asked 歧义询问的回答），品牌校验不豁免
  const named = opts.explicitProfile ?? opts.askedProfile;
  if (named !== undefined) {
    const binding = findBinding(registry, named);
    if (binding === undefined) {
      throw new ResolveError("binding-not-found", `绑定 "${named}" 不存在`, parsed);
    }
    if (binding.status === "incomplete") {
      throw new ResolveError("binding-incomplete", `绑定 "${named}" 授权未完成，不可路由（Q8）`, parsed);
    }
    if (parsed.brand !== "none" && parsed.brand !== binding.brand) {
      throw new ResolveError(
        "brand-mismatch",
        `显式指定绑定 "${named}" 品牌为 ${binding.brand}，与输入品牌证据 ${parsed.brand} 不符（Q5-②）`,
        parsed,
      );
    }
    const confidence: Confidence = opts.askedProfile !== undefined ? "asked" : "explicit";
    return {
      status: "resolved",
      parsed,
      profile: binding.profile,
      brand: binding.brand,
      confidence,
      bindingStatus: binding.status,
      reason:
        parsed.brand === "none"
          ? `用户显式指定（输入无品牌证据，选择同时确定品牌）`
          : `用户显式指定（品牌证据 ${parsed.brand} 校验通过）`,
    };
  }

  // Q1 优先级 b：文档级 pin（键 = 归一化 token，跨域名命中）
  const pin = findPin(registry, parsed.token);
  if (pin !== undefined) {
    const binding = findBinding(registry, pin.profile);
    if (binding !== undefined && binding.status !== "incomplete") {
      return {
        status: "resolved",
        parsed,
        profile: binding.profile,
        brand: binding.brand,
        confidence: "pinned",
        bindingStatus: binding.status,
        reason: `文档 pin 命中（记忆于 ${pin.updatedAt ?? "未知时间"}；失效不自动换绑定，Q1）`,
      };
    }
    // 死 pin（绑定已删）或指向 incomplete：忽略并继续，health 负责清理（Q10）
  }

  // Q1 优先级 c/d + Q3：候选集按品牌收窄；唯一绑定按存在性直选（不看登录状态）
  const candidates = routableBindings(registry, parsed.brand);
  if (candidates.length === 0) {
    const scope = parsed.brand === "none" ? "全部绑定" : `${parsed.brand} 品牌绑定`;
    throw new ResolveError(
      "no-routable-binding",
      `无可路由绑定（${scope} 中没有可用绑定；incomplete 不可路由）。若本机已有 lark-cli profile，先 larklink_bindings(action=adopt) 导入为绑定；全新机器需先在终端 larklink bindings add（app secret 不经模型）。`,
      parsed,
    );
  }
  if (candidates.length === 1) {
    const sole = candidates[0]!;
    const repair = sole.status !== "ready" ? `；该绑定状态 ${sole.status}，需修复授权而非换绑定` : "";
    return {
      status: "resolved",
      parsed,
      profile: sole.profile,
      brand: sole.brand,
      confidence: "sole",
      bindingStatus: sole.status,
      reason: `品牌候选集内唯一绑定（存在性判定，不看登录状态，Q3-②）${repair}`,
    };
  }

  return {
    status: "ambiguous",
    parsed,
    candidates: candidates.map((b) => toCandidate(b, parsed.domain)),
    reason:
      parsed.brand === "none"
        ? "输入无品牌证据且存在多个候选绑定，需用户选择（选择同时确定品牌并记为 pin，Q3-③）"
        : "同品牌多个候选绑定，需用户选择（选择记为 pin，Q1/Q3）",
  };
}
