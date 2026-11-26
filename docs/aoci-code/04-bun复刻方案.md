# 基于 Bun 复刻方案

> 目标：保留 AOCI-CODE 的核心价值，砍掉 60~70% 的治理完备性代码，做一个**自己用着不烦**的认知索引 MCP。
>
> 本文档描述**已落地**的实现（v0.2.0）。与早期规划稿的差异见文末「十一、规划稿 → 实际实现的偏差」。

---

## 一、砍什么 / 留什么

### 保留（核心价值，砍了就失去意义）

| 能力 | 理由 |
|---|---|
| FRAS 格式 | 整个方法的载体，格式不保留就没法复用理解 |
| Volume-first 布局（Root/Meta/Code） | 职责分离是「地图不是摘要」的物理保证 |
| 模型手写语义的不变量 | 程序代劳则索引信誉崩塌（见 `01-设计理念.md` 原则 1） |
| S 字段两问准入 + 配额 | 信息密度全靠这个 |
| Whole-Index 一次读入 | 「开工前认识系统」的核心体验 |
| 三角色 Managed Scope（index/observe/exclude） | 负空间是认知 |
| 漂移检测（Malformed/Missing/Orphan/Stale/Unbaselined） | 增量维护的前提 |
| 标签字典 + 重要度分档 | 预算分配的依据 |

### 砍掉（治理完备性，个人用不上）

| 砍掉的 | 理由 | 省下的复杂度 |
|---|---|---|
| Legacy → Volumes 迁移（12 文件） | 新项目不需要历史包袱 | ~1500 行 |
| 多层事务 + Recovery + Ledger | 单人不存在并发写 | ~800 行 |
| Attestation / Challenge 链（14 文件） | 保留 chunking，砍掉考证链 | ~1200 行 |
| Scope Change 正式流程（5 文件） | 改 JSON 配置文件即可 | ~600 行 |
| 签名包 / SBOM / cosign / 供应链自检 | 自己用不需要 | ~400 行 |
| 双 Locale（zh-CN + en-US） | 中文够用 | ~600 行（含模板） |
| 多宿主 Hook（6 宿主） | 只需 Claude Code / Codex | ~500 行 |
| UI 面板 | `cat` 索引文件就行 | ~1200 行 |
| System Cognition 投影（Lineage/Relations/Impact/Snapshot/Evolution） | 可后置 | ~900 行 |
| DB Evidence 多驱动 | 只留占位引用格式 | ~700 行 |
| Repair Finding schema 体系 | 简化为「报错 + 原因」 | ~500 行 |
| `status --deep` / curation 文件级决策 / optimization | 用不上 | ~400 行 |

**结果：1820 文件 / 36 包 → 8 个 TS 文件 / 2632 行 + 8 个测试文件。**

---

## 二、实际架构

```
src/
├── core.ts       258 行  types + machine contract 常量 + 工具函数 + token 估算
├── format.ts     263 行  标签解析 + Entry 解析/渲染 + 配额校验 + 关系校验 + 回读校验
├── repo.ts       866 行  配置 + git + scope + baseline + 原子写 + 状态事实聚合 + init/scan
├── commands.ts   240 行  init / scan / verify / check / status（终端 UI）
├── mcp.ts        139 行  MCP 层（官方 SDK，不含业务逻辑）
├── tools.ts      628 行  6 个 MCP 工具的定义与 handler
├── cli.ts        190 行  参数解析 + 命令分发 + 仓库定位
└── version.ts     48 行  从 package.json 回溯版本号

bin/cos.mjs               构建产物（npx 用的预编译单文件，71KB）
scripts/build-npm.ts      预编译构建脚本
test/*.test.ts            8 个测试文件 / 119 测试 / 256 断言
```

**与规划稿的容量对照**

