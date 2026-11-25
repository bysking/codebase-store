/**
 * tools.ts — 6 个 MCP 工具
 *
 * 从 AOCI-CODE 的 9 工具砍到 6：
 *   aoci_get_entries + aoci_search  → cos_search
 *   aoci_update_entry + aoci_remove_entry → cos_update（entry: null 表示删除）
 *   aoci_header 并入 cos_report
 *
 * 核心不变量：程序绝不生成 F/R/A/S。cos_maintain 只返回"该做什么"，
 * 内容由模型写。
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  CHUNK_TOKENS_MIN, CHUNK_TOKENS_MAX, WHOLE_INDEX_BUDGET,
  CosError, estimateTokens, sha256, splitByBytes,
  type Entry, type OverviewChunk,
} from "./core.ts";
import {
  parseTag,
} from "./format.ts";
import {
  loadState, collectFacts, commitEntries, fileSha, resolveRole,
  type RepoState,
} from "./repo.ts";
import { z } from "zod";
import type { ToolDef } from "./mcp.ts";

// ────────────────────────────────────────────────────────────
// 会话合同（等价于 aoci_rules）
// ────────────────────────────────────────────────────────────

const RULES_TEXT = `# cos 会话合同

## 你面对的是什么

本仓库维护一份**认知索引**：模型为每个受管文件手写一行，说明它是什么、
和谁强关联、对外契约是什么、什么不能改坏。索引存在 Git 里，跨会话、跨 Agent 复用。

所有数据集中在仓库的 \`.codebase_store/\` 目录：

\`\`\`
.codebase_store/
├── cos.txt          Root：声明 Volume、项目定位、全局不变量
├── cos.meta.txt     Meta：标签字典、FRAS 规则、配额、创作约束
├── cos.code.txt     Code Volume：代码对象的 Entry（真正的内容在这里）
├── config.json      scope 规则、分块预算、刷新阈值
└── baseline.json    源码与 Entry 的指纹基线
\`\`\`

这个目录**不要手改**：\`cos.code.txt\` 只能通过 \`cos_update\` 写，程序会做配额、
引用、回读校验。\`config.json\` 可以手改（改 scope 规则是合法操作）。

**这不是检索工具。开工前先读完索引，之后不要再 grep 整个代码库。**

## 必读流程

1. 新会话开始：\`cos_overview\` 读完整索引。
   - 返回 \`nextCursor\` 时，必须顺链读到最后一个 chunk 才能声称"已读完"。
   - \`checkOnly=true\` 只是紧凑检查点，**不能替代**完整读取。
2. 干活：按索引里的 F/R/A/S 定位文件，用常规工具读源码。
3. 收工前：代码与测试稳定后调用 \`cos_maintain\`，按 \`nextAction\` 处理。

## 语义只能由你写（硬性）

程序**不会**替你生成、预填、摘要、压缩、补全 F/R/A/S。
「机器先出草稿，模型再润色」也被禁止 —— 那会让索引变成看起来合理但不可信的文本。

## FRAS 写作规范

| 字段 | 该写什么 | 不该写什么 |
|---|---|---|
| **F** Function | 一个核心职责**命题** | 功能清单、能力罗列 |
| **R** Relations | 理解或安全修改它**必须一起看**的强关系 | 完整依赖图、所有 import |
| **A** API | 稳定的、外部可依赖的契约 | 所有方法/字段/调用方 |
| **S** Non-obvious | 不可推断且删了会出事的约束 | 摘要、F/R/A 的重复 |

### S 字段的两问准入（每句话都要同时通过）

1. 能否从对象名、标签、F、R、A 直接推断？→ **能就不许写**
2. 删掉它会不会导致模型改错代码/数据/生命周期？→ **不会就不许写**

不合格的 S：「这是一个工具函数」「用于处理字符串」。
合格的 S：「失败时必须保留原始文件，不能降级为覆盖式重命名」、
「MySQL 5.7.6+，不支持 MariaDB」、「这个块由模板渲染，手改会被覆盖」。

### 配额（程序强制，改索引文本放宽不了）

| C 重要度 | F | R | A | S |
|---|---|---|---|---|
| 9-8 | 300 | 240 | 200 | 600 |
| 7-4 | 200 | 160 | 140 | 200 |
| 3-1 | 120 | 100 | 90 | 50 |

超限会被拒。**正确做法是收紧内容，不是拆词凑数。**

### R 字段的合法形式

\`code:<仓库相对路径>\` 或 \`database://<source>/<ns>/<table>\`，逗号分隔，无关系写 \`-\`。
唯一裸文件名**不是**写别名，不会被静默补全。

## 标签（紧凑形态 A+B+C+[D]+E）

- A 架构层：C共享基础 E入口边界 A应用编排 D领域逻辑 K算法计算 M中间件 P持久化
  I集成适配 R运行基础 L库与SDK F声明配置 O运维交付 T测试验证 S文档规范 X开发工具 Z其他
- B 功能域：G跨域通用 U用户交互 B核心业务 D数据状态 I身份权限 N网络协议 M消息事件
  S安全隐私 C配置策略 O可观测性 R可靠性恢复 P性能资源 W流程调度 A分析智能
  H硬件设备 L本地化 V构建发布 Q质量保障 E扩展插件 Z其他
- C 重要度：9最高 8很高 7高 6较高 5中等 4较低 3低 2很低 1最低
- E 规模：L>400行 M200-400 S100-200 T<100

选 C 要有依据：9 = 挂了整个系统不可用；7 = 核心业务；5 = 常规；
3 = 支撑；1 = 边缘。**不要全打 9。**

## 禁止事项

- 禁止用 grep / 读源码冒充"已读索引"
- 禁止在上下文压缩后不复读索引就继续声称掌握系统
- 禁止把索引正文或摘要塞进 handoff（只留"请重载"指令）
- 禁止绕过 \`cos_update\` 直接编辑 \`.codebase_store/cos.code.txt\`（手改会被 CAS 冲突挡下）`;

// ────────────────────────────────────────────────────────────
// cos_rules
// ────────────────────────────────────────────────────────────

const rulesTool: ToolDef = {
  name: "cos_rules",
  description:
    "返回会话合同：怎么用这套索引、F/R/A/S 怎么写、配额是多少、什么是禁止的。" +
    "新会话开始时先读一次。和 aoci_rules 同名同义。",
  inputSchema: {},
  needsRepo: false,
  handler: () => RULES_TEXT,
};

// ────────────────────────────────────────────────────────────
// cos_overview
// ────────────────────────────────────────────────────────────

function buildOverviewText(state: RepoState): string {
  return [
    "<!-- cos:overview:start -->",
    state.rootText.trimEnd(),
    "",
    state.metaText.trimEnd(),
    "",
    state.codeText.trimEnd(),
    "<!-- cos:overview:end -->",
  ].join("\n");
}

/**
 * 把整份索引切成若干块，**只在行边界上切**。
 *
 * 为什么不能按字节切：Entry 是「一行一条」的自包含记录，
 * 从一个 Entry 中间切开，模型会读到 `":注意254"` 这种半截文本，
 * 既不知道为什么断，也拼不回原意 —— 而且没有任何提示。
 * 实测：splitByBytes 的产物里 chunk[1] 首行就是一条被腰斩的 Entry。
 *
 * 单行本身超过预算时（极长的 S 字段 / 单条 Meta 说明），退回按字符切：
 * 这种情况下无论怎么切都会断，但至少不会把一条 Entry 拆到两个 chunk 里
 * 与其它的 Entry 混在一起。
 */
