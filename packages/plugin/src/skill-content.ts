/** 内嵌 SKILL 内容（随插件注册到 DSH skills 服务，source: bundled）。 */

export const LARKLINK_SKILL_NAME = "larklink";

export const LARKLINK_SKILL_DESCRIPTION =
  "Feishu/Lark document operations + login lifecycle, routed through larklink tools. Use PROACTIVELY, regardless of how many accounts are bound, whenever: (1) the user provides a feishu.cn / larksuite.com / larkoffice.com / doubao.com document link or a bare token (doxcn/shtcn/wikcn/bascn/doccn/fldcn/obcn...), or asks to read/edit/create any Feishu/Lark document, sheet, base, wiki or slides; (2) any lark-cli or lark-* skill operation fails with auth errors, token expiry, needs_refresh, unauthorized, or not-logged-in — larklink triggers the QR login flow automatically (opens the browser; no terminal needed).";

export const LARKLINK_SKILL_MARKDOWN = `# larklink —— 飞书/Lark 文档操作路由与登录管理

## 何时使用（无条件触发，不看绑定数量）

- 用户给出 feishu.cn / larksuite.com / larkoffice.com / doubao.com 的文档链接，或 doxcn / doccn / wikcn / shtcn / bascn / fldcn / obcn 裸 token，要求读取或修改
- 用户要求创建/编辑飞书文档、表格、Base、知识库、幻灯片
- 任何 lark-cli / lark-* skill 操作报授权错误（未登录 / token 过期 / needs_refresh / unauthorized / incomplete）——立即走本 skill 的登录修复流程

**单一绑定也要走 larklink**：larklink 统一提供路由、授权生命周期管理（自动触发扫码登录）、目标守卫与审计。不要因为"只有一个账号"就绕过。

## 硬纪律（多账号防串号）

1. 一切文档域操作必须 \`larklink_resolve\` → \`larklink_exec\`，**禁止**直接调用 lark-cli 文档命令（多账号时会静默打到默认账号，单账号时绕过授权管理与审计）。
2. 身份选择优先级：用户显式指定 > 文档 pin > 唯一绑定 > 询问用户。**能力 ≠ 意图**：探测结果、ready 状态、tenantHint 永不构成自动换号理由。绑定失效 → 走登录修复流程，绝不换绑定重试。
3. 执行身份默认 user；以应用身份（bot）执行必须用户明确要求（\`as: "bot"\`），绝不静默回退。

## 标准流程

1. \`larklink_resolve(input)\` → \`resolved\`（profile / confidence / wikiUnwrapNeeded）或 \`ambiguous\`（candidates 含 probe 标注：accessible / no-permission / auth-failed / timeout）
   - 报 \`no-routable-binding\` 且本机有 lark-cli profile：先 \`larklink_bindings(action=adopt)\` 导入再重试 resolve
   - 全新机器（无任何 profile）：提示用户在终端执行 \`larklink bindings add\`（app secret 不经模型）
2. ambiguous → 把候选与标注呈现给用户选择；选择后 \`larklink_resolve(input, askedProfile, pin=true)\` 记住偏好
3. \`larklink_exec(args, url 或 profile)\` 执行 lark-cli 文档命令，返回信封：
   - \`needs-confirmation\`：向用户展示 action 与参数预览；用户明确同意后，**原样命令** + \`yes=true\` + 返回的 \`confirmationId\`（指纹不符会被拒绝——确认不可挪用）
   - \`timeout-unknown\`：禁止直接重试同命令；先只读核查（drive +inspect / docs +fetch）确认服务端实际状态
   - \`error\`：读 error 字段修复参数或授权后重试
4. wiki 链接（wikcn…）先 \`drive +inspect\` 解包出真实 token/type 再路由到对应命令

## 登录修复（识别到授权失效时：先在对话里问，用户同意后再开授权页）

只要 resolve / exec / 探测出现 \`binding-needs-repair\`、\`auth-failed\`、\`needs_refresh\`、\`unauthorized\`、\`incomplete\` 任一信号：

1. **先在 AI 窗口发起确认，不要直接打开浏览器**：用 \`ask_user_question\`（不可用时直接在回复里问）说明「绑定 <name> 的<问题>已失效，是否现在重新授权（会打开授权页面，约 10 分钟有效）？」，选项：**现在重新授权 / 稍后（先不授权）**。用户选稍后 → 告知该操作无法继续，结束本次任务，不要重试
2. 用户同意后：\`larklink_bindings(action=auth-start, profile=<绑定>)\` —— 它会**先实时核验**（needs_refresh ≠ 失效，access token 由 lark-cli 自动刷新）：
   - \`status: "already-ready"\`：绑定其实可用（缓存状态陈旧），**不要**再要求用户扫码——直接原样重试刚才的操作
   - \`status: "auth-pending"\`：该绑定已有进行中的授权流程（未过期）——**不要**再开新页面/重新扫码，直接把返回的 verificationUrl（及 qrcode）给用户，让 TA 在**已打开的页面**完成确认
   - \`status: "auth-started"\`：自动打开系统浏览器并生成二维码（envelope 含 verificationUrl、qrcode 路径、expiresInSeconds）。把 verificationUrl 作为可点链接给用户；若环境支持读图，用 read_image 展示 qrcode PNG；浏览器没自动打开时提醒用户手动点链接或扫码
3. 等用户在浏览器完成授权确认（10 分钟内有效）。用户回复完成后：\`larklink_bindings(action=auth-complete, profile=<绑定>)\`（device_code 已在插件侧暂存，无需携带；过期会报 pending-auth-expired，届时重新 auth-start）
4. auth-complete 返回 ready 后**原样重试**之前的操作

注意：exec 在拦截前也会先实时核验缓存状态（needs_refresh 但实际可用时会直接放行）——只有真正失效（refresh token 过期等）才会返回 binding-needs-repair。**同一流程内绝不重复 auth-start**（重复调用只会复用现有流程，不会新开页面）；auth-complete 失败通常意味着用户还没在浏览器确认——提示用户确认后再次 auth-complete，不要立刻重新发起。绝不静默换绑定。

## 写操作纪律

- \`overwrite\` / 整段替换前**必须先 fetch 最新内容**做增量合并；优先 str_replace 类局部修改（目标文本不存在会失败而非误覆盖）
- 批量多文档：逐个 resolve+exec，失败不中断，最后汇总成功/失败清单
- 超时（timeout-unknown）后先核查再决定，禁止盲目重试

## 命令域白名单（v1）

docs · drive · sheets · markdown · slides · base · whiteboard · wiki · mindnotes

其他域（im / mail / task / calendar…）不经 larklink，直接用 lark-cli / lark-* skills。

## 绑定管理

- \`larklink_bindings\` 工具动作：adopt（导入既有 profile）/ list / health / pin 管理 / **auth-start / auth-complete（扫码登录与授权修复，无密钥经手）**
- 仅以下操作让用户在终端执行：\`larklink bindings add\`（新建应用，app secret 走 stdin）、\`larklink bindings remove\`（破坏性删除）
`;
