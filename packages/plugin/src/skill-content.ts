/** 内嵌 SKILL 内容（随插件注册到 DSH skills 服务，source: bundled）。 */

export const LARKLINK_SKILL_NAME = "larklink";

export const LARKLINK_SKILL_DESCRIPTION =
  "Multi-account Feishu/Lark document operations routed through larklink tools: resolve which bound account operates on a document URL/token, then execute guarded lark-cli document commands. Use whenever the user provides a feishu.cn / larksuite.com / larkoffice.com / doubao.com document link or a bare token (doxcn/shtcn/wikcn/bascn...) and the machine has more than one lark binding.";

export const LARKLINK_SKILL_MARKDOWN = `# larklink —— 多账号飞书/Lark 文档操作路由

## 何时使用

- 用户给出 feishu.cn / larksuite.com / larkoffice.com / doubao.com 的文档链接，或 doxcn / doccn / wikcn / shtcn / bascn / fldcn / obcn 裸 token，要求读取或修改
- 本机有多个 lark 账号（绑定）时，一切文档域操作必须经 larklink 路由

## 硬纪律（多账号防串号）

1. registry 存在 **≥2 个可用绑定**时：文档域操作必须 \`larklink_resolve\` → \`larklink_exec\`，**禁止**直接调用 lark-cli 文档命令（会静默打到默认账号）。
2. 单一绑定时：默认 profile 即唯一账号，可直接用 lark-* skills，无需 larklink。
3. 身份选择优先级：用户显式指定 > 文档 pin > 唯一绑定 > 询问用户。**能力 ≠ 意图**：探测结果、ready 状态、tenantHint 永不构成自动换号理由。绑定失效 → 提示用户修复授权，绝不换绑定重试。
4. 执行身份默认 user；以应用身份（bot）执行必须用户明确要求（\`as: "bot"\`），绝不静默回退。

## 标准流程

1. \`larklink_resolve(input)\` → \`resolved\`（profile / confidence / wikiUnwrapNeeded）或 \`ambiguous\`（candidates 含 probe 标注：accessible / no-permission / auth-failed / timeout）
2. ambiguous → 把候选与标注呈现给用户选择；选择后 \`larklink_resolve(input, askedProfile, pin=true)\` 记住偏好
3. \`larklink_exec(args, url 或 profile)\` 执行 lark-cli 文档命令，返回信封：
   - \`needs-confirmation\`：向用户展示 action 与参数预览；用户明确同意后，**原样命令** + \`yes=true\` + 返回的 \`confirmationId\`（指纹不符会被拒绝——确认不可挪用）
   - \`timeout-unknown\`：禁止直接重试同命令；先只读核查（drive +inspect / docs +fetch）确认服务端实际状态
   - \`error\`：读 error 字段修复参数或授权后重试
4. wiki 链接（wikcn…）先 \`drive +inspect\` 解包出真实 token/type 再路由到对应命令

## 写操作纪律

- \`overwrite\` / 整段替换前**必须先 fetch 最新内容**做增量合并；优先 str_replace 类局部修改（目标文本不存在会失败而非误覆盖）
- 批量多文档：逐个 resolve+exec，失败不中断，最后汇总成功/失败清单
- 超时（timeout-unknown）后先核查再决定，禁止盲目重试

## 命令域白名单（v1）

docs · drive · sheets · markdown · slides · base · whiteboard · wiki · mindnotes

其他域（im / mail / task / calendar…）不经 larklink，直接用 lark-cli / lark-* skills。

## 绑定管理

- 新增账号、授权修复（扫码 split-flow）、删除绑定：**让用户在终端执行** \`larklink bindings add|auth|remove\` —— app secret 与授权码不经模型上下文
- 工具 \`larklink_bindings\` 仅做无敏感操作：adopt（导入既有 profile）/ list / health / pin 管理
- 绑定授权过期（needs_refresh/unauthorized）：报告用户执行 \`larklink bindings auth <profile>\`，不要反复重试
`;