export function chunkOverview(text: string, chunkTokens: number): { chunks: string[]; tokens: number } {
  const tokens = estimateTokens(text);
  if (tokens <= chunkTokens) return { chunks: [text], tokens };

  const chunks: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;

  for (const line of text.split("\n")) {
    const lineTokens = estimateTokens(line);

    // 单行就超预算：先落掉手上的，再把这一行自己切成多块
    if (lineTokens > chunkTokens) {
      if (cur.length > 0) {
        chunks.push(cur.join("\n"));
        cur = [];
        curTokens = 0;
      }
      // 按字符贪心切，保证每块尽量接近预算
      for (const piece of splitByBytes(line, Math.max(1, Math.ceil(
        (Buffer.byteLength(line, "utf8") / lineTokens) * chunkTokens,
      )))) {
        chunks.push(piece);
      }
      continue;
    }

    if (curTokens + lineTokens > chunkTokens && cur.length > 0) {
      chunks.push(cur.join("\n"));
      cur = [];
      curTokens = 0;
    }
    cur.push(line);
    curTokens += lineTokens;
  }
  if (cur.length > 0) chunks.push(cur.join("\n"));
  return { chunks, tokens };
}

const overviewTool: ToolDef = {
  name: "cos_overview",
  description:
    "交付完整的仓库认知索引（Root + Meta + Code 三个 Volume 的原文）。" +
    "超预算时切成多块，必须顺 nextCursor 读到最后一个 chunk 才能声称读完。" +
    "checkOnly=true 返回紧凑检查点，不能替代完整读取。",
  inputSchema: {
    cursor: z.string().optional().describe("上一块返回的 nextCursor"),
    checkOnly: z.boolean().optional().describe("只返回对齐状态等紧凑检查点，不返回索引正文"),
    chunkTokens: z.number().int().min(CHUNK_TOKENS_MIN).max(CHUNK_TOKENS_MAX).optional()
      .describe(`每块 token 预算，默认取配置，范围 ${CHUNK_TOKENS_MIN}~${CHUNK_TOKENS_MAX}`),
  },
  handler: (args, ctx) => {
    const state = loadState(ctx.root);
    const cfg = state.cfg;

    /*
     * collectFacts 会 stat（必要时整读）全仓受管文件，是有成本的。
     * overview 常常被连读好几块，如果每块都算一遍就是纯浪费 ——
     * 而且同一份索引的 facts 在读取过程中也不会变（变了 cursor sha 会拦住）。
     *
     * 所以只在真正需要它的两个时机算：
     *   · checkOnly（整个返回就是 facts）
     *   · 最后一块（那时才交付 alignment 这种"结论性"字段）
     */
    if (args.checkOnly === true) {
      const facts = collectFacts(state);
      return {
        checkOnly: true,
        alignment: facts.alignment,
        entries: facts.entries,
        files: facts.files,
        tokens: facts.tokens,
        driftCount: facts.drift.length,
        quotaViolations: facts.quotaViolations.length,
        note: "这是紧凑检查点。需要接手开发时请不带 checkOnly 调 cos_overview 读完整索引。",
      };
    }

    const chunkTokens = clampChunk(args.chunkTokens as number | undefined ?? cfg.chunkTokens);
    const text = buildOverviewText(state);
    const { chunks, tokens } = chunkOverview(text, chunkTokens);

    // cursor 形式：<index>:<sha>，sha 用于检测交付期间索引被改
    const textSha = sha256(text).slice(0, 12);
    const startIdx = args.cursor ? parseCursor(args.cursor as string, textSha) : 0;
    const idx = Math.min(startIdx, chunks.length - 1);
    const nextCursor = idx + 1 < chunks.length ? `${idx + 1}:${textSha}` : null;

    const result: OverviewChunk & Record<string, unknown> = {
      cursor: `${idx}:${textSha}`,
      nextCursor,
      chunkIndex: idx,
      chunkTotal: chunks.length,
      content: chunks[idx]!,
      tokens: estimateTokens(chunks[idx]!),
      wholeIndexTokens: tokens,
      budget: WHOLE_INDEX_BUDGET,
    };

    if (nextCursor) {
      // 中间块：不算 facts（省掉一次全仓 stat/sha），只给纯计数的进度
      result.entries = state.entries.length;
      result.hint = `还有 ${chunks.length - idx - 1} 块。用 cursor="${nextCursor}" 继续读，读到最后一块才算读完。`;
    } else {
      // 最后一块：此时交付结论性字段（alignment 需要全仓漂移判定）
      const facts = collectFacts(state);
      result.entries = facts.entries;
      result.alignment = facts.alignment;
      result.files = facts.files;
      result.needAuthoring = facts.needAuthoring.length;
      result.needRemoval = facts.needRemoval.length;
      result.complete = true;
      result.hint = "这是最后一块。你现在持有完整索引。";
    }
    return result;
  },
};

