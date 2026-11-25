# 基于 Bun 复刻方案

> 目标：保留 AOCI-CODE 的核心价值，砍掉 60~70% 的治理完备性代码，做一个**自己用着不烦**的认知索引 MCP。

---

## 一、砍什么 / 留什么

### 保留（核心价值，砍了就失去意义）

| 能力 | 理由 |
|---|---|
| **FRAS 格式** | 整个方法的载体，格式不保留就没法复用理解 |
| **Volume-first 布局**（Root/Meta/Code/Database） | 职责分离是「地图不是摘要」的物理保证 |
| **模型手写语义的不变量** | 程序代劳则索引信誉崩塌（见 `01-设计理念.md` 原则 1） |
| **S 字段两问准入 + 配额** | 信息密度全靠这个 |
| **Whole-Index 一次读入** | 「开工前认识系统」的核心体验 |
| **三角色 Managed Scope**（index/observe/exclude） | 负空间是认知 |
| **漂移检测**（Missing/Stale/Orphan/Unbaselined） | 增量维护的前提 |
| **标签字典 + 重要度分档** | 预算分配的依据 |

### 砍掉（治理完备性，个人用不上）

| 砍掉的 | 理由 | 省下的复杂度 |
|---|---|---|
| Legacy → Volumes 迁移（12 文件） | 新项目不需要历史包袱 | ~1500 行 |
| CAS 多层事务 + Recovery + Ledger | 单人不存在并发写 | ~800 行 |
| Attestation / Challenge 链（14 文件） | 保留 chunking，砍掉考证链 | ~1200 行 |
| Scope Change 正式流程（5 文件） | 改 JSON 配置文件即可 | ~600 行 |
| 签名包 / SBOM / cosign / 供应链自检 | 自己用不需要 | ~400 行 |
| 双 Locale（zh-CN + en-US） | 中文够用 | ~600 行（含模板） |
| 多宿主 Hook（6 宿主） | 只需 Claude Code / Codex | ~500 行 |
| UI 面板 | `cat` 索引文件就行 | ~1200 行 |
| System Cognition 投影（Lineage/Relations/Impact/Snapshot/Evolution） | 可后置 | ~900 行 |
| DB Evidence 多驱动 | 只留 PostgreSQL（或 SQLite 元数据） | ~700 行 |
| Repair Finding schema 体系 | 简化为「报错 + 原因」 | ~500 行 |
| `status --deep` / curation 文件级决策 / optimization | 用不上 | ~400 行 |

**结果：1820 文件 / 36 包 → 约 12 个 TS 文件 / 约 1600 行。**

---

## 二、目标架构

```
src/
├── core.ts        types + 常量(machine contract) + 工具函数 + token 估算
├── format.ts      标签解析 + Entry 解析/渲染 + 配额校验
├── repo.ts        配置 + git + scope + baseline + 原子写 + 状态事实聚合
├── commands.ts    init / scan / verify / check / status
├── mcp.ts         stdio JSON-RPC server
├── tools.ts       6 个 MCP 工具
├── templates.ts   zh-CN 模板（Root / Meta / Code / AGENTS.md）
└── cli.ts         命令分发入口
```

### MCP 工具：9 → 6

| AOCI-CODE（9） | 复刻版（6） | 变化 |
|---|---|---|
| `aoci_rules` | `cos_rules` | 保留（会话合同） |
| `aoci_overview` | `cos_overview` | 保留 chunking，砍掉 attestation/challenge |
| `aoci_get_entries` + `aoci_search` | `cos_search` | **合并**：既能按身份取，也能全文搜 |
| `aoci_maintain` | `cos_maintain` | 保留（核心状态机） |
| `aoci_update_entry` + `aoci_remove_entry` | `cos_update` | **合并**：`entry: null` 表示删除 |
| `aoci_report` | `cos_report` | 保留 |
| `aoci_header` | — | 砍（`cos_report` 里带上） |

### CLI：19 命令组 → 6 命令

```bash
cos init [--force]      # 初始化：写模板 + 配置文件
cos scan                # 按 git ignore 权威建基线
cos verify              # 报告 Missing/Stale/Orphan/Unbaselined
cos check               # 治理门禁（配额 + 覆盖 + 对齐）
cos status              # 人看的摘要
cos mcp                 # 启动 stdio MCP Server
```

---

## 三、关键技术决策

### 3.1 格式完全兼容 AOCI

