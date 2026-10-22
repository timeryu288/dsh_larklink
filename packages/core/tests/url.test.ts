import { describe, expect, it } from "vitest";
import { parseDoc } from "../src/url.js";

describe("parseDoc：URL 品牌与类型", () => {
  it("feishu.cn 域名 → feishu 品牌", () => {
    const p = parseDoc("https://www.feishu.cn/docx/Abc123");
    expect(p.brand).toBe("feishu");
    expect(p.resourceType).toBe("docx");
    expect(p.token).toBe("Abc123");
    expect(p.kind).toBe("url");
    expect(p.domain).toBe("www.feishu.cn");
  });

  it("租户子域名 → feishu 品牌", () => {
    const p = parseDoc("https://mycompany.feishu.cn/sheets/shtcnXyz789");
    expect(p.brand).toBe("feishu");
    expect(p.resourceType).toBe("sheets");
    expect(p.token).toBe("shtcnXyz789");
  });

  it("larksuite.com / larkoffice.com → lark 品牌", () => {
    expect(parseDoc("https://tenant.larksuite.com/wiki/wikcnA1").brand).toBe("lark");
    expect(parseDoc("https://example.larkoffice.com/slides/S1").brand).toBe("lark");
  });

  it("doubao.com：品牌无证据，类型按路径识别（Q3）", () => {
    const p = parseDoc("https://www.doubao.com/docx/Abc123");
    expect(p.brand).toBe("none");
    expect(p.resourceType).toBe("docx");
    expect(p.token).toBe("Abc123");
  });

  it("未知域名：品牌无证据，路径类型仍识别", () => {
    const p = parseDoc("https://example.com/docx/Abc123");
    expect(p.brand).toBe("none");
    expect(p.resourceType).toBe("docx");
  });

  it("无协议输入补 https 容错", () => {
    const p = parseDoc("xxx.feishu.cn/docx/Abc123");
    expect(p.brand).toBe("feishu");
    expect(p.token).toBe("Abc123");
  });

  it("query / fragment / 尾斜杠不污染 token", () => {
    expect(parseDoc("https://x.feishu.cn/docx/Abc?from=share#sec").token).toBe("Abc");
    expect(parseDoc("https://x.feishu.cn/docx/Abc/").token).toBe("Abc");
  });

  it("各路径类型：doc/wiki/base/slides/minutes/folder/page", () => {
    expect(parseDoc("https://x.feishu.cn/doc/doccnD1").resourceType).toBe("doc");
    expect(parseDoc("https://x.feishu.cn/base/bascnB1").resourceType).toBe("base");
    expect(parseDoc("https://x.feishu.cn/minutes/obcnM1").resourceType).toBe("minutes");
    expect(parseDoc("https://x.feishu.cn/drive/folder/fldcnF1").resourceType).toBe("folder");
    expect(parseDoc("https://x.feishu.cn/page/N1BWmMrq").resourceType).toBe("apps");
    expect(parseDoc("https://x.feishu.cn/page/N1BWmMrq").brand).toBe("feishu");
  });

  it("wiki 类型标记解包（design §5 步骤 5）", () => {
    expect(parseDoc("https://x.feishu.cn/wiki/wikcnW1").wikiUnwrapNeeded).toBe(true);
    expect(parseDoc("https://x.feishu.cn/docx/Abc").wikiUnwrapNeeded).toBe(false);
  });

  it("无已知路径前缀的 URL → resourceType null", () => {
    expect(parseDoc("https://x.feishu.cn/messenger/whatever").resourceType).toBeNull();
  });
});

describe("parseDoc：裸 token", () => {
  it.each([
    ["doxcnAbc123", "docx"],
    ["doccnD1", "doc"],
    ["wikcnW1", "wiki"],
    ["shtcnS1", "sheets"],
    ["bascnB1", "base"],
    ["fldcnF1", "folder"],
    ["obcnM1", "minutes"],
    ["slidesXXXXXXXXXXXXXXXXXXXXXX", "slides"],
  ])("%s → %s", (token, type) => {
    const p = parseDoc(token);
    expect(p.kind).toBe("token");
    expect(p.domain).toBeNull();
    expect(p.brand).toBe("none");
    expect(p.resourceType).toBe(type);
    expect(p.token).toBe(token);
  });

  it("裸 wiki token 标记解包", () => {
    expect(parseDoc("wikcnW1").wikiUnwrapNeeded).toBe(true);
  });

  it("未知前缀 / 空串 / 纯文本 → 无法识别", () => {
    expect(parseDoc("zzzz1234").resourceType).toBeNull();
    expect(parseDoc("").resourceType).toBeNull();
    expect(parseDoc("   ").token).toBe("");
    expect(parseDoc("我昨天写的周报").resourceType).toBeNull();
  });
});
