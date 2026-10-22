# @timeryu288/dsh-larklink

DeepSeek Harness 插件：多账号 lark-cli 路由 + 守卫式文档执行。

## 工具

| 工具 | 用途 |
|---|---|
| `larklink_resolve` | 文档 URL/裸 token → 绑定路由决策（或歧义候选+探测标注） |
| `larklink_exec` | 守卫式执行文档域 lark-cli 命令（目标比对 / 确认指纹 / timeout-unknown） |
| `larklink_bindings` | 无敏感绑定管理（adopt/list/health/pin）；add/auth/remove 走终端 |

随插件内嵌注册 `larklink` SKILL（多账号防串号硬纪律、写操作纪律、确认流程）。

## genui 面板（web）

- 后端：`/larklink/bindings`（GET，`?live=1` 实时核验）、`/larklink/adopt`、`/larklink/health`（POST）——同源栅栏（origin/host + sec-fetch-site）
- 前端：`lib/client.cjs` 注册 sidebar 右侧「Lark 绑定」页签——绑定状态灯（ready/needs_refresh/unauthorized/incomplete）、账号与品牌、文档 pin 列表、adopt/health 按钮，5s 自动刷新

## 安装（DSH）

```yaml
# cordis.patch.yml
- insert:
    - id: larklink
      name: "@timeryu288/dsh-larklink"
```

前置：lark-cli 已安装并可执行（或设 `LARKLINK_LARK_CLI` 指向原生二进制）。

## 设计

见仓库 [docs/design.md](../../docs/design.md)（决议 Q1-Q10）与 [README](../../README.md)。