function clampChunk(n: number): number {
  if (!Number.isFinite(n)) return 7000;
  return Math.max(CHUNK_TOKENS_MIN, Math.min(CHUNK_TOKENS_MAX, Math.floor(n)));
}

function parseCursor(cursor: string, expectSha: string): number {
  const [idxStr, sha] = cursor.split(":");
  if (sha && sha !== expectSha) {
    throw new CosError(
      `cursor 失效：索引在交付期间被修改（cursor sha=${sha}，当前 sha=${expectSha}）。` +
      `请不带 cursor 重新调 cos_overview。`,
      "cursor_stale",
    );
  }
  const n = Number(idxStr);
  if (!Number.isInteger(n) || n < 0) throw new CosError(`非法 cursor "${cursor}"`, "bad_cursor");
  return n;
}

// ────────────────────────────────────────────────────────────
// cos_search（合并 aoci_get_entries + aoci_search）
// ────────────────────────────────────────────────────────────

const searchTool: ToolDef = {
  name: "cos_search",
  description:
    "在索引里检索。传 path 精确取单个对象的 Entry；传 query 在 F/R/A/S 与路径上做全文匹配。" +
    "这不是代码搜索 —— 它只查认知索引，不读源码。",
  inputSchema: {
    path: z.string().optional().describe("仓库相对路径，精确取一条 Entry"),
    query: z.string().optional().describe("全文关键词，匹配路径与 F/R/A/S"),
    tag: z.string().optional().describe("按标签前缀过滤，如 C 或 CG9"),
    limit: z.number().int().min(1).max(200).optional().describe("最多返回条数，默认 20"),
  },
  handler: (args, ctx) => {
    const state = loadState(ctx.root);
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, args.limit)) : 20;

    if (typeof args.path === "string") {
      const hit = state.entries.find((e) => e.path === args.path);
      if (!hit) {
        return { found: false, path: args.path, hint: "该对象还没有 Entry。用 cos_maintain 看它是否在待补列表里。" };
      }
      return { found: true, entry: hit, formatted: formatEntry(hit) };
    }

    let pool = state.entries;
    if (typeof args.tag === "string" && args.tag) {
      const t = args.tag.trim();
      pool = pool.filter((e) => e.tag.startsWith(t));
    }
    if (typeof args.query === "string" && args.query.trim()) {
      const q = args.query.trim().toLowerCase();
      pool = pool.filter((e) =>
        e.path.toLowerCase().includes(q) ||
        e.f.toLowerCase().includes(q) ||
        e.r.toLowerCase().includes(q) ||
        e.a.toLowerCase().includes(q) ||
        e.s.toLowerCase().includes(q),
      );
    }
    return {
      total: pool.length,
      returned: Math.min(pool.length, limit),
      entries: pool.slice(0, limit).map((e) => ({ ...e, formatted: formatEntry(e) })),
      ...(pool.length > limit ? { hint: `还有 ${pool.length - limit} 条，用 limit 或加 query 收窄` } : {}),
    };
  },
};