| 文件 | 规划 | 实际 | 说明 |
|---|---|---|---|
| core.ts | — | 258 | 规划里是「types + 常量 + 工具 + token 估算」 |
| format.ts | — | 263 | 多了关系校验、回读校验 |
| repo.ts | — | 866 | “最超预期“：吸收了 init/scan/state/facts/commit 全部逻辑 |
| commands.ts | — | 240 | 纯输出层，带 ANSI 色彩 |
| mcp.ts | — | 139 | 从 248 行手写降到 139 行 SDK 版（见 ADR） |
| tools.ts | — | 628 | 6 个工具的 description 与 handler 都在这 |
| cli.ts | — | 190 | |
| version.ts | — | 48 | 规划里没有，为 npx/单二进制回溯版本而加 |
| “合计“ | “~1600 行“ | “2632 行“ | 超出预算 65%，主要来自 repo.ts |

### 为什么 repo.ts 涨到 866 行

规划里 `repo.ts` 只写「配置 + git + scope + baseline + 原子写 + 状态事实聚合」，
实际它还承担了：

- `initRepo` / `scanRepo`：模板渲染、AGENTS.md 规则块注入（`upsertBlock` 幂等合并）
- `loadState` / `collectFacts`：五类漂移 + 待创作/待删除 + 配额 + token 预算 + `alignment` 判定
- `commitEntries`：CAS + 配额 + 关系 + 三道路径校验 + 回读校验 + 基线刷新
- `writeAtomic` / `assertRepoRelativePath` / `isIndexableSource`

这些是**安全与正确性的集中点**，拆散反而更难审计，所以保持单文件。

---

## 三、MCP 工具：9 → 6

| AOCI-CODE（9） | 复刻版（6） | 变化 |
|---|---|---|
| `aoci_rules` | `cos_rules` | 保留（会话合同），`needsRepo: false` |
| `aoci_overview` | `cos_overview` | 保留按行分块，砍掉 attestation/challenge |
| `aoci_get_entries` + `aoci_search` | `cos_search` | 合并：既能按身份取，也能全文搜 |
| `aoci_maintain` | `cos_maintain` | 保留（权威状态机唯一入口） |
| `aoci_update_entry` + `aoci_remove_entry` | `cos_update` | 合并：`upserts` + `removals` |
| `aoci_report` | `cos_report` | 保留 |
| `aoci_header` | — | 砍（`cos_report` 里带 `header` 字段） |

### `cos_maintain` 的状态机（实际实现）

无参数调用，服务端算出 `nextAction`，按优先级返回：

| 优先级 | nextAction / phase | 触发条件 |
|---|---|---|
| 1 | `repair_required` / `malformed_volume` | 索引里有解析不了的行（写入会丢数据，必须人工修） |
| 2 | `authoring_required` / `removal` | 有 Entry 失效（文件不在，或对象不再是 index 角色） |
| 3 | `authoring_required` / `first_index` 或 `incremental` | 有受管文件还没 Entry |
| 4 | `review_required` / `stale_review` | 源码变了，Entry 可能过期 |
| 5 | `review_required` / `quota` | 配额超限 |
| 6 | `none` / `aligned` | 索引与代码一致 |

每批返回 `targets`（含 `suggestedTag`、文件 `hash`、`currentEntry`）+ `remaining`，
Agent 按批推进即可，`limit` 默认 10、上限 50。

