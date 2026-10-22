import type { BrandEvidence, ParsedDoc, ResourceType } from "./types.js";

/**
 * 文档 URL / 裸 token 解析器（design.md §5 步骤 1-2）。
 * 事实依据：lark-drive SKILL「文档 URL 格式与 Token 处理」表、lark-shared
 * wiki-token-routing、lark-minutes/lark-slides/lark-drive-inspect 实例（2026-10-22 核对）。
 */

/** 路径前缀 → 资源类型。顺序无关（前缀互不冲突），但保持与设计文档一致的清单。 */
const PATH_RULES: ReadonlyArray<readonly [string, ResourceType]> = [
  ["/docx/", "docx"],
  ["/doc/", "doc"],
  ["/wiki/", "wiki"],
  ["/sheets/", "sheets"],
  ["/base/", "base"],
  ["/slides/", "slides"],
  ["/mindnotes/", "mindnotes"],
  ["/whiteboard/", "whiteboard"],
  ["/minutes/", "minutes"],
  ["/drive/folder/", "folder"],
  ["/page/", "apps"], // 妙搭创意模式应用链接，非飞书文档（lark-apps SKILL）
];

/**
 * 裸 token 前缀 → 资源类型。仅收录有本地文档实例佐证的前缀；
 * slides 为宽松前缀（实例既见 `slides…` 也见无前缀形态）。
 */
const TOKEN_RULES: ReadonlyArray<readonly [string, ResourceType]> = [
  ["doxcn", "docx"],
  ["doccn", "doc"],
  ["wikcn", "wiki"],
  ["shtcn", "sheets"],
  ["bascn", "base"],
  ["fldcn", "folder"],
  ["obcn", "minutes"],
  ["slides", "slides"],
];

const WIKI_TYPES: ReadonlySet<ResourceType> = new Set(["wiki"]);

/** 域名 → 品牌证据。doubao.com 及一切未列域名 → "none"（Q3 决议：不做默认品牌猜测）。 */
const BRAND_DOMAIN_SUFFIXES: ReadonlyArray<readonly [string, BrandEvidence]> = [
  ["feishu.cn", "feishu"],
  ["larksuite.com", "lark"],
  ["larkoffice.com", "lark"], // lark-slides SKILL 实例域名
];

function brandFromDomain(host: string): BrandEvidence {
  for (const [suffix, brand] of BRAND_DOMAIN_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return brand;
  }
  return "none";
}

function makeParsed(
  input: string,
  kind: "url" | "token",
  domain: string | null,
  resourceType: ResourceType | null,
  token: string,
): ParsedDoc {
  return {
    input,
    kind,
    domain,
    brand: domain ? brandFromDomain(domain) : "none",
    resourceType,
    token,
    wikiUnwrapNeeded: resourceType !== null && WIKI_TYPES.has(resourceType),
  };
}

const HOST_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}\//;

/**
 * 解析用户粘贴的 URL 或裸 token。纯函数，不抛异常——识别失败以
 * resourceType=null / token="" 表达，由 resolve 决定如何拒绝。
 */
export function parseDoc(rawInput: string): ParsedDoc {
  const input = rawInput.trim();
  if (input === "") return makeParsed(input, "token", null, null, "");

  // URL 分支：带协议，或形如 host/path 的裸域名输入（补 https:// 容错）
  let urlString: string | null = null;
  if (/:\/\//.test(input)) {
    urlString = input;
  } else if (HOST_PATH_RE.test(input)) {
    urlString = `https://${input}`;
  }

  if (urlString !== null) {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch {
      return makeParsed(input, "url", null, null, "");
    }
    const path = url.pathname;
    for (const [prefix, type] of PATH_RULES) {
      const idx = path.indexOf(prefix);
      if (idx === -1) continue;
      const rest = path.slice(idx + prefix.length);
      const token = rest.split("/").find((seg) => seg !== "") ?? "";
      const host = url.hostname.toLowerCase();
      // 同一输入里出现第二个已知前缀视为异常（如 /wiki/…/docx/…），按首个匹配处理
      return makeParsed(input, "url", host, type, decodeURIComponent(token));
    }
    return makeParsed(input, "url", url.hostname.toLowerCase(), null, "");
  }

  // 裸 token 分支：按前缀识别类型；无匹配则类型未知
  for (const [prefix, type] of TOKEN_RULES) {
    if (input.startsWith(prefix)) {
      return makeParsed(input, "token", null, type, input);
    }
  }
  return makeParsed(input, "token", null, null, "");
}