function formatEntry(e: Entry): string {
  return `${e.path}[${e.tag}]: F:${e.f} | R:${e.r} | A:${e.a} | S:${e.s}`;
}

// ────────────────────────────────────────────────────────────
// cos_maintain
// ────────────────────────────────────────────────────────────

const KEY_WORDS: { re: RegExp; a: string; b: string }[] = [
  { re: /(^|\/)(package\.json|tsconfig|go\.mod|Cargo\.toml|pyproject)/i, a: "F", b: "C" },
  { re: /(^|\/)(Dockerfile|Makefile|\.github\/)/i, a: "O", b: "V" },
  { re: /(^|\/)(test|spec|__tests__)/i, a: "T", b: "Q" },
  { re: /\.(test|spec)\.[a-z]+$/i, a: "T", b: "Q" },
  { re: /(^|\/)(auth|login|session|token|permission)/i, a: "I", b: "I" },
  { re: /(^|\/)(api|route|handler|controller)/i, a: "E", b: "N" },
  { re: /(^|\/)(db|model|schema|migration|repository)/i, a: "P", b: "D" },
  { re: /(^|\/)(config|settings|env)/i, a: "F", b: "C" },
  { re: /(^|\/)(util|common|shared|helper)/i, a: "C", b: "G" },
];

function suggestTag(path: string): string {
  for (const k of KEY_WORDS) if (k.re.test(path)) return `${k.a}${k.b}5M`;
  return "CG5M";
}