### MCP 层用官方 SDK（不手写）

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
```

**职责边界**

| SDK 负责 | 本项目负责 |
|---|---|
| JSON-RPC 帧解析与序列化 | 6 个工具的业务逻辑 |
| initialize 握手、protocolVersion 协商 | 每次调用重新解析仓库 |
| tools/list、tools/call 分发 | 错误转成可照做的修复提示 |
| zod → JSON Schema 转换 | 配额/关系/回读三道校验 |
| 入参类型校验（调用前拒绝非法类型） | — |

`inputSchema` 用 zod raw shape，不再手写 JSON Schema。

**两个必须记住的陷阱**（详细排查过程见 `adr/cog-mcp-使用官方sdk而非手写json-rpc`）

1. **启动绝不能因环境问题退出**：宿主会在任意 cwd 启动 server。仓库定位失败若 `throw`，
   进程秒退，宿主只报「MCP 连接失败」，真实原因丢失。正确做法是把探测结果只用于打日志，
   把错误推迟到具体工具调用，以 `isError: true` 返回修复步骤。
2. **SDK 的 `connect()` 不阻塞**：它注册监听器后立即 resolve。若 `main()` 随后返回，
   `process.exit` 会杀掉 server。必须显式挂住进程：

```ts
await server.connect(transport);
await new Promise<void>((resolveHold) => {
  const stop = () => resolveHold();
  process.stdin.once("end", stop);   // 宿主关掉 pipe
  process.stdin.once("close", stop);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
});
```

配套设计：`ToolDef.needsRepo?: boolean`，`cos_rules` 设为 `false` —— 它只返回静态会话合同，
不碰仓库，因此即使 cwd 不对，Agent 也能读到「怎么用、怎么修」。

---

## 四、CLI：19 命令组 → 6 命令

```bash
cos init [--force]      # 初始化：Root/Meta/Code 模板 + config.json + AGENTS.md 规则块
cos scan [--force]      # 按 git ignore 权威建基线
cos verify [--json]     # 报告漂移 + 待创作/待删除（有则退出码 1）
cos check  [--json]     # 治理门禁（配额 + 覆盖 + 对齐），非零退出可接 CI
cos status              # 人看的摘要
cos mcp                 # 启动 stdio MCP Server
```

全局选项：`--repo <path>`（显式指定仓库根）、`--force`、`--json`、`-h`、`-v`。

### 仓库定位规则

除 `init` 外，所有命令**从当前目录向上逐层查找最近的 `.codebase_store/`**。
这样子目录里跑命令也能命中项目索引，多项目共存互不干扰。

MCP 模式不固定仓库时，**每次工具调用都重新解析** —— 宿主把 cwd 设在哪个项目，
就作用于哪个项目，一份 MCP 配置可服务多个项目。

### 两个进程退出细节（都踩过）

```ts
// 1) 用 exitCode 而不是 process.exit()：
//    process.exit 会立刻杀进程，尚未 flush 的 stdout 直接丢弃
//    → `cos verify --json | jq` 只拿到半截 JSON
main().then((code) => { process.exitCode = code; })

// 2) MCP SDK 懒加载：
//    cli.ts 若在模块顶层静态 import SDK，会改变进程退出路径上的 flush 行为
//    实测管道输出被截断到 65536 字节。改为在 `mcp` 分支内才 import()
```

---

## 五、关键技术决策

### 5.1 格式独立标记，结构完全兼容

```
#COS-ROOT-MANIFEST: 1     ← 独立前缀，避免误读 AOCI 项目文件
#COS-META-VOLUME: 1
#COS-CODE-VOLUME: 1
#Format-Version: cognition-volumes/v1
#Object-Protocol: cognition-object/v1
```

**内部结构（目录段 / Entry / FRAS / tag）完全一致**，所以：

- 你对 AOCI 的理解可直接迁移
- 未来想互通只需加一个标记别名

目录段用中性根 `===/<repository>/<dir>/===`，非法根会拒绝重定位（`unsafe_section_root`）。

### 5.2 原子写：临时文件 + rename

```ts
const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
try {
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p);       // POSIX rename 本身是原子
} catch (err) {
  try { rmSync(tmp, { force: true }); } catch {}
  throw err;
}
```

不需要 `RENAME_EXCHANGE`，因为不存在「交换」语义（从不「恢复移动」覆盖别人）。

⚠️ **踩过的坑**：早期用 `lastIndexOf(sep)` 切目录，无分隔符路径（`AGENTS.md`）返回 -1，
`slice(0, -1)` 砍掉末字符，把 `AGENTS.md` 写成 `AGENTS.m` 目录。改用 `dirname`。

### 5.3 并发：不加锁，用隐式 CAS 兜底

个人使用不存在并发写，但 Agent 可能同一会话内连发两次 `cos_update`。

**实际实现是隐式 CAS**（早期只做显式 CAS，导致静默丢更新）：

```ts
// 磁盘当前 sha 必须等于 loadState 时的快照，否则拒绝
const snapshotSha = state.codeText === "" && currentSha === null ? null : sha256(state.codeText);
if (snapshotSha !== currentSha) {
  throw new CosError(`CAS 失败：cos.code.txt 在你读取之后被改动过…`, "cas_conflict");
}
// 调用方还可额外传 expectSha 做双保险
```

失败关闭，比跨进程锁简单一个数量级。

### 5.4 交付证明：保留分块，砍掉考证链

**保留**
- `chunkTokens` 预算（默认 7000，范围 4000~24000）
- `nextCursor` 顺链读完
- `checkOnly` 轻量检查点
- **只在行边界切块**（`chunkOverview`）：Entry 是「一行一条」的自包含记录，
  从中间切开模型会读到 `":注意254"` 这种半截文本，既不知道为何断也拼不回原意。
  实测按字节切的产物里，`chunk[1]` 首行就是一条被腰斩的 Entry。
- **单行超预算时退回按字符切**：极长的 S 字段或单条 Meta 说明怎么切都会断，
  但至少不会把一条 Entry 拆到两个 chunk 里和其它 Entry 混在一起
- 中间分块不重复重算 `collectFacts`，只在最后一块给结论性字段

**砍掉**
- Attestation 提交、Challenge 考问、receipt 身份链、压缩恢复状态机

**为什么这样砍还安全？** 个人使用时，Agent 少读几块索引的代价是「这次任务质量差一点」，
而不是「团队治理事实被污染」。等真需要时再加。

### 5.5 基线：JSON（script 内置 sqlite 待启用）

AOCI 用 `baseline.json`（自举项目 478KB）。当前实现：

```
.codebase_store/baseline.json    ← version: 2
  stamps:   { path: { sha, size, mtimeMs } }   ← 快速变更判定
  entries:  { path: sha256(JSON(entry)) }      ← Entry 内容指纹
  source:   { path: "indexed" }                ← 来源标记
