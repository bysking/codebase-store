/**
 * commands.ts — CLI 命令实现
 *
 * 对应 AOCI-CODE 的 internal/cli（52 文件），压缩为 6 个命令。
 */

import { join } from "node:path";
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

    /*
     * 待创作 / 待删除必须计入退出码。
     *
     * 旧实现只看 drift，于是刚 init+scan 完的仓库（3000 个文件全都没写 Entry）
     * 会输出「✓ 无漂移」并 exit 0 —— 接进 CI 就是一路假绿。而同一状态下
     * status 显示覆盖 0%、check 直接报错。三个命令自相矛盾。
     */
    const pending = facts.needAuthoring.length + facts.needRemoval.length;
    const exitCode = facts.drift.length === 0 && pending === 0 ? 0 : 1;

    if (flags.json) {
      console.log(JSON.stringify({
        alignment: facts.alignment,
        drift: facts.drift,
        entries: facts.entries,
        files: facts.files,
        hasBaseline: facts.hasBaseline,
        needAuthoring: facts.needAuthoring.length,
        needRemoval: facts.needRemoval.length,
        pending,
      }, null, 2));
      return exitCode;
    }

    console.log(C.bold("verify") + `  ${state.root}`);
    console.log("");

    if (facts.drift.length === 0 && pending === 0) {
      console.log(C.green("  ✓ 无漂移，无待创作项"));
      return 0;
    }
    if (facts.drift.length === 0) {
      console.log(C.green("  ✓ 无漂移"));
    }

    const groups = new Map<string, string[]>();
    for (const d of facts.drift) {
      if (!groups.has(d.kind)) groups.set(d.kind, []);
      groups.get(d.kind)!.push(d.path);
    }
    const label: Record<string, string> = {
      malformed: "Malformed（索引里有解析不了的行，写入会丢数据）",
      missing: "Missing（Entry 在，文件不在）",
      orphan: "Orphan（Entry 在，对象已不是 index 角色）",
      stale: "Stale（源码变了，Entry 未更新）",
      unbaselined: "Unbaselined（受管但未进基线）",
    };
    for (const [kind, paths] of groups) {
      console.log(C.yellow(`  ${label[kind] ?? kind}`) + C.dim(`  ${paths.length} 项`));
      for (const p of paths.slice(0, 20)) console.log(`    ${p}`);
      if (paths.length > 20) console.log(C.dim(`    ... 还有 ${paths.length - 20} 项`));
      console.log("");
    }

    // 「还没写 Entry」是一项待办，不是漂移 —— 但它照样必须让退出码非零。
    if (facts.needAuthoring.length > 0) {
      console.log(C.yellow("  NeedAuthoring（受管但还没有 Entry，待创作）") + C.dim(`  ${facts.needAuthoring.length} 项`));
      for (const p of facts.needAuthoring.slice(0, 20)) console.log(`    ${p}`);
      if (facts.needAuthoring.length > 20) console.log(C.dim(`    ... 还有 ${facts.needAuthoring.length - 20} 项`));
      console.log(C.dim("    用 cos_maintain 拿下一批写的目标。"));
      console.log("");
    }
    if (facts.needRemoval.length > 0) {
      console.log(C.yellow("  NeedRemoval（Entry 已失效，待删除）") + C.dim(`  ${facts.needRemoval.length} 项`));
      for (const p of facts.needRemoval.slice(0, 20)) console.log(`    ${p}`);
      if (facts.needRemoval.length > 20) console.log(C.dim(`    ... 还有 ${facts.needRemoval.length - 20} 项`));
      console.log("");
    }

    return exitCode;
  } catch (err) {
    return fail(err);
  }
}

export function cmdCheck(root: string, flags: { json?: boolean }): number {
  try {
    const state = loadState(root);
    const facts = collectFacts(state);
    const problems: string[] = [];
    const warnings: string[] = [];

    if (facts.entries === 0) problems.push("索引为空：还没有任何 Entry。让 Agent 跑 cos_maintain 建索引。");
    if (facts.tokens > WHOLE_INDEX_BUDGET.max) {
      problems.push(`索引 ${facts.tokens} token 超过硬上限 ${WHOLE_INDEX_BUDGET.max}。需要裁剪或拆分。`);
    } else if (facts.tokens > WHOLE_INDEX_BUDGET.warning) {
      // warning 线此前定义了却从没被用过 —— 超 target 但没超 max 的阶段没人提醒
      warnings.push(
        `索引 ${facts.tokens} token 已过警戒线 ${WHOLE_INDEX_BUDGET.warning}（目标 ${WHOLE_INDEX_BUDGET.target}）。` +
        `现在还不算失败，但该开始裁剪了。`,
      );
    }
    for (const v of facts.quotaViolations) {
      problems.push(`配额超限 ${v.path} 的 ${v.field}：${v.actual} > ${v.limit}`);
    }
    if (facts.alignment !== "aligned") {
      problems.push(`对齐状态是 ${facts.alignment}，期望 aligned（${facts.drift.length} 项漂移，${facts.needAuthoring.length} 项待创作）`);
    }

    if (flags.json) {
      console.log(JSON.stringify({
        ok: problems.length === 0,
        alignment: facts.alignment,
        entries: facts.entries,
        files: facts.files,
        tokens: facts.tokens,
        hasBaseline: facts.hasBaseline,
        needAuthoring: facts.needAuthoring.length,
        needRemoval: facts.needRemoval.length,
        problems,
        warnings,
      }, null, 2));
      return problems.length === 0 ? 0 : 1;
    }

    console.log(C.bold("check") + `  ${state.root}`);
    console.log("");
    for (const w of warnings) console.log(C.yellow("  ! ") + w);
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
    console.log(`  基线      ${facts.hasBaseline ? C.green("已建立") : C.yellow("未建立（先跑 cos scan）")}`);
    console.log(`  Entry     ${facts.entries}`);
    console.log(`  受管文件  ${facts.files}`);
    console.log(`  覆盖率    ${pct}%`);
    console.log(`  待创作    ${facts.needAuthoring.length}`);
    console.log(`  待删除    ${facts.needRemoval.length}`);
    console.log(`  token     ${facts.tokens} / 目标 ${WHOLE_INDEX_BUDGET.target} / 警戒 ${WHOLE_INDEX_BUDGET.warning} / 上限 ${WHOLE_INDEX_BUDGET.max}`);
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