`cos.txt` 用同样的 `#AOCI-ROOT-MANIFEST: 1` 标记？

**不。** 改用独立标记 `#COS-ROOT-MANIFEST: 1`，避免误读 AOCI 项目文件。但**内部结构（目录段 / Entry / FRAS / tag）完全一致**，这样：
- 你对 AOCI 的理解可直接迁移
- 未来想互通只需加一个标记别名

### 3.2 原子写：简化为「临时文件 + rename + CAS 校验」

AOCI 用平台原语（`renameat2`/`ReplaceFile`）做原子交换。Bun 版：

```ts
// 1. 读取原内容算 sha
// 2. 调用方传入 expectSha（CAS）
// 3. 不一致 → 失败关闭，不写
// 4. 写同目录临时文件
// 5. rename（POSIX rename 本身是原子的）
```

不需要 `RENAME_EXCHANGE`，因为**不需要「交换」语义**（我们从不「恢复移动」覆盖别人）。

### 3.3 并发：不加锁，用 CAS 兜底

- 个人使用不存在并发写
- 但 Agent 可能同一会话内连发两次 `cos_update`
- CAS（expectSha）+ 失败关闭足够，比跨进程锁简单一个数量级

### 3.4 交付证明：保留分块，砍掉考证链

保留：
- `chunk_tokens` 预算
- `next_cursor` 顺链读完
- `check_only` 轻量检查点

砍掉：
- Attestation 提交
- Challenge 考问
- receipt 身份链
- 压缩恢复状态机

**为什么这样砍还安全？** 因为个人使用时，Agent 少读几块索引的代价是「这次任务质量差一点」，而不是「团队治理事实被污染」。等真需要时再加。

### 3.5 基线用 SQLite（Bun 内置）

AOCI 用 `baseline.json`（自举项目 478KB）。Bun 版：

```
.codebase_store/baseline.json  → 小项目（< 2000 文件）直接 JSON
.codebase_store/baseline.db    → 大项目用 Bun 内置 bun:sqlite
```

先用 JSON，超过阈值自动切 SQLite。**这一条是 Bun 相对 Go 的净收益**——Go 版为了少一个依赖用了 JSON，Bun 内置 sqlite 零成本。

### 3.6 单二进制分发

```bash
bun build --compile --minify --target=bun src/cli.ts --outfile cos
```

产物是单文件可执行（内嵌 Bun runtime），对比 AOCI 的 CGO-free Go 二进制体验一致，但**无需交叉编译矩阵**（`--target=bun-linux-x64` 等按需产出）。

---

## 四、复刻后的使用流程（对比原版）

### 原版（AOCI-CODE）

```bash
# 1. 下载 + 校验签名包
gh release download v0.2.0-rc4 --repo aoci-spec/aoci-code
sha256sum -c ...
cosign verify-blob ...
# 2. 初始化
aoci --repo . init --locale zh-CN --agent codex
aoci --repo . scan
# 3. 【重启 Agent】
# 4. 让 Agent 建索引（20 万行 ≈ 1 小时）
# 5. 验证
aoci verify && aoci check
aoci capabilities && aoci doctor
```

### 复刻版

```bash
bun install
bun link          # 或者 bun build --compile

cos init
cos scan
# 重启 Agent（Claude Code 会自动加载 .mcp.json）
# 让 Agent: "读 cos_rules，然后建立索引"
cos verify
cos check
```

**减少的步骤**：签名校验、`--locale`、`--agent`（自动探测）、`capabilities`/`doctor`（合并进 `check`）。

---

## 五、实施顺序（建议 5 个阶段）

### 阶段 1：格式与只读（可验证）

```
core.ts + format.ts + repo.ts(只读部分) + commands.ts(scan/verify/status)
```

交付：能 `init` 出骨架、`scan` 出基线、`verify` 报漂移。
**验收**：手动编辑一个 Entry 后 `verify` 能报 Stale；删一个文件能报 Missing。

### 阶段 2：MCP 只读（可被 Agent 使用）

```
mcp.ts + tools.ts(cos_rules / cos_overview / cos_search / cos_report)
```

交付：Agent 能读全量索引。
**验收**：在 Claude Code 里问「这个项目的架构是什么」，Agent 调用 `cos_overview` 后能答出索引内容。

### 阶段 3：写入闭环（核心价值达成）

```
tools.ts(cos_maintain / cos_update) + repo.ts(原子写 + CAS)
```