```

变更判定走**两级**：先比 `size + mtimeMs`（命中即认为未变），未命中再算 sha —— 大仓库快得多。

`readBaseline` 兼容 `version: 1` 的 `files: { path: sha }` 旧格式（自动升级）。
**SQLite 切换尚未实现**，仍在规划中（见 §9 阶段 5）。

### 5.6 双入口分发（实际做法，不只有单二进制）

| 入口 | 命令 | 适用 |
|---|---|---|
| `npx @bysking/codebase-store` | 跑 `bin/cos.mjs`（预编译单文件，71KB） | 只有 Node ≥18 |
| `bunx @bysking/codebase-store` | 跑 `src/cli.ts`（TS 源码） | 有 Bun，启动更快 |
| `cos`（全局安装） | 同上，最快 | 常驻使用 |
| 单二进制 | `bun build --compile --minify src/cli.ts --outfile cos` | 61MB（内嵌 runtime） |

预编译版用 `target: "node"`，所以没装 Bun 也能跑。`bin/cos.mjs` 由
`scripts/build-npm.ts` 生成，`prepack` 自动触发 —— 测试里专门有
`dist-freshness.test.ts` 校验产物与源码同源（防止改了 src 忘记重建就发版）。

---

## 六、使用流程

### 原版（AOCI-CODE）

```bash
gh release download v0.2.0-rc4 --repo aoci-spec/aoci-code
sha256sum -c ... && cosign verify-blob ...     # 签名校验
aoci --repo . init --locale zh-CN --agent codex
aoci --repo . scan
# 【重启 Agent】
# 让 Agent 建索引（20 万行 ≈ 1 小时）
aoci verify && aoci check
aoci capabilities && aoci doctor
```

### 复刻版

```bash
npx -y @bysking/codebase-store init      # 或 cos init
cos scan
# 在 Agent 里加 MCP 配置（init 会直接打印出来），重启
# 对 Agent 说：读 cos_rules，然后建立索引
cos verify && cos check
```

**减少的步骤**：签名校验、`--locale`、`--agent`（自动探测）、`capabilities`/`doctor`（合并进 `check`）。

### MCP 配置（`init` 会打印）

```json
{
  "mcpServers": {
    "cos": { "command": "npx", "args": ["-y", "@bysking/codebase-store", "mcp"] }
  }
}
```

不写 `--repo` 时，server 按宿主 cwd 向上找 `.codebase_store`，**一份配置服务多个项目**。
若宿主不保证 cwd 在项目内，再加 `"--repo", "<abs path>"`。

---

## 七、实施顺序（实际 5 个阶段，已全部完成）

### 阶段 1：格式与只读 ✅

```
core.ts + format.ts + repo.ts(只读) + commands.ts(scan/verify/status)
```

验收：手动编辑 Entry 后 `verify` 报 Stale；删文件报 Missing。
`test/format.test.ts`（9 测试）、`test/layout.test.ts`（5 测试）覆盖。

### 阶段 2：MCP 只读 ✅

```
mcp.ts + tools.ts(cos_rules / cos_overview / cos_search / cos_report)
```

验收：Agent 调用 `cos_overview` 能答出索引内容。

### 阶段 3：写入闭环 ✅

```
tools.ts(cos_maintain / cos_update) + repo.ts(原子写 + CAS)
```

验收：新项目让 Agent「建立索引」，结束后 `cos check` 通过且 `aligned`。
`test/p0.test.ts`（5 测试）、`test/p1-p2.test.ts`（7 测试）覆盖。

### 阶段 4：配额与质量 ✅

```
format.ts 配额校验 + check 分级报告
```

验收：故意写超长 S 到 C5 对象，`check` 报配额违规且退出码为 1。

### 阶段 5（未完成）：扩展

- ⏳ SQLite 基线（大项目）
- ⏳ PostgreSQL DB Cognition
- ⏳ `cos watch`（文件变更自动标脏）
- ✅ 双入口分发（npx 预编译 + bunx 源码）
- ⏳ Homebrew tap

---

## 八、与 AOCI-CODE 的能力对照表

| 能力 | AOCI-CODE | 复刻版 | 说明 |
|---|---|---|---|
| FRAS 格式 | ✅ | ✅ | 完全一致 |
| Volume 布局 | ✅ | ✅ | Root / Meta / Code |
| 标签字典 | ✅ 双 Locale | ✅ zh-CN | |
| 配额校验 | ✅ 二进制权威 | ✅ 常量权威 | `FIELD_QUOTA` 按 C 分档 |
| Whole-Index 读入 | ✅ | ✅ | 预算 120k / 警告 180k / 上限 240k token |
| 分块交付 | ✅ 14 文件 | ✅ 按行切块 | 砍 attestation |
| 三角色 Scope | ✅ | ✅ | index / observe / exclude |
| 漂移检测 | ✅ 7 种 | ✅ 5 种 | + malformed / needAuthoring / needRemoval |
| 增量维护 | ✅ | ✅ | `cos_maintain` 状态机 |
| CAS 写入 | ✅ 平台原语 | ✅ 隐式 CAS + rename | |
| 回读校验 | ✅ | ✅ | `roundTripCheck` 写前验证 |
| 事务 Recovery | ✅ | ❌ | 个人场景不需要 |
| Ledger 审计 | ✅ | ❌ | |
| Legacy 迁移 | ✅ 12 文件 | ❌ | |
| 数据库认知 | ✅ 4 库 | ⏳ 仅 `database://` 占位 | |
| 多宿主 Hook | ✅ 6 宿主 | ✅ AGENTS.md 规则块 | |
| UI 面板 | ✅ | ❌ | `cat` 即可 |
| 签名供应链 | ✅ | ❌ | |
| MCP 协议层 | 官方 SDK | ✅ 官方 SDK + zod | |
| **代码量** | **1820 文件** | **8 文件 / 2632 行 + 8 测试文件** | |
| **测试** | 全套 | **119 测试 / 256 断言** | |
| **首次上手** | 8 步 | 3 步 | |

