# dsh_larklink

**DeepSeek Harness (DSH) 插件：同时绑定多个相互独立的 Lark/飞书账号，根据粘贴的文档 URL 自动切换对应账号执行文档操作。**

> 状态：🚧 开发中（M0-M3 已完成）· 设计方案见 [docs/design.md](docs/design.md) · 开发主线在 `dev` 分支

## 这是什么

[lark-cli](https://github.com/larksuite/cli) 原生支持多 profile（每个 profile 独立的品牌、应用凭证和用户授权），但没有「这条文档 URL 该用哪个账号」的路由层。dsh_larklink 补上这一层，并以 DSH 插件形态暴露给 AI Agent：

```
用户: "把这个文档改一下 https://xxx.feishu.cn/docx/Abc123"
      "顺便把这份 Lark 文档同步一下 https://tenant.larksuite.com/wiki/Wxyz789"

Agent:  ├─ larklink_resolve(url)  → { profile: "work-feishu", ... }   # 自动选账号
        ├─ larklink_exec(--url ..., -- docs +update ...)             # 用正确账号执行
        └─ larklink_resolve(url2) → { profile: "intl-lark", ... }
```

## 核心特性

- **多账号并存**：飞书（国内）与 Lark（国际版）、多个租户、多个个人账号同时绑定，互不干扰——底层复用 `lark-cli` 原生 profile 隔离，token 不落插件。
- **URL 自动路由**：按域名判品牌（`feishu.cn` / `larksuite.com` / `doubao.com`），按路径判资源类型（docx / wiki / sheets / base / slides…），歧义时展示候选让用户选一次并记住（pin）。
- **安全协议透传**：高风险写操作的 exit-10 确认门禁、`--dry-run` 预览、`ok == true` 成功判定全部沿用 lark-cli 契约，插件只做转发，不绕过任何门禁。
- **可独立使用**：核心是 `larklink` CLI（路由 / 绑定管理 / 执行器），DSH 插件只是薄适配层。

## 架构一览

```
DSH Agent ── larklink_* 工具 ── dsh-plugin（薄适配）
                                   │
                              larklink CLI（resolve / bindings / exec）
                                   │                    │
                            registry.json          lark-cli --profile <n>
                           （路由元数据，无密钥）      （唯一执行引擎，多账号授权隔离）
```

## 计划的交付物

| 包 | 说明 | 状态 |
| --- | --- | --- |
| `packages/core` | URL/裸 token 解析器、注册表、路由决策（纯 TS，可单测） | ✅ |
| `packages/cli` | `larklink` 命令行：`bindings adopt/add/auth/list/health/remove/pin`、`resolve`（含探测）、`exec`（守卫链） | ✅ |
| `packages/plugin` | DSH cordis 插件 `@timeryu288/dsh-larklink`：`larklink_bindings` / `larklink_resolve` / `larklink_exec` 三工具 + 内嵌 SKILL | ✅（未发布） |

## 路线图

- [x] **M0** 仓库初始化 + 设计方案 + 十轮设计审查（[design-review](docs/design-review.md)，Q1-Q10 全决）
- [x] **M1** core：解析器 + 注册表 + resolve（44 单测）
- [x] **M2** CLI：绑定生命周期 + exec 守卫链（真机 adopt/health/resolve 冒烟通过）
- [x] **M3** DSH 插件三工具 + 内嵌 SKILL（bundle 构建通过）
- [x] **M3.5** genui 绑定管理面板：webServer 路由（`/larklink/bindings|adopt|health`，同源栅栏）+ sidebar「Lark 绑定」页签（状态灯/账号列表/adopt/health/pins；add/auth/remove 仍限终端）
- [ ] **M4** npm 发布（待 npm login）、真机双账号端到端验收

## 快速上手（开发）

```bash
pnpm install
pnpm test            # 85 单测
pnpm larklink --help # CLI
pnpm build:plugin    # 构建 DSH 插件 bundle（packages/plugin/lib/index.mjs）
```

绑定管理（终端，密钥不经模型）：`larklink bindings adopt`（导入既有 lark-cli profile）→ `add`（新应用，app secret 走 stdin）→ `auth`（扫码 split-flow）。

## 文档

- [设计方案（含已验证事实、路由算法、安全设计、开放问题）](docs/design.md)

## License

见 [LICENSE](LICENSE)。
