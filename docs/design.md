# dsh_larklink 设计方案

> 版本：v0.1（草案） · 日期：2026-10-22 · 状态：讨论中
> 目标仓库：https://github.com/timeryu288/dsh_larklink.git（开发主线：`dev` 分支）

## 1. 目标与非目标

### 目标

1. 在一台机器上**同时绑定多个相互独立的 Lark/飞书账号**（不同品牌、不同租户、不同个人账号均可）。
2. 用户粘贴文档 URL（或 token）后，插件**自动路由到正确账号**执行文档操作，无需人工指定。
3. 以 DeepSeek Harness（DSH）插件形态集成：向模型暴露 `larklink_*` 工具；同时提供可独立使用的 `larklink` CLI。
4. 沿用 lark-cli 的全部安全协议（高风险确认、dry-run、JSON 契约），不绕过任何门禁。

### 非目标

- 不自己实现 Lark OpenAPI 调用——**lark-cli 仍是唯一执行引擎**，本插件只做「多账号路由 + 生命周期管理 + DSH 集成」。
- 不做除文档域之外的业务编排（消息、审批等仍走各 lark-* skill，但路由层可复用）。
- 不在插件内存储任何密钥或 token。

## 2. 已验证的事实基础（本机实测，2026-10-22）

| 事实 | 来源 |
| --- | --- |
| lark-cli 1.0.76 支持命名 profile 与 `--profile`；profile add 要求每个 profile 的 App ID 唯一。用户 token 按 App ID + 用户 open_id 存储，不按 profile 名完全隔离；同一应用多用户的绑定与执行选择方式仍需核查 | CLI help；[profile/add.go](https://github.com/larksuite/cli/blob/v1.0.76/cmd/profile/add.go)；[auth/token_store.go](https://github.com/larksuite/cli/blob/v1.0.76/internal/auth/token_store.go) |
| 当前机器仅一个 profile（brand=feishu），说明多 profile 能力尚未被利用 | `lark-cli profile list` |
| DSH 第三方插件 = npm 包：ESM 入口 + `cordis.patch.yml`（`insert` 到插件树）+ `defineTool`（`@deepseek-ai/dsh-tools`）注册模型工具，可声明可选的 web 客户端 UI | 参考实装：`@wxg-prc-cpg/browser-skill-dsh-plugin@0.3.0` |
| 文档 URL 按路径模式识别：`/docx/` `/doc/` `/wiki/` `/sheets/` `/base/` `/slides/` `/drive/folder/` 等；域名不参与类型判断（feishu.cn / larksuite.com / doubao.com 同构）；wiki token 不能直接当 file token，需 `drive +inspect` 解包 | lark-drive / lark-doc / lark-sheets SKILL.md |
| lark-cli 高风险写操作有 exit 10 + `confirmation_required` 门禁，必须用户显式同意后追加 `--yes` | lark-shared SKILL.md |
| 成功判定用 `ok == true` / 退出码 0，不是 `code == 0` | lark-shared SKILL.md |

## 3. 总体架构

```
┌──────────────────────────  DSH Agent 会话  ──────────────────────────┐
│  用户: "帮我把这个文档改一下 https://xxx.feishu.cn/docx/Abc123"        │
└──────────────┬───────────────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  dsh-plugin (packages/dsh-plugin)  — DSH cordis 插件，薄适配层         │
│  defineTool 注册:                                                    │
│    larklink_bindings  larklink_resolve  larklink_exec                │
└──────────────┬───────────────────────────────────────────────────────┘
               ▼ 调用（子进程 spawn，argv 数组）
┌──────────────────────────────────────────────────────────────────────┐
│  larklink CLI (packages/cli)  — 可独立使用                            │
│   ├─ resolve: URL → {profile, brand, resourceType, token, reason}    │
│   ├─ bindings: add / auth / list / health / remove / pin             │
│   └─ exec: 在指定 profile 上执行 lark-cli 命令并透传结果               │
└──────┬───────────────────────────┬───────────────────────────────────┘
       ▼                           ▼
┌──────────────┐          ┌────────────────────┐
│ registry.json │ 读取元数据 │  lark-cli --profile │ ← 唯一执行引擎
│ (无任何密钥)   │          │  多 profile 授权隔离 │
└──────────────┘          └────────────────────┘
```

分层原则：**core 纯逻辑（packages/core，零 DSH 依赖、可单测）→ CLI 包一层（可独立运行）→ DSH 插件再包一层（工具暴露）→ skill 补使用指南**。每一层都可以被上层以外的方式复用。

## 4. 绑定注册表（Registry）

存储位置：`~/.larklink/registry.json`（Windows: `%USERPROFILE%\.larklink\registry.json`）。

```jsonc
{
  "version": 1,
  "bindings": [
    {
      "profile": "work-feishu",        // lark-cli profile 名（唯一键）
      "brand": "feishu",               // feishu | lark
      "appId": "cli_a93...",
      "userName": "于跃",               // auth status 同步
      "openId": "ou_2a08...",
      "tenantHints": ["mycompany.feishu.cn"], // 可选：租户域名提示
      "defaultForBrand": true,         // 该品牌的默认账号
      "status": "ready",               // ready | needs_refresh | unauthorized（health 时刷新）
      "addedAt": "2026-10-22T15:00:00+08:00"
    }
  ],
  "pins": [                            // 歧义消解的学习记忆
    { "urlPattern": "feishu.cn/docx/Abc123", "profile": "work-feishu",
      "updatedAt": "..." }
  ]
}
```

**红线：registry 只存路由元数据，不存 token / appSecret。** 凭证完全交给 lark-cli 的 profile 机制管理。

**不变量（ADR-0001）**：一个绑定 = 一个独立应用（App ID 全局唯一）+ 该应用下唯一授权用户；绑定与 lark-cli profile 一一对应。添加绑定即添加 profile，需要新建应用或使用未被占用的 App ID。

## 5. URL 路由算法（resolve）

```
输入: url 或裸 token（纯自然语言描述不支持 v1，由 Agent 追问取得链接/token）
1. 规范化 → 解析 domain / path / token / resourceType
   resourceType ← 路径前缀（/docx/ /doc/ /wiki/ /sheets/ /base/ /slides/
                  /mindnotes/ /whiteboard/ /drive/folder/ /minutes/）
                  或裸 token 前缀（doxcn/shtcn/wikcn…，M1 与 lark-drive SKILL 对照定稿）
2. brand 判定:
     *.feishu.cn / *.larksuite.com → 对应品牌
     doubao.com、其它域名、裸 token → 无品牌证据
3. 候选集: brand 已知 → 该品牌全部绑定；brand 未知 → 全部绑定
4. 消歧（按优先级）:
   a. 本次用户显式指定的操作身份优先（仍须校验品牌与授权）
   b. 该文档的 pin（用户此前确认的选择）
   c. 候选集恰好只有一个绑定 → 直接选中（confidence=sole；按存在性唯一判定，
      不看登录状态——若该绑定失效，报"修复授权"，不换绑定）
   d. 其余歧义 → 先对候选做只读能力探测（见下"能力探测"），展示候选
      让用户选择，选择记为 pin（选择同时隐含品牌）
   e. 已选中/记住的绑定失效时修复其授权，或由用户明确改选；
      禁止仅因另一绑定 ready 就切换
   （tenantHints 仅用于候选展示辅助，不参与自动选择）
5. wiki 链接：标记 wikiUnwrapNeeded，执行期先 `drive +inspect` 解包 obj_token
6. 输出 ResolveResult:
   { profile, brand, resourceType, token, wikiUnwrapNeeded,
     confidence: explicit|pinned|sole|asked, reason }
```

设计要点：

- **一次 resolve 只产出一个 profile**——杜绝单请求跨账号；批量场景（如"把这三个文档各改一下"）逐文档 resolve。
- resolve 阶段**不做任何写操作**；`drive +inspect` 属读操作，用于 wiki 解包时可自动执行。
- **能力探测（Q4 决议）**：歧义询问前对每个候选执行一次只读探测（按资源类型选命令，短超时 ~8s），标注 `可访问 / 只读(缺编辑scope) / 无权限 / 授权失效`；探测超时不阻塞询问。探测结果**永不参与自动选择**（能力 ≠ 意图），无权限候选不隐藏；`--no-probe` 可跳过（延迟敏感/介意多租户留痕）。注意：每次探测是该身份下的一次真实 API 调用，会留在目标租户审计日志中。
- reason 字段记录决策依据（命中 pin / hint / 默认 / 用户选择），随工具结果返回给模型与用户，可审计。

## 6. 绑定生命周期（bindings）

| 动作 | 流程 |
| --- | --- |
| add | `larklink bindings add --name <profile> [--brand feishu\|lark] [--app-id <id>]`：<br>① 无 app-id → 调 `lark-cli config init --name <名> --brand <b> --new`（后台运行）提取 `verification_url`；<br>② 生成二维码（PNG 优先）连同 URL 一起给用户；<br>③ 用户完成后 `auth login --device-code <code>` 收尾；<br>④ `auth status --json --verify` 回填 userName/openId/status 到 registry |
| auth（补授权） | 沿用 lark-cli split-flow：`auth login --domain <域> --no-wait --json` → 二维码 → 用户确认后 `--device-code` 收尾；scope 累积 |
| list | 读 registry + 逐条 `auth status --json --verify` 核实（`--fast` 时跳过网络校验） |
| health | 同步 status；`refreshExpiresAt` 临期（<48h）时提示重新授权；token 过期由 lark-cli 下次调用自动刷新，插件不做刷新逻辑 |
| remove | `lark-cli profile remove` + registry 删除；需用户显式确认（破坏性） |
| pin | 手动增删 pins（自动学习之外的兜底） |

Agent 交互协议：add/auth 必须走 split-flow（当轮只给 URL + 二维码，结束本轮等用户回复"已授权"），**禁止缓存 verification_url / device_code**。

## 7. 执行层（exec）

```
larklink exec [--profile <p>] [--url <u>] [--dry-run] -- <lark-cli 子命令...>
```

- `--profile` 与 `--url` 可单传或并传；都不给则报错（**不做隐式默认**）。并传时：用户显式指定的 profile 优先（Q1=A 原则，跳过 pin/sole 自动选择），但**品牌校验不豁免**——url 品牌与 profile 品牌不符直接拒绝。
- **目标一致性守卫（Q5 决议）**：exec 从 argv 提取目标参数（`--doc` / `--url` / `--file` 等白名单 flag），与本次路由得到的 url/token 比对；**能提取到且冲突 → 拒绝执行**，报 mismatch 让 Agent 重新 resolve。识别不了的命令不比对、不阻塞（fail-open，避免白名单不全挡住正常操作）。白名单按 lark-cli 各域 flag 名在 M3 维护。
- **不信任上次 resolve 快照**：resolve 与 exec 是两次独立调用，其间 pin/绑定状态可能被其他会话改变。exec 带 url 时内部按**当时最新状态**重新 resolve；只带 profile 时不路由直接执行。
- spawn 用 **argv 数组**，禁止 shell 字符串拼接（防注入，也符合 lark-shared 对 exit 10 重试的要求）。
- 结果透传：stdout JSON / stderr JSON / 退出码原样返回，并在外层信封附上 `{ profile, confidence, argv, durationMs }`，供 Agent 核对实际使用的身份。
- **exit 10 协议透传**：检测 `error.type == "confirmation"` → 返回 `needsConfirmation` 结构（含 action/risk/参数预览），由 Agent 向用户确认；用户同意后由 Agent 显式重试原 argv + `--yes`。绝不静默放行。
- 成功判定以 `ok == true` / 退出码 0 为准（防旧格式 `code==0` 误判）。
- Windows 注意：`lark-cli` 是 `.ps1` wrapper，spawn 时经 `pwsh -File` 或定位其底层可执行文件（M1 实测定稿）。

## 8. DSH 插件（packages/dsh-plugin）

参照 `browser-skill-dsh-plugin` 的包结构：

- `package.json`：`dsh.bundle.patch: "./cordis.patch.yml"`；peerDeps 仅保留必需项（cordis / dsh-tools / dsh-llm / schemastery）；client UI 声明为可选（M4 再考虑 genui 管理面板）。
- `cordis.patch.yml`：

```yaml
- insert:
    - id: larklink
      name: "dsh-larklink"   # 必须与发布包名一致
```

- 注册三个模型工具（`defineTool`）：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `larklink_bindings` | `action: list/add/auth/remove/pin` + 各自参数 | 绑定管理；add/auth 返回 verification_url 由 Agent 展示 |
| `larklink_resolve` | `url` | 只路由不执行；返回 ResolveResult 或候选列表 |
| `larklink_exec` | `argv[]`, `profile?`, `url?`, `dryRun?` | 执行并透传；`profile`/`url` 至少其一 |

配套 `skills/larklink/SKILL.md`（DSH skill）：教模型何时 resolve、如何向用户展示歧义候选、如何处理 needsConfirmation、如何把 resolve 结果与 lark-* skill 串联（resolve → 用对应 profile 执行 docs +update 等）。

## 9. 安全设计

1. **凭证零落盘**：appSecret 仅 stdin 传入 lark-cli；registry / 日志 / 工具结果中不得出现 token、secret。
2. **门禁透传**：exit 10 → needsConfirmation → 用户显式同意 → `--yes` 重试原 argv；拒绝即终止。
3. **防串号**：写操作前强制 resolve 校验「当前 profile 的 brand/租户与 URL 匹配」；不匹配即拒绝执行并要求人工确认。
4. **审计日志**：`~/.larklink/audit.jsonl`（可关闭），记录每次 resolve 与 exec 的决策依据与命令摘要（不含敏感参数值）。
5. **最小授权**：绑定引导按业务域（`--domain docs,drive`）而非全量 scope。

## 10. 仓库结构与分支策略

```
dsh_larklink/
├── README.md
├── LICENSE
├── docs/
│   └── design.md            # 本文档
├── packages/
│   ├── core/                # 解析器 + 注册表 + 路由决策（纯 TS，vitest 单测）
│   ├── cli/                 # larklink 命令行入口
│   └── dsh-plugin/          # DSH cordis 插件（defineTool 薄适配）
└── skills/
    └── larklink/SKILL.md    # DSH 技能使用指南
```

- `dev`：开发主线（本方案与后续实现都进 dev）。
- `main`：稳定标签/发布快照，由 dev 合入。

## 11. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0（本次） | 仓库初始化、设计文档、README | 本 PR |
| M1 | core：URL 解析器 + registry + resolve 算法 | 单测覆盖各域名/路径/歧义分支；无任何 IO 副作用 |
| M2 | CLI：bindings 生命周期（add/auth/list/health/remove/pin）+ exec | 本机真实绑定第二个账号（Lark 国际版）端到端走通 |
| M3 | dsh-plugin 三工具 + SKILL.md | 在 DSH 会话中粘贴两个不同账号的文档 URL，自动路由并各自完成一次只读操作 |
| M4 | 审计日志、写操作守卫强化、（可选）genui 绑定管理面板 | 首个写操作（文档更新）在确认协议下完成 |

## 12. 开放问题（需要拍板）

1. **`larklink_exec` 的开放度**：透传任意 lark-cli 命令（灵活，靠门禁兜底）还是先收敛为白名单域（docs/drive）？→ 倾向：M3 先白名单，M4 视使用情况放开。
2. **歧义默认策略**：已决（审查 Q1=A）——本次显式指定 > 文档级 pin > 首次询问并可记住；记住的账号失效时修复授权或用户改选，不自动换账号写入。
3. **doubao.com 链接 / 裸 token**：已决（审查 Q3）——不做"默认 feishu"猜测；pins → 唯一绑定直选（sole）→ 询问并 pin。纯自然语言描述不进 v1，由 Agent 追问取得链接或 token。
4. **包名**：npm 发布名用 `dsh-larklink` 还是 `@timeryu288/dsh-larklink`（scope 版不占用裸名）？
5. **registry 位置**：`~/.larklink/` 还是放进 DSH profile 数据目录（随 profile 隔离）？→ 倾向前者：跨 profile/会话共享绑定。