---

## 九、为什么 Bun 适合这件事

| Bun 特性 | 对复刻的价值 |
|---|---|
| TS 原生执行 | 改一行立刻跑，没有编译等待 |
| `bun test` 内置 | 119 个测试零配置，`bun test` 2.17s 跑完 |
| `bun build --compile` | 单二进制分发（本机实测 61MB） |
| `bun build --target=node` | 预编译版能给纯 Node 用户用（`bin/cos.mjs`） |
| 启动快 | `bunx` 走源码，比 npx 拉起更快 |
| 原生 `spawnSync` | `git ls-files -z` 权威枚举一行搞定 |

**实际取舍**：`bun:sqlite` 与 `Bun.Glob` 没有采用 —— glob 自实现
（`globToRe`，~40 行，带缓存），基线仍是 JSON。原因是这两处不是瓶颈，
引 Bun 专有 API 会让「纯 Node 也能跑」的预编译入口受限。

**唯一要接受的**：`bun build --compile` 产物 61MB（内嵌 runtime），比 Go 的 15MB 大。
介意就用 `npx` 预编译版（仅 71KB，因为不内嵌 runtime，靠宿主 Node 跑）。

---

## 十、风险与对策（含实际结果）

| 风险 | 对策 | 实际状态 |
|---|---|---|
| 索引质量不如 AOCI（缺 attestation 督促） | `cos_rules` 把 S 两问写成硬性条款；`cos_update` 配额拒绝并提示收紧 | ✅ 已实现 |
| 模型懒得维护索引 | `cos_maintain` 明确列 `targets` + `remaining`，分批推进 | ✅ 已实现 |
| 首次建索引太慢 | `limit` 分批（1~50），基线记录已完成的 | ✅ 已实现 |
| 从 AOCI 迁移 | 未实现 `cos import aoci` | ⏳ 仍缺 |
| Bun 生态稳定性 | 已改用官方 MCP SDK；服务端只用稳定 node API | ✅ 已缓解 |
| 管道输出被截断 | 用 `exitCode` + MCP SDK 懒加载 | ✅ 已修复（见 §4） |
| 坏行被静默丢弃 | `malformed` 记录行号 + 写入整批拒绝 | ✅ 已修复 |
| 静默丢更新 | 隐式 CAS | ✅ 已修复 |

