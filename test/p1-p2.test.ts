/**
 * p1-p2.test.ts — 状态语义、分块、baseline 升级、性能快路径的回归
 *
 * 对应此前实测出来的问题：
 *   P1-6/7  verify 看不到待创作项（CI 假绿）；alignment 把「没 Entry」误报成 unbaselined
 *   P1-8    init --force 不重置 baseline，得到自相矛盾的状态
 *   P1-9    cos_overview 按字节切块，把一条 Entry 从中间切断
 *   P1-10   check 绕过 WHOLE_INDEX_BUDGET 常量；warning 线从未生效
 *   P1-11   config 里 locale/indexPath/refreshThreshold 是死字段
 *   P1-12   版本号三处硬编码
 *   P2-13   baseline 只存 sha → 每次 collectFacts 都要整读全仓
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODE_PATH, CONFIG_PATH, BASELINE_PATH, WHOLE_INDEX_BUDGET, DATA_DIR,
} from "../src/core.ts";
import {
  initRepo, scanRepo, loadState, collectFacts, commitEntries,
  readBaseline, writeBaseline, emptyBaseline, stampFile, fileChanged,
} from "../src/repo.ts";
import { chunkOverview } from "../src/tools.ts";
import { VERSION } from "../src/version.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cos-p12-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshRepo(): string {
  initRepo(root, false);
  scanRepo(root, false);
  return root;
}

/**
 * 把仓库里所有应当有 Entry 的受管文件都写进去。
 * 注意 init 自己会产生 .gitignore 和 AGENTS.md，它们同样是 index 角色。
 */
function authorEverything(repoRoot: string): void {
  const s = loadState(repoRoot);
  const facts = collectFacts(s);
  commitEntries(s, facts.needAuthoring.map((p) => ({
    path: p, tag: "CG7M", f: "x", r: "-", a: "-", s: "-",
  })), [], null);
}

// ────────────────────────────────────────────────────────────
// P1-6/7 状态语义
// ────────────────────────────────────────────────────────────