const maintainTool: ToolDef = {
  name: "cos_maintain",
  description:
    "无参数调用：服务器算出当前该做什么，返回 nextAction。这是权威状态机的唯一入口 —— " +
    "不要在脚本里复制它。按 nextAction 行动后再调一次拿下一批。",
  inputSchema: {
    limit: z.number().int().min(1).max(50).optional().describe("本批最多返回多少个待补对象，默认 10"),
  },
  handler: (args, ctx) => {
    const state = loadState(ctx.root);
    const facts = collectFacts(state);
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, args.limit)) : 10;

    const entryByPath = new Map(state.entries.map((e) => [e.path, e]));
    const stale = facts.drift.filter((d) => d.kind === "stale").map((d) => d.path);

    // ⓪ 索引格式损坏优先 —— 此时任何 cos_update 都会被拒绝（会丢数据），
    // 所以必须先让模型把坏行修好，而不是继续创作新 Entry。
    if (state.malformed.length > 0) {
      return {
        nextAction: "repair_required",
        phase: "malformed_volume",
        message:
          `索引里有 ${state.malformed.length} 行无法解析成 Entry。` +
          `在修好之前 cos_update 会拒绝写入（重写会把它们永久抹掉）。`,
        targets: state.malformed.slice(0, limit).map((m) => ({
          line: m.line,
          text: m.text,
          action: "repair_or_delete",
        })),
        remaining: Math.max(0, state.malformed.length - limit),
        hint:
          `合法行只有三类：注释（# 开头）、目录段头（===/<repository>/<dir>/===）、` +
          `Entry（name[TAG]: F:.. | R:.. | A:.. | S:..）。` +
          `请手工修正这一行，或确认它已无用后整行删除。`,
      };
    }

    // ① 待删除优先：Entry 指向的对象已经不该被索引了
    if (facts.needRemoval.length > 0) {
      const batch = facts.needRemoval.slice(0, limit);
      return {
        nextAction: "authoring_required",
        phase: "removal",
        message: `有 ${facts.needRemoval.length} 个 Entry 已失效（文件不存在，或对象已不是 index 角色）。` +
          `本批 ${batch.length} 个，确认后用 removals 删除。`,
        targets: batch.map((p) => ({ path: p, action: "remove", currentEntry: entryByPath.get(p) ?? null })),
        remaining: Math.max(0, facts.needRemoval.length - limit),
        hint: "删之前确认：是对象真的不该被索引，而不是你找错文件了。",
      };
    }

    // ② 待创作：受管但还没有 Entry
    if (facts.needAuthoring.length > 0) {
      const batch = facts.needAuthoring.slice(0, limit);
      const isFirst = facts.entries === 0;
      return {
        nextAction: "authoring_required",
        phase: isFirst ? "first_index" : "incremental",
        message: isFirst
          ? `首次建索引。本批 ${batch.length} 个对象（共 ${facts.needAuthoring.length} 个待创作）。` +
            `逐个读源码后写 Entry，用 cos_update 提交。`
          : `有 ${facts.needAuthoring.length} 个受管文件还没有 Entry。本批 ${batch.length} 个。`,
        targets: batch.map((p) => ({
          path: p,
          suggestedTag: suggestTag(p),
          hash: fileSha(join(ctx.root, p))?.slice(0, 12),
        })),
        remaining: Math.max(0, facts.needAuthoring.length - limit),
        contractReminder:
          "F 是一个核心职责命题，不是清单；S 必须过两问（能推断的不写，删了不出事的不写）。" +
          "只写你读过源码的对象；suggestedTag 只是依据路径的起点，必须修正。",
      };
    }

    // ③ 过期复查：源码变了
    if (stale.length > 0) {
      const batch = stale.slice(0, limit);
      return {
        nextAction: "review_required",
        phase: "stale_review",
        message: `有 ${stale.length} 个对象源码变了，Entry 可能已过期。逐个复查后决定是否更新 F/R/A/S。`,
        targets: batch.map((p) => ({ path: p, currentEntry: entryByPath.get(p) ?? null })),
        remaining: Math.max(0, stale.length - limit),
        hint: "很多改动不影响语义（格式、改名、注释）。确认无变化就用 cos_update 重提交同内容刷新基线。",
      };
    }

    // ④ 配额
    if (facts.quotaViolations.length > 0) {
      return {
        nextAction: "review_required",
        phase: "quota",
        message: `有 ${facts.quotaViolations.length} 处配额超限。`,
        targets: facts.quotaViolations.slice(0, limit),
        hint: "收紧内容，不要拆词凑数。S 两问：能推断的不写，删了不出事的不写。",
      };
    }

    return {
      nextAction: "none",
      phase: "aligned",
      message: "索引与代码一致。没有待处理项。",
      facts: {
        entries: facts.entries,
        files: facts.files,
        tokens: facts.tokens,
        alignment: facts.alignment,
      },
    };
  },
};

// ────────────────────────────────────────────────────────────
// cos_update
// ────────────────────────────────────────────────────────────