---

## 十一、规划稿 → 实际实现的偏差

早期规划稿（本文件的历史版本）有以下判断已被实际实现推翻，记录下来避免后来者重复踩：

| 规划稿说 | 实际 | 为什么改 |
|---|---|---|
| `mcp.ts` **手写 JSON-RPC，不引 SDK** | ✅ 改用官方 `@modelcontextprotocol/sdk` + zod | 手写版 bug 症状是「连接失败」这种零信息量提示，调试成本远高于依赖成本。`mcp.ts` 从 248 → 139 行 |
| 基线「先用 JSON，超阈值自动切 SQLite」 | ❌ 只有 JSON，未做阈值切换 | 实测 JSON 足够，切换不是瓶颈，没必要增加分支 |
| `Bun.Glob` 内置，Scope 规则匹配不用引第三方包 | ✅ 不用 Bun.Glob，自实现 `globToRe` | 保持纯 Node 可跑（预编译入口限制） |
| `bun:sqlite` 基线零成本 | ❌ 未采用 | 同上 |
| 单二进制是唯一分发方式 | ✅ 双入口（npx 预编译 + bunx 源码 + 单二进制） | 用户可能没装 Bun |
| 「约 12 个 TS 文件 / 约 1600 行」 | ✅ 8 文件 / 2632 行 | 实际把 init/scan/state/facts 收进 repo.ts，文件更少但行数更多 |
| 漂移 4 种核心 | ✅ 5 种 + 待创作/待删除 | malformed 是丢数据的隐患，必须显式 |
| `cos check` 合并 capabilities/doctor | ✅ 已合并 | — |

---

## 十二、一句话结论

**可以做，而且做完了。**

AOCI-CODE 的核心洞察（认知资产化 + 模型写语义 + 失败关闭）是对的，但它的 1820 个文件里，
真正产生价值的是那约 2600 行 —— 剩下的是为了让「团队 + 多人 + 多宿主 + 供应链」都安全而付出的代价。

你一个人用，只需要那 2600 行。Bun 让你用一个下午把它跑起来，
**再用一个下午把「会丢数据的地方」逐个焊死**（隐式 CAS、坏行拒绝、回读校验、路径越界拦截、
管道截断、SDK 挂住进程）—— 这部分比写索引逻辑更花时间，也是这个项目真正的价值所在。

实现见 `src/`，测试见 `test/`，接入见根目录 `README.md`。