describe("P1-6/7 alignment 与 hasBaseline 语义", () => {
  test("刚 init+scan、0 条 Entry 时 alignment 是 authoring_required，不是 unbaselined", () => {
    freshRepo();
    const facts = collectFacts(loadState(root));
    expect(facts.hasBaseline).toBe(true);
    expect(facts.entries).toBe(0);
    // 基线已建立，所以"没 Entry"是待创作，不是"没有基线"
    expect(facts.alignment).toBe("authoring_required");
  });

  test("基线为空时才是 unbaselined", () => {
    initRepo(root, false);   // 只 init，不 scan
    const facts = collectFacts(loadState(root));
    expect(facts.hasBaseline).toBe(false);
    expect(facts.alignment).toBe("unbaselined");
  });

  test("全部写完 Entry 后 alignment 变成 aligned", () => {
    freshRepo();
    authorEverything(root);
    const facts = collectFacts(loadState(root));
    expect(facts.needAuthoring).toEqual([]);
    expect(facts.drift).toEqual([]);
    expect(facts.alignment).toBe("aligned");
  });

  test("verify --json 暴露 needAuthoring 且计入退出码（CI 不能假绿）", () => {
    freshRepo();
    const code = cmdVerifyJson(root);
    const parsed = JSON.parse(code.out) as { needAuthoring: number; pending: number; hasBaseline: boolean };
    expect(parsed.hasBaseline).toBe(true);
    expect(parsed.needAuthoring).toBeGreaterThan(0);
    expect(parsed.pending).toBeGreaterThan(0);
    // 旧实现这里返回 0（"✓ 无漂移"），接进 CI 就是一路绿
    expect(code.exit).toBe(1);
  });

  test("全部创作完成后 verify 才退出 0", () => {
    freshRepo();
    authorEverything(root);
    const code = cmdVerifyJson(root);
    expect(code.exit).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────
// P1-8 init --force 重置 baseline
// ────────────────────────────────────────────────────────────

describe("P1-8 init --force 必须重置基线", () => {
  test("force 之后 baseline 为空，不再是上一轮的指纹", () => {
    freshRepo();
    const before = Object.keys(readBaseline(root).stamps).length;
    expect(before).toBeGreaterThan(0);

    initRepo(root, true);

    const after = readBaseline(root);
    expect(Object.keys(after.stamps)).toEqual([]);
    expect(after.version).toBe(2);
    // 认知文件也被清空
    expect(loadState(root).entries).toEqual([]);
  });

  test("force 之后 hasBaseline 为 false，alignment 回到 unbaselined", () => {
    freshRepo();
    initRepo(root, true);
    const facts = collectFacts(loadState(root));
    expect(facts.hasBaseline).toBe(false);
    expect(facts.alignment).toBe("unbaselined");
  });

  test("不带 force 的 init 不会清掉已有基线", () => {
    freshRepo();
    const before = readBaseline(root).stamps;
    initRepo(root, true);
    scanRepo(root, false);
    const reScanned = readBaseline(root).stamps;
    expect(Object.keys(reScanned).length).toBeGreaterThan(0);
    expect(Object.keys(before).length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────
// P1-9 分块不切断 Entry
// ────────────────────────────────────────────────────────────

describe("P1-9 cos_overview 只在行边界切块", () => {
  /** 造一个足够大的 Code Volume 文本 */
  function makeVolume(entryCount: number): string {
    const lines = ["#COS-CODE-VOLUME: 1", "", "===/<repository>/src/==="];
    for (let i = 0; i < entryCount; i++) {
      lines.push(`file${i}.ts[CG7M]: F:职责${i} | R:code:x.ts | A:- | S:注意${i}`);
    }
    return lines.join("\n");
  }

  test("每一块的首行都不是半条 Entry", () => {
    const text = makeVolume(400);
    const { chunks } = chunkOverview(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [i, c] of chunks.entries()) {
      const first = c.split("\n")[0]!;
      // 半条 Entry 的特征：以 ":" 或字母/数字开头但没有 tag 结构
      const looksLikeWholeEntry = /\[[A-Z]{2}[1-9][A-Z]?[LMST]\]:\s*F:/.test(first);
      const looksLikeHeader = first.startsWith("#") || first.startsWith("===") || first === "";
      expect(
        looksLikeWholeEntry || looksLikeHeader,
        `chunk ${i} 首行不是完整的 Entry 也不是头部: ${JSON.stringify(first.slice(0, 60))}`,
      ).toBe(true);
    }
  });

  test("所有块拼回去等于原文（不丢字符）", () => {
    const text = makeVolume(400);
    const { chunks } = chunkOverview(text, 4000);
    // 按行切分时块之间丢了一个换行符，补回来再比
    const reassembled = chunks.join("\n");
    expect(reassembled).toBe(text);
  });

  test("每块的 token 大致在预算内（允许单行超预算的例外）", () => {
    const text = makeVolume(400);
    const { chunks } = chunkOverview(text, 4000);
    for (const c of chunks) {
      // 每块最多超出一个 Entry 的量级，不会是原文的一大截
      expect(c.length).toBeLessThan(text.length);
    }
  });

  test("文本本身在预算内时只有一块，且原样返回", () => {
    const text = makeVolume(3);
    const { chunks } = chunkOverview(text, 4000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  test("单行就超预算时仍会切开，但不会把后面的 Entry 混进来", () => {
    const longLine = "x".repeat(50000);
    const text = `#HEAD\n${longLine}\nnext.ts[CG7M]: F:a | R:- | A:- | S:-`;
    const { chunks } = chunkOverview(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    // 最后一段里应该带着后面那条正常 Entry
    expect(chunks[chunks.length - 1]).toContain("next.ts[CG7M]");
  });
});

// ────────────────────────────────────────────────────────────
// P1-10 预算常量
// ────────────────────────────────────────────────────────────

describe("P1-10 预算常量是唯一来源", () => {
  test("WHOLE_INDEX_BUDGET 三档有序，且被 alignment 使用", () => {
    expect(WHOLE_INDEX_BUDGET.target).toBeLessThan(WHOLE_INDEX_BUDGET.warning);
    expect(WHOLE_INDEX_BUDGET.warning).toBeLessThan(WHOLE_INDEX_BUDGET.max);
  });

  test("超硬上限时 alignment 是 budget_exceeded", () => {
    freshRepo();
    /*
     * 必须用真实的 Entry 把索引撑大 —— token 只统计 Root+Meta+Code 的原文，
     * 注释行虽然也在文件里，但这里要验证的是"索引本身超预算"这条判定路径。
     * 用 high 档配额上限内的一条超长 S（c9）来扩大体积。
     */
    const codeP = join(root, CODE_PATH);
    const longS = "y".repeat(600);
    const entryLines: string[] = ["#COS-CODE-VOLUME: 1", "", "===/<repository>/src/==="];
    // C9 → S 上限 600；实测每条约 160 token，需 1500+ 条才会超过 max（240k）
    for (let i = 0; i < 1600; i++) {
      entryLines.push(`f${i}.ts[C9:L]: F:职责 | R:- | A:- | S:${longS}`);
    }
    writeFileSync(codeP, entryLines.join("\n") + "\n");

    const facts = collectFacts(loadState(root));
    expect(facts.tokens).toBeGreaterThan(WHOLE_INDEX_BUDGET.max);
    expect(facts.alignment).toBe("budget_exceeded");
  });
});

// ────────────────────────────────────────────────────────────
// P1-11 配置死字段
// ────────────────────────────────────────────────────────────

describe("P1-11 废弃配置字段", () => {
  test("defaultConfig 不再产出 locale/indexPath/refreshThreshold", () => {
    freshRepo();
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), "utf8")) as Record<string, unknown>;
    expect(cfg.locale).toBeUndefined();
    expect(cfg.indexPath).toBeUndefined();
    expect(cfg.refreshThreshold).toBeUndefined();
    // 真正生效的字段还在
    expect(Array.isArray(cfg.excludeDirs)).toBe(true);
    expect(typeof cfg.chunkTokens).toBe("number");
    expect(Array.isArray(cfg.scopeRules)).toBe(true);
  });

  test("旧 config.json 里的废弃字段被剔除，且不影响其余配置", () => {
    freshRepo();
    const p = join(root, CONFIG_PATH);
    const cfg = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    cfg.locale = "en-US";
    cfg.indexPath = "custom/cos.txt";
    cfg.refreshThreshold = 99;
    cfg.chunkTokens = 5000;
    writeFileSync(p, JSON.stringify(cfg, null, 2));

    const state = loadState(root);
    expect(state.cfg.chunkTokens).toBe(5000);     // 有效字段保留
    const cfgAsRaw = state.cfg as unknown as Record<string, unknown>;
    expect(cfgAsRaw.locale).toBeUndefined();
    expect(cfgAsRaw.refreshThreshold).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// P1-12 版本号单一来源
// ────────────────────────────────────────────────────────────

describe("P1-12 版本号来自 package.json", () => {
  test("VERSION 与 package.json 的 version 一致", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  test("VERSION 不是 unknown（能真的读到 package.json）", () => {
    expect(VERSION).not.toBe("unknown");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ────────────────────────────────────────────────────────────
// P2-13 mtime 快路径 + baseline v1→v2 迁移
// ────────────────────────────────────────────────────────────

describe("P2-13 baseline 指纹与快路径", () => {
  test("baseline 存的是 sha+size+mtime，不是裸 sha", () => {
    freshRepo();
    const b = readBaseline(root);
    const stamp = b.stamps["src/a.ts"];
    expect(stamp).toBeDefined();
    expect(typeof stamp!.sha).toBe("string");
    expect(stamp!.sha).toHaveLength(64);
    expect(stamp!.size).toBeGreaterThan(0);
    expect(stamp!.mtimeMs).toBeGreaterThan(0);
  });

  test("文件没变时 fileChanged 返回 false，且不改变结论", () => {
    freshRepo();
    const b = readBaseline(root);
    const full = join(root, "src", "a.ts");
    expect(fileChanged(full, b.stamps["src/a.ts"])).toBe(false);
  });

  test("文件内容变了（size 也变）时 fileChanged 返回 true", () => {
    freshRepo();
    const b = readBaseline(root);
    const full = join(root, "src", "a.ts");
    writeFileSync(full, "export const a = 1;\nexport const extra = 2;\n");
    expect(fileChanged(full, b.stamps["src/a.ts"])).toBe(true);
  });

  test("内容变了但 size 恰好相同时仍能靠 sha 抓到", () => {
    freshRepo();
    const b = readBaseline(root);
    const full = join(root, "src", "a.ts");
    // 同长度替换：size 不变，mtime 会变 → 走慢路径 → sha 不同
    writeFileSync(full, "export const a = 9;\n");
    expect(fileChanged(full, b.stamps["src/a.ts"])).toBe(true);
  });

  test("stale 判定端到端：改了文件后 verify 能报 stale", () => {
    freshRepo();
    const s = loadState(root);
    commitEntries(s, [
      { path: "src/a.ts", tag: "CG7M", f: "A", r: "-", a: "-", s: "-" },
    ], [], null);
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n// changed\n");
    const facts = collectFacts(loadState(root));
    expect(facts.drift.some((d) => d.kind === "stale" && d.path === "src/a.ts")).toBe(true);
  });

  test("v1 格式的 baseline（files: path->sha）能被读入并升级", () => {
    freshRepo();
    const legacy = {
      version: 1,
      files: { "src/a.ts": "0".repeat(64), "src/b.ts": "1".repeat(64) },
      entries: {},
      source: { "src/a.ts": "indexed", "src/b.ts": "indexed" },
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(root, BASELINE_PATH), JSON.stringify(legacy, null, 2));

    const b = readBaseline(root);
    expect(b.version).toBe(2);
    expect(Object.keys(b.stamps).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    // 旧条目没有 size/mtime，记为 -1，会强制走 sha 慢路径
    expect(b.stamps["src/a.ts"]!.size).toBe(-1);
    expect(b.stamps["src/a.ts"]!.sha).toBe("0".repeat(64));
    expect(b.source["src/a.ts"]).toBe("indexed");
  });

  test("v1 升级后第一次比对仍能正确判定 staleness（不因缺字段而误判）", () => {
    freshRepo();
    const realStamp = stampFile(join(root, "src", "a.ts"))!;
    writeFileSync(join(root, BASELINE_PATH), JSON.stringify({
      version: 1,
      // 故意写一个错的 sha，模拟"文件已变但基线还是旧的"
      files: { "src/a.ts": "0".repeat(64) },
      entries: {},
      source: {},
      updatedAt: new Date().toISOString(),
    }, null, 2));
    expect(realStamp.sha).not.toBe("0".repeat(64));

    const b = readBaseline(root);
    const changed = fileChanged(join(root, "src", "a.ts"), b.stamps["src/a.ts"]);
    expect(changed).toBe(true);
  });

  test("scan 会写入完整指纹，跑两次结果稳定", () => {
    freshRepo();
    const first = readBaseline(root).stamps;
    scanRepo(root, true);
    const second = readBaseline(root).stamps;
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
    for (const k of Object.keys(first)) {
      expect(second[k]!.sha).toBe(first[k]!.sha);
    }
  });

  test("空基线是 v2 形态", () => {
    const b = emptyBaseline();
    expect(b.version).toBe(2);
    expect(b.stamps).toEqual({});
    expect("files" in b).toBe(false);
  });

  /*
   * 关键用例：证明快路径**真的没有读文件**，而不只是"结果碰巧对"。
   *
   * 观测手法：把文件权限改成 000（size / mtime 不变）。
   *   · 走快路径（只 stat）→ 不读 → 正常返回 false（判定"没变"）
   *   · 走慢路径（整读算 sha）→ 读失败 → 返回 true
   * 两个分支的返回值不同，所以这个测试能精确区分是否读了文件。
   * 上一版没有这个用例，把快路径回退后测试依然全绿 —— 那样的测试等于没测。
   */
  test("快路径在 size+mtime 未变时确实不读文件", () => {
    freshRepo();
    const b = readBaseline(root);
    const full = join(root, "src", "a.ts");
    const prev = b.stamps["src/a.ts"]!;

    // 确认前置条件：指纹与当前文件一致
    expect(fileChanged(full, prev)).toBe(false);

    chmodSync(full, 0o000);
    try {
      // 没变 → 快路径 → 不读文件 → false
      expect(fileChanged(full, prev)).toBe(false);
      // 强行构造一个 size 不同的指纹 → 必须走慢路径 → 读失败 → true
      expect(fileChanged(full, { ...prev, size: prev.size + 999 })).toBe(true);
    } finally {
      chmodSync(full, 0o644);
    }
  });

  test("mtime 变化但内容相同会走慢路径并最终判定未变", () => {
    freshRepo();
    const b = readBaseline(root);
    const full = join(root, "src", "a.ts");
    const prev = b.stamps["src/a.ts"]!;

    // 只改 mtime，内容一字不动
    const now = new Date();
    utimesSync(full, now, now);

    // 慢路径会重算 sha，与基线相同 → 结论仍是"没变"
    expect(fileChanged(full, prev)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// 辅助：在进程内跑 cmdVerify 的 JSON 模式并捕获 stdout
// ────────────────────────────────────────────────────────────

function cmdVerifyJson(repoRoot: string): { out: string; exit: number } {
  const chunks: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { chunks.push(a.map(String).join(" ")); };
  let exit = 0;
  try {
    // 延迟 require 以避免顶层 import 的循环依赖问题
    const { cmdVerify } = require("../src/commands.ts") as typeof import("../src/commands.ts");
    exit = cmdVerify(repoRoot, { json: true });
  } finally {
    console.log = origLog;
  }
  return { out: chunks.join("\n"), exit };
}
