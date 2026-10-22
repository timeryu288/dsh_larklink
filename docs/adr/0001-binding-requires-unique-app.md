---
status: accepted
date: 2026-10-22
---

# 每个绑定使用独立应用（App ID）

设计审查 Q2 决议（选项 A）。lark-cli v1.0.76 的 profile 机制要求每个 profile 的 App ID 全局唯一（profile add 显式拒绝重复 appId），且每个 profile 只保留一个登录用户（新用户登录会删除旧用户 token），token 按 appId:userOpenId 存储。因此「同一应用绑定多个用户」在受支持的官方路径中不存在。v1 绑定与 profile 一一对应：一个绑定 = 一个独立开放平台应用 + 该应用下唯一授权用户，不加中间抽象层。

## Considered Options

- A（选定）：一绑定一应用，完全复用官方 profile 接口。
- B：必须支持同应用多用户——CLI 无逐请求选人入口，需自管 OAuth token 直调 OpenAPI 或多配置目录 hack（未验证、不受支持），推翻「lark-cli 是唯一执行引擎」的非目标。
- C：A + registry 绑定抽象层预留换后端——被否，v1 保持简单，真有需求时做数据迁移。

## Consequences

- 每添加一个绑定需在开放平台创建一个新应用；企业租户可能需管理员审批。产品界面与文档必须明示该约束。
- 未来若要支持同应用多用户，registry 数据模型需迁移（绑定 ≠ profile 名）。
- 证据链见 docs/design-review.md（profile/add.go、auth/token_store.go、auth/login.go、internal/core/config.go，均为 v1.0.76 tag）。
