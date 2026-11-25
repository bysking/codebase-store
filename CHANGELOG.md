# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-11-25

### 修复（会丢数据 / 出错误结论）

- **管道输出被截断**：`cos verify --json | jq` 只拿到 65536 字节。根因是 `cli.ts`
  在模块顶层静态 import 了 MCP SDK，改变了进程退出路径上的 flush 行为；
  `process.exit()` 又不等 flush。改为在 `mcp` 分支内懒加载 SDK，并统一用
  `process.exitCode`。实测 211110 字节稳定完整。
- **索引里的坏行会在下次写入时永久消失**：`parseCodeVolume` 把解析失败的行
  直接丢弃，`cos_update` 重写文件就把它抹掉。现在坏行记入 `malformed`
  （带行号），`commitEntries` 整批拒绝（`malformed_volume`），
  `verify` / `cos_maintain` 显式暴露。
- **`writeAtomic` 对无分隔符路径切错目录**：`lastIndexOf(sep)` 返回 -1 时
  `slice(0, -1)` 砍掉末字符，把 `AGENTS.md` 写成 `AGENTS.m` 目录。改用 `dirname`。
- **Entry 路径可越界**：手写 `../../../etc/hostname` 进 `cos.code.txt` 会让
  `collectFacts` 读取仓库外文件。`loadState` 与写入路径现在都校验
  绝对路径 / `..` 段，失败关闭。
- **并发写入静默丢更新**：`commitEntries` 只在调用方主动传 `expectSha` 时才
  做 CAS。改为隐式 CAS —— 磁盘 sha 必须等于 `loadState` 时的快照。

### 修复（状态语义）

- `alignment` 不再把「还没有 Entry」误报成 `unbaselined`。新增 `Facts.hasBaseline`，
  `unbaselined` 只在基线真的不存在时成立；「没写 Entry」是 `authoring_required`。
- `cos verify` 现在报告并计入 `needAuthoring` / `needRemoval`，它们会让退出码非零。
  此前「✓ 无漂移」直接 exit 0，接进 CI 是一路假绿，而 `status` 显示覆盖 0%。
- `cos init --force` 现在同时重置 `baseline.json`，不再留下上一轮的指纹。
- `cos_overview` 改为**按行切块**，不再把一条 Entry 从中间切断
  （原文实测出现过 `":注意254"` 这样的半截输出）。
- `cos_overview` 的中间分块不再每块都重算 `collectFacts`，只在最后一块交付
  alignment 等结论性字段。

### 变更

- **baseline 格式 v1 → v2**：`files: Record<path, sha>` 改为
  `stamps: Record<path, {sha, size, mtimeMs}>`。旧文件会被自动升级，
  size/mtime 未知记 -1，比对时回落到 sha 路径，**不需要重跑 scan**。
- `collectFacts` 的 stale 判定有了 stat 快路径：size+mtime 未变即跳过读文件。
  实测 1500 文件 / 106 MB 仓库从 372ms 降到 74ms。
- `isIndexableSource` 判二进制只读文件头部 8000 字节，不再整读。
- `globToRe` 加编译缓存（原来每个文件×每条规则都重新编译正则）。
- 版本号改为从 `package.json` 单一来源读取（新增 `src/version.ts`），
  不再在 `cli.ts` / `mcp.ts` / `package.json` 各写一份。
- 删除 `config.json` 里从未生效的死字段 `locale` / `indexPath` / `refreshThreshold`；
  旧配置文件里的这些字段会被剔除并在 stderr 给出提示。
- `cos check` 的预算判定改用 `WHOLE_INDEX_BUDGET` 常量（原来硬编码 `240_000`），
  并启用此前定义了却没用过的 `warning` 警戒线。
- 删除未被引用的导出：`writeWithCas`、`RULES_BLOCK_ID`、`MAX_FRAME_BYTES`、`parseRootMeta`。
- `tsconfig.json` 的 `include` 扩展到 `test/` 与 `scripts/`；新增 `typecheck` 与
  `verify:all` 脚本。
- README 修正「运行需要 Bun ≥ 1.1」的不实描述 —— `src/` 已完全不依赖 `Bun.*`。

### 测试

- 新增 `test/p0.test.ts`、`test/stdout-pipe.test.ts`、`test/p1-p2.test.ts`，
  总计 64 → 119 个用例。
- 每个回归用例都在**回退对应修复后确认变红**，避免写成永远通过的假测试。
  其中管道测试必须走真实 shell 管道（`| cat | wc -c`）才能复现 ——
  `Bun.spawnSync({stdout:"pipe"})` 会把子进程跑完再读全量，看不到这个 bug。

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

[0.2.0]: https://github.com/bysking/codebase-store/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bysking/codebase-store/releases/tag/v0.1.0