const updateTool: ToolDef = {
  name: "cos_update",
  description:
    "写入或删除索引条目。upserts 里每条是完整 Entry（不是 patch）；" +
    "removals 是路径数组。会做配额校验、R 引用校验和回读校验，任一失败整批拒绝。" +
    "传 expectSha 做 CAS（值来自上一次 cos_overview 或 cos_report 的 codeSha）。",
  inputSchema: {
    upserts: z.array(z.object({
      path: z.string().describe("仓库相对路径"),
      tag: z.string().describe("紧凑标签 A+B+C+[D]+E，如 CG9L"),
      f: z.string().describe("Function：一个核心职责命题，不是清单"),
      r: z.string().describe("Relations：code:<path> 逗号分隔，无关系写 -"),
      a: z.string().describe("API：稳定的对外契约，无则写 -"),
      s: z.string().describe("Non-obvious：过两问才写，无则写 -"),
    })).optional().describe("要写入的完整 Entry 列表（整条覆盖，不是 patch）"),
    removals: z.array(z.string()).optional().describe("要删除的对象路径"),
    expectSha: z.string().optional()
      .describe(".codebase_store/cos.code.txt 的期望 sha256，用于 CAS（值来自 cos_report 的 codeSha）"),
  },
  handler: (args, ctx) => {
    const state = loadState(ctx.root);
    const upserts = (args.upserts as Entry[] | undefined) ?? [];
    const removals = (args.removals as string[] | undefined) ?? [];
    const expectSha = (args.expectSha as string | undefined) ?? null;

    if (upserts.length === 0 && removals.length === 0) {
      throw new CosError("upserts 和 removals 都是空的，没有可做的", "no_op");
    }

    // 路径必须是受管 index 角色
    for (const e of upserts) {
      const role = resolveRole(e.path, state.cfg);
      if (role !== "index") {
        throw new CosError(
          `"${e.path}" 在 scope 里是 ${role} 角色，不能写正式 Entry。` +
          `改 .codebase_store/config.json 的 scopeRules 才能纳入索引。`,
          "not_indexable",
        );
      }
      if (!existsSync(join(ctx.root, e.path))) {
        throw new CosError(`"${e.path}" 不存在。Entry 必须绑定真实文件。`, "no_such_file");
      }
      // 标签合法性
      try { parseTag(e.tag); } catch (err) { throw err; }
    }

    const result = commitEntries(state, upserts, removals, expectSha);
    const after = loadState(ctx.root);
    const facts = collectFacts(after);
    return {
      ok: true,
      entries: result.entries,
      codeSha: result.sha,
      alignment: facts.alignment,
      remainingDrift: facts.drift.length,
      nextStep: facts.drift.length === 0
        ? "索引已对齐。可以继续开发任务。"
        : "还有待处理项，再调 cos_maintain 拿下一批。",
    };
  },
};

// ────────────────────────────────────────────────────────────
// cos_report
// ────────────────────────────────────────────────────────────

const reportTool: ToolDef = {
  name: "cos_report",
  description:
    "治理报告：对齐状态、漂移清单、配额违规、覆盖统计、Root/Meta 头部信息、codeSha。" +
    "人看的摘要，也可以用来取 expectSha。",
  inputSchema: {
    verbose: z.boolean().optional().describe("包含完整漂移清单，默认只给计数"),
  },
  handler: (args, ctx) => {
    const state = loadState(ctx.root);
    const facts = collectFacts(state);
    const codeSha = state.codeText ? sha256(state.codeText) : null;
    const verbose = args.verbose === true;

    const byKind: Record<string, number> = {};
    for (const d of facts.drift) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;

    return {
      root: state.root,
      ...(ctx.fixedRoot ? { rootSource: "fixed_repo" } : { rootSource: "cwd" }),
      alignment: facts.alignment,
      entries: facts.entries,
      managedFiles: facts.files,
      tokens: facts.tokens,
      tokenBudget: WHOLE_INDEX_BUDGET,
      codeSha,
      drift: {
        total: facts.drift.length,
        byKind,
        ...(verbose ? { items: facts.drift } : { sample: facts.drift.slice(0, 10) }),
      },
      quotaViolations: {
        total: facts.quotaViolations.length,
        ...(verbose ? { items: facts.quotaViolations } : {}),
      },
      header: {
        root: extractHeaderLines(state.rootText),
        meta: extractHeaderLines(state.metaText),
      },
      nextAction: facts.alignment === "aligned"
        ? "none"
        : facts.entries === 0
          ? "authoring_required"
          : facts.drift.length > 0
            ? "maintain"
            : "review_required",
    };
  },
};

function extractHeaderLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.startsWith("#")).slice(0, 12);
}

// ────────────────────────────────────────────────────────────
// 导出
// ────────────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  rulesTool,
  overviewTool,
  searchTool,
  maintainTool,
  updateTool,
  reportTool,
];

export const RULES = RULES_TEXT;
