# codebase-store — 仓库认知索引 MCP

> [AOCI-CODE](https://github.com/aoci-spec/aoci-code) 的精简复刻。**1820 个 Go 文件 → 8 个 TS 文件 / 约 2600 行。**

让模型为每个受管文件手写一行「这东西是干嘛的、和谁强关联、对外契约是什么、什么不能改坏」，
存成 Git 可版本化的纯文本。Agent **开工前读一次索引就认识整个系统**，不用每个任务重新 grep。

```text
gitignore[OC5T]: F:声明本仓库不进入版本控制的路径 | R:- | A:- | S:-
atomic.go[CG9L]: F:提供持久化替换 CAS、原子写入和禁止覆盖的恢复移动 | R:code:internal/fs/lock.go | A:AtomicWrite,AtomicWriteCAS | S:原生发布绝不降级为覆盖式重命名；遇到竞态或无法验证的字节时必须保留第三方状态并失败关闭
```

---

## 先说清楚它的分量：AOCI-CODE

这套方法的原始设计来自 **[AOCI-CODE](https://github.com/aoci-spec/aoci-code)**。
如果你只读一段 README，请读下面这段，而不是本项目的用法。

AOCI-CODE 解决的是一个真问题，而且它给的答案不是「再叠一层检索」：

| 常见做法 | AOCI-CODE |
|---|---|
| 提问时临时检索，拿到命中的片段 | 平时维护，提问之前就已经存在 |
| 回答「在哪」「谁调谁」 | 回答「是什么、为什么存在、什么不能改」 |
| 运行时向量库 / 图库，一次性 | 仓库里的纯文本，Git 版本化，随代码增量演进 |

它把改造对象从「检索质量」换成了「Agent 的成本结构」——与其让模型搜得更准，
不如让它**不用搜**。围绕这一点立了四条支柱：模型写语义 / 程序管治理 / 地图不是摘要 /
负空间也是认知。其中第一条最狠：程序**禁止**生成、预填、摘要、压缩、补全 F/R/A/S。
这看起来是给自己上镣铐，实际是整件事能否可信的地基 —— 一份由程序猜出来的索引，
模型迟早会发现它在骗人，然后安静地退回 grep。

它也不是概念稿：`internal/` 下 36 个包、9 个 MCP 工具，迁移层、事务 + Recovery、
attestation 链、供应链自检全都做了（FSL-1.1-MIT）。**如果你维护的是真实复杂系统、
需要多人协作与可审计的治理完备性，请直接用它** —— 那是完整形态。

我把它的设计逐条拆过一遍，笔记在 `docs/aoci-code/`，尤其 `01-设计理念.md`
（连「复杂度到底从哪来」都诚实盘点了）。

## 那为什么还有这个项目

因为完整形态的重量，多数个人项目其实扛不住：迁移层、事务 + Recovery + Ledger、
attestation 链、签名包 / SBOM、双 locale、6 宿主 Hook、UI 面板 —— 这几项加起来约 9000 行，
一个人开发时是纯负担。改一项 scope 还要走正式的 Scope Change 流程，而我只是想改个 JSON。

所以这里做的是**同一个方法，卸掉治理盔甲**：

| | AOCI-CODE | 本项目 |
|---|---|---|
| 形态 | 1820 文件 / 36 个包 / 9 工具 | 8 个 TS 文件 / 约 2600 行 / 6 工具 |
| 运行时 | Go 二进制 | `npx` 预编译 JS，或 `bunx` 直跑 TS 源码 |
| 写入安全 | 多层事务 + 考证链 + 供应链自检 | 隐式 CAS + 回读校验 + 失败关闭 |
| 适用 | 团队、复杂系统、需要审计 | 一个人、一个仓库、想立刻开始 |

砍掉的都是**治理完备性**，留下的都是**方法本身**：FRAS、Volume 布局、
「语义只能由模型写」、S 两问准入、Whole-Index 一次读入、三角色 scope、漂移检测。
索引格式照着它的协议实现（版本号略有差异，概念上可直接迁移）。

**如果你愿意，也欢迎试试这个项目**——一条命令就能开始：

```bash
npx @bysking/codebase-store init    # 或 bunx，见下一节
```

跑十分钟你大概就知道这套方法对自己的仓库有没有用。有用、但觉得精简版不够撑，
再回去用完整的 AOCI-CODE —— 那时候你已经读过索引长什么样，切换成本很低。

---

## 快速开始

**两种运行方式，任选其一：**

```bash
# 有 Node（≥18）—— 走预编译版
npx @bysking/codebase-store init
npx @bysking/codebase-store scan

# 有 Bun —— 走 TS 源码版，启动更快
bunx @bysking/codebase-store init
bunx @bysking/codebase-store scan
```

都行，功能完全一致。`bunx` 直接跑 TypeScript 源码，省掉 Node 的启动开销；
`npx` 跑预编译的 `bin/cos.mjs`，不需要装 Bun。

`init` 会打印 MCP 配置片段。粘到 `.mcp.json`（Claude Code）或对应宿主的配置里，**重启 Agent**。

然后对 Agent 说：

```
读 cos_rules，然后调用 cos_maintain 建立索引
```

之后正常开发就行。代码改完让 Agent 跑一次 `cos_maintain` 即可增量维护。

验证：

```bash
npx @bysking/codebase-store verify    # 报漂移
npx @bysking/codebase-store check     # 治理门禁，非零退出可接 CI
```

---

## MCP 配置

**一份配置可以服务多个项目**——不需要每个项目写一份。

server 不绑定仓库路径：每次工具调用都会从**宿主进程的 cwd 向上逐层查找最近的
`.codebase_store/`**，命中哪个项目就作用于哪个项目。你在哪个项目目录启动 Agent，
cos 就管哪个项目。

### 方式 A：npx（零安装，推荐）

不需要预装任何东西，Node ≥ 18 即可：

```json
{
  "mcpServers": {
    "cos": {
      "command": "npx",
      "args": ["-y", "@bysking/codebase-store", "mcp"]
    }
  }
}
```

`-y` 表示跳过首次下载的确认提示（MCP 宿主没有交互终端，不加会卡住）。

这份配置可以放在**用户级**配置文件里，所有项目共用：


| 宿主           | 用户级配置文件                                                    |
| ---------------- | ------------------------------------------------------------------- |
| Claude Code    | `~/.claude/settings.json`（或项目级 `.mcp.json`）                 |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Codex          | `~/.codex/config.toml`（`[mcp_servers.cos]`）                     |
| Cursor         | `~/.cursor/mcp.json`                                              |

### 方式 B：全局安装（启动最快）

```bash
npm install -g @bysking/codebase-store
# 或 bun add -g @bysking/codebase-store
```

```json
{
  "mcpServers": {
    "cos": {
      "command": "cos",
      "args": ["mcp"]
    }
  }
}
```

省掉每次 `npx` 的包解析开销。**推荐日常使用**。

### 方式 C：bunx（有 Bun 时最快启动）

```json
{
  "mcpServers": {
    "cos": {
      "command": "bunx",
      "args": ["@bysking/codebase-store", "mcp"]
    }
  }
}
```

`bunx` 跑的是 TS 源码，没有编译产物，启动比 npx 快。

### 方式 D：源码（开发 / 想改代码时）

```bash
git clone https://github.com/bysking/codebase-store.git
cd codebase-store && bun install
```

```json
{
  "mcpServers": {
    "cos": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/codebase-store/src/cli.ts", "mcp"]
    }
  }
}
```

改完代码不用重新注册 MCP，重启 Agent 即可生效。

### 方式 E：编译成单二进制

```bash
cd codebase-store && bun run build     # 产出 ./cos（约 61MB，内嵌 Bun runtime）
```

```json
{
  "mcpServers": {
    "cos": { "command": "/absolute/path/to/codebase-store/cos", "args": ["mcp"] }
  }
}
```

### 什么时候才需要写 `--repo`

如果宿主启动 MCP server 时**不保证 cwd 在项目内**（有些宿主的 cwd 是 `/` 或用户主目录），
cwd 查找会失败。这时显式固定仓库：

```json
{
  "mcpServers": {
    "cos": {
      "command": "cos",
      "args": ["mcp", "--repo", "/absolute/path/to/your-project"]
    }
  }
}
```

代价是这份配置只服务那一个项目——多项目就得写多份。**先试不写 `--repo` 的版本**，
用 `cos_report` 看返回的 `root` 对不对，不对再补。

显式 `--repo` 优先级高于 cwd 查找。

### 仓库定位规则


| 命令                                       | 定位方式                                                     |
| -------------------------------------------- | -------------------------------------------------------------- |
| `cos init`                                 | 从 cwd 向上查 `.git`（此时还没有 `.codebase_store`）         |
| `cos mcp`（无 `--repo`）                   | **每次工具调用**都从宿主 cwd 向上查最近的 `.codebase_store/` |
| `cos mcp --repo X`                         | 固定为 X，不再查找                                           |
| `cos verify` / `check` / `status` / `scan` | 从 cwd 向上查最近的 `.codebase_store/`                       |

命中依据是 `.codebase_store/cos.txt` 是否存在，**不是 `.git`**。这样：

- 在任意深度的子目录里执行命令都能命中项目索引
- 同一个仓库（一个 `.git`）里可以有多个独立索引的子项目（monorepo 场景）
- 嵌套项目命中的是**最近的那一层**

### 验证接入成功

重启 Agent 后，让它调一次 `cos_report`，返回里的 `root` 字段就是实际作用的仓库：

```json
{ "root": "/Users/you/projects/my-app", "alignment": "aligned", "entries": 42 }
```

`root` 不对，说明宿主 cwd 不在项目内 → 改用 `--repo`。

命令行自查工具列表：

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | cos mcp --repo /path/to/your-project 2>/dev/null \
  | grep -o '"name":"cos_[a-z]*"' | sort -u
```

应看到 6 个工具：`cos_rules` `cos_overview` `cos_search` `cos_maintain` `cos_update` `cos_report`。

---

## 命令


| 命令         | 用途                                                 |
| -------------- | ------------------------------------------------------ |
| `cos init`   | 写 Root/Meta/Code 模板 + 配置文件 + AGENTS.md 规则块 |
| `cos scan`   | 建立基线（按 **git ignore 权威**枚举文件）           |
| `cos verify` | 报告漂移：missing / orphan / stale / unbaselined     |
| `cos check`  | 治理门禁（配额 + 覆盖 + 对齐），非零退出             |
| `cos status` | 人看的摘要                                           |
| `cos mcp`    | 启动 stdio MCP Server                                |

选项：`--repo <path>` `--force` `--json` `--help` `--version`

---

## MCP 工具（6 个）


| 工具           | 作用                                                               |
| ---------------- | -------------------------------------------------------------------- |
| `cos_rules`    | 会话合同：FRAS 怎么写、配额多少、什么是禁止的                      |
| `cos_overview` | 交付完整索引。超预算切块，必须顺 `nextCursor` 读到最后一个 chunk   |
| `cos_search`   | 在索引里检索（按 path 精确取 / 按 query 全文搜 / 按 tag 前缀过滤） |
| `cos_maintain` | **权威状态机**。无参数调用，返回 `nextAction` 告诉你现在该做什么   |
| `cos_update`   | 写入/删除 Entry。配额、R 引用、回读三重校验，任一失败整批拒绝      |
| `cos_report`   | 治理报告 + 取 `codeSha`（给 CAS 用）                               |

### `cos_maintain` 的状态机

```
needRemoval > 0    → authoring_required / phase=removal       删失效 Entry
needAuthoring > 0  → authoring_required / phase=first_index   首次建索引
                   → authoring_required / phase=incremental   增量补 Entry
stale > 0          → review_required   / phase=stale_review   复查过期 Entry
quotaViolations>0  → review_required   / phase=quota          收紧超限字段
否则               → none              / phase=aligned        收工
```

**不要在脚本里复制这个状态机**——它是唯一权威。

---

## 索引长什么样

**所有数据集中在项目下的 `.codebase_store/` 目录，不在仓库根散落文件。**

```
your-project/
├── .codebase_store/
│   ├── cos.txt          Root：声明有哪些 Volume、项目定位、全局不变量
│   ├── cos.meta.txt     Meta：标签字典、FRAS 规则、配额、创作约束
│   ├── cos.code.txt     Code Volume：代码对象的 Entry（真正的内容在这里）
│   ├── config.json      scope 规则、分块预算、刷新阈值
│   └── baseline.json    源码与 Entry 的指纹基线
├── AGENTS.md            含 cos 托管规则块（自动维护）
└── <你的代码...>
```

`.codebase_store/` 应**随 Git 一起提交**——索引是团队资产，跨会话跨 Agent 复用。
`init` 只往 `.gitignore` 里加临时文件（`.codebase_store/*.tmp-*`）和宿主配置（`.mcp.json`）。

`config.json` 可以手改（改 scope 规则是合法操作）；`cos.code.txt` **不要手改**，
它只能通过 `cos_update` 写，手改会被下次 CAS 冲突挡下。

### Entry = FRAS


| 字段              | 写什么                     | 不写什么   |
| ------------------- | ---------------------------- | ------------ |
| **F** Function    | 一个核心职责**命题**       | 功能清单   |
| **R** Relations   | 修改它时必须一起看的强关系 | 完整依赖图 |
| **A** API         | 稳定的对外契约             | 所有方法   |
| **S** Non-obvious | 不可推断且删了会出事的约束 | 摘要、重复 |

**S 字段两问准入**（每句话都要同时通过）：

1. 能否从对象名/标签/F/R/A 直接推断？→ 能就不写。
2. 删掉它会不会导致改错代码/数据/生命周期？→ 不会就不写。

合格的 S：

> 「失败时必须保留原始文件，不能降级为覆盖式重命名」
> 「MySQL 5.7.6+，不支持 MariaDB」
> 「这个托管块由模板渲染，手改会被覆盖」

不合格的 S：「这是一个工具函数」「用于处理字符串」。

### 标签 `A+B+C+[D]+E`

- **A** 架构层：`C`共享基础 `E`入口边界 `A`应用编排 `D`领域逻辑 `K`算法计算 `M`中间件
  `P`持久化 `I`集成适配 `R`运行基础 `L`库与SDK `F`声明配置 `O`运维交付 `T`测试验证
  `S`文档规范 `X`开发工具 `Z`其他
- **B** 功能域：`G`跨域通用 `U`用户交互 `B`核心业务 `D`数据状态 `I`身份权限 `N`网络协议
  `M`消息事件 `S`安全隐私 `C`配置策略 `O`可观测性 `R`可靠性恢复 `P`性能资源
  `W`流程调度 `A`分析智能 `H`硬件设备 `L`本地化 `V`构建发布 `Q`质量保障 `E`扩展插件 `Z`其他
- **C** 重要度：`9`最高 → `1`最低。9 = 挂了整个系统不可用；7 = 核心业务；5 = 常规；3 = 支撑；1 = 边缘
- **D** 可选维度（当前默认字典未声明）
- **E** 规模：`L`>400行 `M`200-400 `S`100-200 `T`<100

例：`[CG9L]` = 共享基础 / 跨域通用 / 最高重要度 / 大文件。

### 配额（程序强制，改文本放宽不了）


| C 重要度 | F   | R   | A   | S   |
| ---------- | ----- | ----- | ----- | ----- |
| 9-8      | 450 | 400 | 320 | 1200 |
| 7-4      | 300 | 250 | 210 | 400  |
| 3-1      | 180 | 150 | 120 | 120  |

超限会被拒。**正确做法是收紧内容，不是拆词凑数。**

单条上限放宽不会撑爆 `WHOLE_INDEX_BUDGET` —— 索引体积由**条数**主导，而不是单条长度。
权威值在 `src/core.ts` 的 `FIELD_QUOTA`，Meta 与 `cos_rules` 里的配额行都由它渲染，不存在第二处真相。

---

## Managed Scope：什么进索引

三角色（`.codebase_store/config.json` 的 `scopeRules`）：


| 角色      | 含义                       | 有 Entry |
| ----------- | ---------------------------- | ---------- |
| `index`   | 进入正式认知               | ✅       |
| `observe` | 只观察字节变化，不写 Entry | ❌       |
| `exclude` | 明确负空间，连指纹都不算   | ❌       |

默认规则：`*.lock`/图片 exclude，`*.json`/`*.md` observe，其余 index。

**负空间本身是认知**。写一条

```json
{ "action": "exclude", "pattern": "assets/qr.png", "reason": "社群二维码，无系统语义，既不读也不指纹" }
```

后续 Agent 就不会再浪费 token 去理解它。

---

## 保留 vs 砍掉（相对 AOCI-CODE）

> 只留方法，卸掉治理盔甲 —— 完整取舍与理由见上文「先说清楚它的分量」与 `docs/aoci-code/04-bun复刻方案.md`。

### 保留

FRAS 格式 · Volume 布局 · 模型手写语义的不变量 · S 两问准入 · 配额分档 ·
Whole-Index 读入 · 分块交付 · 三角色 Scope · 漂移检测 · 增量维护状态机

### 砍掉


| 砍掉的                                            | 理由               |
| --------------------------------------------------- | -------------------- |
| Legacy → Volumes 迁移（12 文件）                 | 新项目没有历史包袱 |
| 多层事务 CAS + Recovery + Ledger                  | 单人不存在并发写   |
| Attestation / Challenge 考证链（14 文件）         | 保留分块即可       |
| Scope Change 正式流程                             | 改 JSON 就行       |
| 签名包 / SBOM / cosign                            | 自己用不需要       |
| 双 Locale                                         | 中文够用           |
| 多宿主 Hook（6 宿主）                             | 只需 1~2 个        |
| UI 面板                                           | `cat` 索引文件就行 |
| System Cognition 投影（Lineage/Relations/Impact） | 可后置             |
| DB Evidence 多驱动                                | 可后置             |
| `status --deep` / curation                        | 用不上             |

---

## 设计文档

完整分析在 `docs/aoci-code/`：


| 文件                   | 内容                                              |
| ------------------------ | --------------------------------------------------- |
| `01-设计理念.md`       | 为什么这么设计：四条支柱原则 + 复杂度来源诚实盘点 |
| `02-功能模块.md`       | 逐模块梳理 36 个 Go 包的功能与依赖                |
| `03-数据格式与协议.md` | 索引格式、FRAS 规范、MCP 协议、交付链、写入安全   |
| `04-bun复刻方案.md`    | 砍什么留什么、架构、实施顺序、风险对策            |

---

## 开发

```bash
git clone https://github.com/bysking/codebase-store.git
cd codebase-store
bun install

bun test                    # 122 个单测
bunx tsc --noEmit           # 类型检查
bun run typecheck           # 同上，脚本化
bun run verify:all          # typecheck + test
bun run src/cli.ts --help   # 不安装直接跑
bun run build:bin           # 单二进制 → ./cos（内嵌 Bun runtime，约 64MB）
bun run build:npm           # npx 入口 → bin/cos.mjs（约 71KB）
```

### 双入口是怎么工作的


| 入口                           | 执行的文件                 | 运行时要求 |
| -------------------------------- | ---------------------------- | ------------ |
| `npx @bysking/codebase-store`  | `bin/cos.mjs`（预编译 JS） | Node ≥ 18 |
| `bunx @bysking/codebase-store` | `src/cli.ts`（TS 源码）    | Bun ≥ 1.1 |
| 全局安装 `cos`                 | `bin/cos.mjs`              | Node ≥ 18 |

源码只用 `node:*` 标准 API（`node:crypto` / `node:child_process` / `node:fs`），
**不依赖任何 Bun 专有能力**——这是两条路径能共存的前提。

`prepack` 钩子会自动跑 `build:npm`，所以 `npm pack` 与 `npm publish` 之前
`bin/cos.mjs` 一定是新的，不会出现「源码改了但 npx 版还是旧的」。
`test/dist-freshness.test.ts` 会在 CI/本地测试时比对源码与产物的字节一致性，
忘记重建会直接让测试失败。

本地调试 MCP 协议（发两帧看返回）：

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' \
  | node bin/cos.mjs mcp --repo /path/to/some/repo 2>/dev/null
```

注意 **stdout 只有 JSON-RPC 帧**，所有日志在 stderr。

### 发布

```bash
npm version patch
npm publish
```

`publishConfig.access` 已设为 `public`，不需要额外加 `--access public`。
`files` 限定只发布 `bin/`、`src/`、`README.md`、`CHANGELOG.md`、`LICENSE`。

## 已知边界

- 只支持 Git 仓库的文件枚举权威；无 git 时回退到目录遍历
- 并发写入靠 CAS 兜底（每次写入都校验磁盘快照），**不是**分布式锁；
  多进程同时写同一个仓库仍可能反复冲突，那种场景需要外部互斥
- 没有 attestation 链：Agent 可能少读几个 chunk，代价是任务质量而非治理污染
- token 估算是粗略启发式（CJK 1 字 = 1 token，ASCII 4 字符 = 1 token）
- stale 判定用 `size + mtimeMs` 做快路径，mtime 被手工改回旧值时可能漏报一次；
  `cos scan --force` 可重建基线
- **运行时不依赖 Bun**：`src/` 只用 `node:*` 标准 API，同一份源码既能 `bunx`
  直跑 TS，也能被编译成 `bin/cos.mjs` 在 Node ≥ 18 上运行。
  只有跑测试与打包需要 Bun（用了 `bun:test` 与 `bun build`）

## License

MIT
