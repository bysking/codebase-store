# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-11-25

首个发布版本。

### 新增

- **认知索引格式**：`cos.txt`（Root）+ `cos.meta.txt`（Meta）+ `cos.code.txt`（Code Volume），
  全部为纯文本，可由 Git 版本化与 diff。
- **FRAS 条目模型**：每个受管文件一条记录，包含 Function / Relations / API / Non-obvious 四个字段。
- **按重要度分档的配额**：C9-8 / C7-4 / C3-1 三档，分别限制 F/R/A/S 字符数；配额在代码里强制，
  改索引文本放宽不了。
- **6 个 MCP 工具**（基于官方 `@modelcontextprotocol/sdk`）：
  - `cos_rules` — 会话合同，说明怎么用索引、FRAS 怎么写、什么是禁止的
  - `cos_overview` — 交付完整索引，超预算时分块并返回 `nextCursor`
  - `cos_search` — 按路径精确取，或按关键词/标签检索
  - `cos_maintain` — 权威状态机，无参数调用返回 `nextAction`
  - `cos_update` — 写入或删除条目，带配额/引用/回读三重校验
  - `cos_report` — 治理报告，含 `root`、`rootSource`、`codeSha`
- **6 个 CLI 命令**：`init` / `scan` / `verify` / `check` / `status` / `mcp`。
- **向上查找仓库定位**：除 `init` 外，命令从 cwd 向上查找最近的 `.codebase_store/`；
  MCP 模式每次工具调用重新解析，一份配置可服务多个项目。
- **三角色 Managed Scope**：`index` / `observe` / `exclude`，负空间同样是认知。
- **四种漂移检测**：missing / orphan / stale / unbaselined。
- **写入安全**：临时文件 + rename 原子替换、CAS 冲突检测、写入前回读校验。

### 已知限制

- 仅支持 Git 仓库的文件枚举权威；无 git 时回退到目录遍历。
- 无并发写保护（CAS 兜底），多人同时写同一索引会有一方失败。
- 无 attestation 链，Agent 可能少读几个 chunk。
- token 估算为启发式（CJK 1 字 = 1 token，ASCII 4 字符 = 1 token）。
- 运行需要 Bun ≥ 1.1。

[Unreleased]: https://github.com/bysking/codebase-store/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bysking/codebase-store/releases/tag/v0.1.0