交付：Agent 能自建索引。
**验收**：新项目上让 Agent「建立索引」，结束后 `cos check` 通过且 `completed`。

### 阶段 4：配额与质量

```
format.ts 配额校验 + check 分级报告
```

交付：索引密度可控，S 字段不超标。
**验收**：故意写一个 1000 字 S 到 C5 对象上，`check` 报配额违规。

### 阶段 5（可选）：扩展

- SQLite 基线（大项目）
- PostgreSQL DB Cognition
- `cos watch`（文件变更自动标脏）
- 单二进制 + Homebrew tap

---

## 六、与 AOCI-CODE 的能力对照表

| 能力 | AOCI-CODE | 复刻版 | 说明 |
|---|---|---|---|
| FRAS 格式 | ✅ | ✅ | 完全一致 |
| Volume 布局 | ✅ | ✅ | 完全一致 |
| 标签字典 | ✅ 双 Locale | ✅ zh-CN | |
| 配额校验 | ✅ 二进制权威 | ✅ 常量权威 | |
| Whole-Index 读入 | ✅ | ✅ | |
| 分块交付 | ✅ 14 文件 | ✅ 简化 | 砍 attestation |
| 三角色 Scope | ✅ | ✅ | |
| 漂移检测 | ✅ 7 种 | ✅ 4 种核心 | |
| 增量维护 | ✅ | ✅ | `cos_maintain` |
| CAS 写入 | ✅ 平台原语 | ✅ rename + CAS | |
| 事务 Recovery | ✅ | ❌ | 个人场景不需要 |
| Ledger 审计 | ✅ | ❌ | |
| Legacy 迁移 | ✅ 12 文件 | ❌ | |
| 数据库认知 | ✅ 4 库 | ⏳ 后置 | |
| 多宿主 Hook | ✅ 6 宿主 | ✅ 自动探测 1~2 | |
| UI 面板 | ✅ | ❌ | `cat` 即可 |
| 签名供应链 | ✅ | ❌ | |
| **代码量** | **1820 文件** | **~12 文件 / ~1600 行** | |
| **首次上手** | 8 步 | 3 步 | |

---

## 七、为什么 Bun 适合这件事

| Bun 特性 | 对复刻的价值 |
|---|---|
| TS 原生执行 | 改一行立刻跑，没有编译等待；AOCI 的 `make fast` 门槛直接消失 |
| `bun:sqlite` 内置 | 基线/索引缓存可以上 SQLite，零依赖 |
| `Bun.Glob` 内置 | Scope 规则匹配不用引第三方包 |
| `Bun.CryptoHasher` | SHA-256 指纹无需 `node:crypto` 包装 |
| `Bun.spawnSync` | git ignore 权威查询一行搞定 |
| `bun test` 内置 | 不需要 jest/vitest 配置 |
| `bun build --compile` | 单二进制分发，跨平台产出 |
| `Bun.file()` | 简洁的读写 API |

**唯一要注意的**：`bun build --compile` 产物约 50~90MB（内嵌 runtime），比 Go 的 15MB 大。如果介意，用 `bun --target=node` 走 Node 分发。

---

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| 索引质量不如 AOCI（因为缺 attestation 督促） | 在 `cos_rules` 里把 S 两问写成硬性检查条款；`check` 里加 S 质量启发式 |
| 模型懒得维护索引 | `cos_maintain` 返回 `next_action` 时**明确列出**待补对象；`check` 非零退出接入 CI |
| 首次建索引太慢 | 支持 `cos maintain --batch-size N` 分批，中断可续（基线记录已完成对象） |
| 从 AOCI 迁移过来 | 写一个 `cos import aoci` 读 legacy 格式转 Volume（约 80 行） |
| Bun 生态稳定性 | 核心只依赖 Bun 稳定 API（fs / sqlite / glob / crypto）；`mcp.ts` 手写 JSON-RPC 不引 SDK |

---

## 九、一句话结论

**可以做，而且应该做。**

AOCI-CODE 的核心洞察（认知资产化 + 模型写语义 + 失败关闭）是对的，但它的 1820 个文件里，真正产生价值的是那约 1600 行——剩下的是为了让「团队 + 多人 + 多宿主 + 供应链」都安全而付出的代价。

你一个人用，只需要那 1600 行。Bun 让你用一个下午把它跑起来。

实现骨架已在 `src/` 下，见根目录 `README.md`。
