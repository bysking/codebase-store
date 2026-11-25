/**
 * commands.ts — CLI 命令实现
 *
 * 对应 AOCI-CODE 的 internal/cli（52 文件），压缩为 6 个命令。
 */

import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { CosError, INDEX_PATH, META_PATH, CODE_PATH, DATA_DIR, WHOLE_INDEX_BUDGET } from "./core.ts";
import {
  loadState, collectFacts, initRepo, scanRepo,
} from "./repo.ts";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export function cmdInit(root: string, flags: { force?: boolean }): number {
  try {
    const { created } = initRepo(root, flags.force === true);
    console.log(C.green("✓") + ` 初始化完成：${root}`);
    console.log(C.dim(`  数据全部存放在 ${DATA_DIR}/ 下（该目录应随 Git 一起提交）`));
    for (const f of created) console.log(`  ${C.dim("+")} ${f}`);
    console.log("");
    console.log(C.bold("下一步："));
    console.log("  1. " + C.cyan("cos scan") + "  建立基线（按 git ignore 权威枚举文件）");
    console.log("  2. 在 Agent 里加 MCP 配置（见下方片段），重启 Agent");
    console.log("  3. 对 Agent 说：" + C.cyan("「读 cos_rules，然后建立索引」"));
    console.log("");
    console.log(C.bold("MCP 配置（Claude Code: .mcp.json）"));
    // 不写 --repo：每次工具调用按宿主 cwd 向上查找 .codebase_store，
    // 一份配置可以服务多个项目
    console.log(C.dim(JSON.stringify({
      mcpServers: {
        cos: { command: "npx", args: ["-y", "@bysking/codebase-store", "mcp"] },
      },
    }, null, 2)));
    console.log("");
    console.log(C.dim("  没写 --repo：server 会按宿主 cwd 向上找 .codebase_store，多项目共用一份配置。"));
    console.log(C.dim("  若宿主不保证 cwd 在项目内，再显式加 \"--repo\", \"" + root + "\"。"));
    console.log(C.dim("  已全局安装的话，可把 command 改成 \"cos\"、args 改成 [\"mcp\"]。"));
    return 0;
  } catch (err) {
    return fail(err);
  }
}

export function cmdScan(root: string, flags: { force?: boolean }): number {
  try {
    const r = scanRepo(root, flags.force === true);
    console.log(C.green("✓") + ` 基线建立：${r.files} 个文件，${r.entries} 条已有 Entry`);
    console.log(C.dim("  Git ignore 是文件来源的唯一权威，未追踪被忽略的文件不会进来。"));
    return 0;
  } catch (err) {
    return fail(err);
  }
}

export function cmdVerify(root: string, flags: { json?: boolean }): number {
  try {
    const state = loadState(root);
    const facts = collectFacts(state);

    if (flags.json) {
      console.log(JSON.stringify({ alignment: facts.alignment, drift: facts.drift, entries: facts.entries, files: facts.files }, null, 2));
      return facts.drift.length === 0 ? 0 : 1;
    }

    console.log(C.bold("verify") + `  ${state.root}`);
    console.log("");
    if (facts.drift.length === 0) {
      console.log(C.green("  ✓ 无漂移"));
      return 0;
    }
    const groups = new Map<string, string[]>();
    for (const d of facts.drift) {
      if (!groups.has(d.kind)) groups.set(d.kind, []);
      groups.get(d.kind)!.push(d.path);
    }
    const label: Record<string, string> = {
      missing: "Missing（Entry 在，文件不在）",
      orphan: "Orphan（Entry 在，对象已不是 index 角色）",
      stale: "Stale（源码变了，Entry 未更新）",
      unbaselined: "Unbaselined（受管但未进基线 / 无 Entry）",
    };
    for (const [kind, paths] of groups) {
      console.log(C.yellow(`  ${label[kind] ?? kind}`) + C.dim(`  ${paths.length} 项`));
      for (const p of paths.slice(0, 20)) console.log(`    ${p}`);
      if (paths.length > 20) console.log(C.dim(`    ... 还有 ${paths.length - 20} 项`));
      console.log("");
    }
    return 1;
  } catch (err) {
    return fail(err);
  }
}

export function cmdCheck(root: string, flags: { json?: boolean }): number {
  try {
    const state = loadState(root);
    const facts = collectFacts(state);
    const problems: string[] = [];

    if (facts.entries === 0) problems.push("索引为空：还没有任何 Entry。让 Agent 跑 cos_maintain 建索引。");
    if (facts.tokens > WHOLE_INDEX_BUDGET.max) {
      problems.push(`索引 ${facts.tokens} token 超过硬上限 ${WHOLE_INDEX_BUDGET.max}。需要裁剪或拆分。`);
    }
    for (const v of facts.quotaViolations) {
      problems.push(`配额超限 ${v.path} 的 ${v.field}：${v.actual} > ${v.limit}`);
    }
    if (facts.alignment !== "aligned") {
      problems.push(`对齐状态是 ${facts.alignment}，期望 aligned（${facts.drift.length} 项漂移）`);
    }

    if (flags.json) {
      console.log(JSON.stringify({
        ok: problems.length === 0,
        alignment: facts.alignment,
        entries: facts.entries,
        files: facts.files,
        tokens: facts.tokens,
        problems,
      }, null, 2));
      return problems.length === 0 ? 0 : 1;
    }

    console.log(C.bold("check") + `  ${state.root}`);
    console.log("");
    if (problems.length === 0) {
      console.log(C.green("  ✓ 通过"));
      console.log(C.dim(`    ${facts.entries} 条 Entry / ${facts.files} 个受管文件 / ${facts.tokens} token`));
      return 0;
    }
    for (const p of problems) console.log(C.red("  ✗ ") + p);
    return 1;
  } catch (err) {
    return fail(err);
  }
}

export function cmdStatus(root: string): number {
  try {
    const state = loadState(root);
    const facts = collectFacts(state);
    const pct = Math.round((facts.entries / Math.max(1, facts.files)) * 100);

    console.log(C.bold("cos status"));
    console.log(`  仓库      ${state.root}`);
    console.log(`  对齐      ${colorAlign(facts.alignment)}`);
    console.log(`  Entry     ${facts.entries}`);
    console.log(`  受管文件  ${facts.files}`);
    console.log(`  覆盖率    ${pct}%`);
    console.log(`  token     ${facts.tokens} / 目标 ${WHOLE_INDEX_BUDGET.target} / 上限 ${WHOLE_INDEX_BUDGET.max}`);
    console.log(`  漂移      ${facts.drift.length}`);
    if (facts.drift.length > 0) {
      const byKind: Record<string, number> = {};
      for (const d of facts.drift) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      for (const [k, v] of Object.entries(byKind)) console.log(`            ${k}: ${v}`);
    }
    console.log(`  配额违规  ${facts.quotaViolations.length}`);
    console.log("");
    console.log(C.dim("  完整索引：cat " + join(root, INDEX_PATH) + " " + join(root, META_PATH) + " " + join(root, CODE_PATH)));
    return 0;
  } catch (err) {
    return fail(err);
  }
}

function colorAlign(a: string): string {
  if (a === "aligned") return C.green(a);
  if (a === "budget_exceeded") return C.red(a);
  return C.yellow(a);
}

function fail(err: unknown): number {
  const e = err as CosError;
  console.error(C.red("✗ ") + (e.message ?? String(err)));
  if (e.code && e.code !== "cos_error") console.error(C.dim(`  code: ${e.code}`));
  return 2;
}
