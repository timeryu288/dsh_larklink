/** LarkLink 领域类型（见仓库 CONTEXT.md 与 docs/design.md）。 */

/** 开放平台品牌。lark-cli 每个绑定固定一个品牌（ADR-0001）。 */
export type Brand = "feishu" | "lark";

/** 输入中的品牌证据：明确品牌，或无证据（doubao.com / 未知域名 / 裸 token）。 */
export type BrandEvidence = Brand | "none";

/** 文档资源类型（按 URL 路径前缀或裸 token 前缀识别）。 */
export type ResourceType =
  | "docx"
  | "doc" // 旧版文档
  | "wiki" // wiki 节点，需解包 obj_token
  | "sheets"
  | "base"
  | "slides"
  | "mindnotes"
  | "whiteboard"
  | "minutes"
  | "folder"
  | "apps"; // /page/ 妙搭应用链接（非文档域，仅识别）

/** parseDoc 的产物：归一化后的文档定位信息。 */
export interface ParsedDoc {
  /** 原始输入（已 trim）。 */
  input: string;
  /** 输入形态：URL 或裸 token。 */
  kind: "url" | "token";
  /** 小写主机名；裸 token 为 null。 */
  domain: string | null;
  /** 域名给出的品牌证据；无证据为 "none"。 */
  brand: BrandEvidence;
  /** 识别失败为 null（resolve 会拒绝）。 */
  resourceType: ResourceType | null;
  /** 路径/token 中提取的文档 token；失败为空串。 */
  token: string;
  /** wiki 链接：token 是节点 token，执行前需 drive +inspect 解包。 */
  wikiUnwrapNeeded: boolean;
}

/** 绑定状态（health 同步；incomplete 不可被路由选中，Q8 决议）。 */
export type BindingStatus = "ready" | "needs_refresh" | "unauthorized" | "incomplete";

/**
 * 绑定：一个独立开放平台应用 + 该应用下唯一授权用户（ADR-0001）。
 * registry 只存路由元数据，绝不存 token / appSecret（design.md §4 红线）。
 */
export interface Binding {
  /** lark-cli profile 名，唯一键。 */
  profile: string;
  brand: Brand;
  appId: string;
  userName?: string;
  openId?: string;
  /** 租户域名提示，仅用于候选展示，不参与自动选择（Q1/Q4 决议）。 */
  tenantHints?: string[];
  status: BindingStatus;
  /** 导入绑定（adopt 自用户已有 profile；remove 默认不删原 profile，Q8 决议）。 */
  adopted?: boolean;
  addedAt?: string;
}

/** 文档账号偏好：pin 以归一化 token 为键（同 token 跨域名命中）。 */
export interface Pin {
  token: string;
  profile: string;
  updatedAt?: string;
}

export interface Registry {
  version: 1;
  bindings: Binding[];
  pins: Pin[];
}
