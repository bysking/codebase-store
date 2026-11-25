/**
 * layout.test.ts — 数据目录布局的不变量
 *
 * 这些测试固定住「所有数据在 .codebase_store/ 下」这一设计：
 *   · 索引与状态都在该目录内，仓库根不散落文件
 *   · 该目录整体不属于受管对象（否则每次写入后自己变 stale）
 *   · 但它必须能被 Git 追踪（索引是团队资产）
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATA_DIR, INDEX_PATH, META_PATH, CODE_PATH, CONFIG_PATH, BASELINE_PATH,
} from "../src/core.ts";
import {
  initRepo, scanRepo, loadState, collectFacts, defaultConfig, resolveRole,
  readBaseline,
} from "../src/repo.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cos-layout-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("路径常量", () => {
  test("全部位于 .codebase_store 下", () => {
    for (const p of [INDEX_PATH, META_PATH, CODE_PATH, CONFIG_PATH, BASELINE_PATH]) {
      expect(p.startsWith(DATA_DIR + "/")).toBe(true);
    }
  });
});

describe("init 后的目录布局", () => {
  test("文件只在 .codebase_store 下，仓库根只有 AGENTS.md 和 .gitignore", () => {
    initRepo(root, false);
    expect(existsSync(join(root, INDEX_PATH))).toBe(true);
    expect(existsSync(join(root, META_PATH))).toBe(true);
    expect(existsSync(join(root, CODE_PATH))).toBe(true);
    expect(existsSync(join(root, CONFIG_PATH))).toBe(true);
    expect(existsSync(join(root, BASELINE_PATH))).toBe(true);
    // 根目录不散落 cos.* 文件
    expect(existsSync(join(root, "cos.txt"))).toBe(false);
    expect(existsSync(join(root, "cos.code.txt"))).toBe(false);
  });

  test("Root 的 Volume 声明用相对数据目录的路径", () => {
    initRepo(root, false);
    const rootText = loadState(root).rootText;
    expect(rootText).toContain("path=cos.meta.txt");
    expect(rootText).toContain("path=cos.code.txt");
    expect(rootText).not.toContain(".codebase_store/cos.meta.txt");
  });

  test(".gitignore 忽略临时文件但不禁索引", () => {
    initRepo(root, false);
    const gi = require("node:fs").readFileSync(join(root, ".gitignore"), "utf8") as string;
    expect(gi).toContain(`${DATA_DIR}/*.tmp-*`);
    // 不能出现整目录忽略
    expect(gi).not.toMatch(new RegExp(`^${DATA_DIR.replace(".", "\\.")}/?$`, "m"));
  });
});

describe("数据目录不属于受管对象", () => {
  test("resolveRole 对数据目录返回 exclude", () => {
    const cfg = defaultConfig();
    expect(resolveRole(DATA_DIR, cfg)).toBe("exclude");
    expect(resolveRole(`${DATA_DIR}/cos.txt`, cfg)).toBe("exclude");
    expect(resolveRole(`${DATA_DIR}/cos.code.txt`, cfg)).toBe("exclude");
  });

  test("普通源文件仍是 index 角色", () => {
    const cfg = defaultConfig();
    expect(resolveRole("src/math.ts", cfg)).toBe("index");
    expect(resolveRole("AGENTS.md", cfg)).toBe("index");
  });
});

describe("scan 不把数据目录写进基线", () => {
  test("基线不含 .codebase_store 下的任何路径", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    initRepo(root, false);
    scanRepo(root, false);
    const b = readBaseline(root);
    const leaked = Object.keys(b.stamps).filter((k) => k.startsWith(DATA_DIR));
    expect(leaked).toEqual([]);
  });
});

describe("写入后不自我 stale", () => {
  test("数据目录永远不进 drift", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    initRepo(root, false);
    scanRepo(root, false);
    const state = loadState(root);
    const facts = collectFacts(state);
    const selfDrift = facts.drift.filter((d) => d.path.startsWith(DATA_DIR));
    expect(selfDrift).toEqual([]);
  });
});
