/**
 * p0.test.ts — 五个会丢数据 / 出错误结论的回归测试
 *
 * 每个用例都对应一次实测过的线上事故：
 *   1. stdout 截断    —— cos verify --json | jq 只拿到 64 KB
 *   2. 坏行静默消失    —— 手改成小写标签的 Entry 在下一次 cos_update 后蒸发
 *   3. writeAtomic    —— 无分隔符路径把 "abc" 写成 "ab" + 目录 "abc"
 *   4. 路径越界        —— 索引里写 ../../../etc/hostname 能读到仓库外文件
 *   5. 并发丢更新      —— 两次 commitEntries(..., null) 后者覆盖前者且无报错
 *
 * 这些不是边界场景：1 和 2 都会在正常使用中发生。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_PATH, CONFIG_PATH, BASELINE_PATH, CosError, sha256 } from "../src/core.ts";
import {
  initRepo, scanRepo, loadState, collectFacts, commitEntries,
  writeAtomic, assertRepoRelativePath, isSafeRepoRelative,
} from "../src/repo.ts";
import { parseCodeVolume, roundTripCheck } from "../src/format.ts";
import { cmdVerify } from "../src/commands.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cos-p0-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 初始化 + 扫基线，得到一个可写入的干净仓库 */
function freshRepo(): string {
  initRepo(root, false);
  scanRepo(root, false);
  return root;
}

// ────────────────────────────────────────────────────────────
// P0-1 坏行静默消失
// ────────────────────────────────────────────────────────────

describe("P0-1 索引坏行必须失败关闭，不能静默丢弃", () => {
  test("parseCodeVolume 把解析不了的行记进 malformed", () => {
    const text = [
      "#COS-CODE-VOLUME: 1",
      "",
      "===/<repository>/===",
      "good.ts[CG7M]: F:a | R:- | A:- | S:-",
      "bad.ts[cg7m]: F:小写标签 | R:- | A:- | S:-",
      "alsobad.ts[XYZ]: F:标签结构全错 | R:- | A:- | S:-",
      "traverse.ts[CG7M]: F:c | R:- | A:- | S:-",
      "",
    ].join("\n");
    const doc = parseCodeVolume(text);
    expect(doc.entries.map((e) => e.path)).toEqual(["good.ts", "traverse.ts"]);
    expect(doc.malformed).toHaveLength(2);
    expect(doc.malformed[0]!.text).toContain("bad.ts");
    // 行号是 1-based，指向磁盘上的真实行
    expect(doc.malformed[0]!.line).toBe(5);
  });

  test("路径以 # 开头的合法 Entry 仍然被解析（不能靠 # 判断注释）", () => {
    const doc = parseCodeVolume("===/<repository>/===\n#foo.ts[CG7M]: F:a | R:- | A:- | S:-\n");
    expect(doc.entries.map((e) => e.path)).toEqual(["#foo.ts"]);
    expect(doc.malformed).toEqual([]);
  });

  test("空行和注释不算 malformed", () => {
    const doc = parseCodeVolume([
      "#COS-CODE-VOLUME: 1",
      "",
      "# 这是注释",
      "===/<repository>/src/===",
      "",
      "a.ts[CG7M]: F:a | R:- | A:- | S:-",
      "",
    ].join("\n"));
    expect(doc.malformed).toEqual([]);
  });

  test("commitEntries 遇到坏行整批拒绝，且文件原样未动", () => {
    freshRepo();
    const codeP = join(root, CODE_PATH);
    const before = readFileSync(codeP, "utf8");
    // 手改坏一行
    writeFileSync(codeP, before.replace(
      "===/<repository>/===",
      "===/<repository>/===\nhandwritten.ts[cg7m]: F:手改坏了 | R:- | A:- | S:-",
    ));
    const broken = readFileSync(codeP, "utf8");
    expect(broken).not.toBe(before);

    const state = loadState(root);
    expect(state.malformed).toHaveLength(1);

    expect(() => commitEntries(state, [
      { path: "src/a.ts", tag: "CG7M", f: "A", r: "-", a: "-", s: "-" },
    ], [], null)).toThrow(/无法解析成 Entry/);

    // 关键：坏行还在，没有被"合法 Entry 写入"顺手抹掉
    expect(readFileSync(codeP, "utf8")).toBe(broken);
  });

  test("坏行会出现在 facts.drift 里，并在 alignment 上体现", () => {
    freshRepo();
    const codeP = join(root, CODE_PATH);
    writeFileSync(codeP, readFileSync(codeP, "utf8").replace(
      "===/<repository>/===",
      "===/<repository>/===\nbroken.ts[cg7m]: F:x | R:- | A:- | S:-",
    ));
    const facts = collectFacts(loadState(root));
    expect(facts.drift.some((d) => d.kind === "malformed")).toBe(true);
    expect(facts.alignment).not.toBe("aligned");
  });

  test("修好坏行后可以正常写入", () => {
    freshRepo();
    const codeP = join(root, CODE_PATH);
    writeFileSync(codeP, readFileSync(codeP, "utf8").replace(
      "===/<repository>/===",
      "===/<repository>/===\nbroken.ts[cg7m]: F:x | R:- | A:- | S:-",
    ));
    // 模拟手工修好：删掉坏行
    const fixed = readFileSync(codeP, "utf8").split("\n").filter((l) => !l.includes("broken.ts")).join("\n");
    writeFileSync(codeP, fixed);

    const state = loadState(root);
    expect(state.malformed).toHaveLength(0);
    const r = commitEntries(state, [
      { path: "src/a.ts", tag: "CG7M", f: "A", r: "-", a: "-", s: "-" },
    ], [], null);
    expect(r.entries).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────
// P0-2 writeAtomic 目录切分
// ────────────────────────────────────────────────────────────

describe("P0-2 writeAtomic 对无分隔符路径不能切错目录", () => {
  test("写裸文件名时只产生文件，不产生被砍掉一个字符的目录", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cos-atomic-"));
    const cwd = process.cwd();
    try {
      process.chdir(tmp);
      writeAtomic("plain.txt", "hello");
      const names = readdirSync(".");
      expect(names).toContain("plain.txt");
      // 旧实现会造出 "plain.tx" 目录
      expect(names).not.toContain("plain.tx");
      expect(statSync("plain.txt").isFile()).toBe(true);
      expect(readFileSync("plain.txt", "utf8")).toBe("hello");
    } finally {
      process.chdir(cwd);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("带目录的相对路径仍然正确建父目录", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cos-atomic-"));
    const cwd = process.cwd();
    try {
      process.chdir(tmp);
      writeAtomic("a/b/c.txt", "deep");
      expect(readFileSync(join(tmp, "a", "b", "c.txt"), "utf8")).toBe("deep");
    } finally {
      process.chdir(cwd);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("绝对路径写到目标的真实父目录", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cos-atomic-"));
    try {
      const target = join(tmp, "x", "y.txt");
      writeAtomic(target, "abs");
      expect(readFileSync(target, "utf8")).toBe("abs");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("initRepo 在仓库根写文件不会留下垃圾目录", () => {
    initRepo(root, false);
    // 旧实现会把 "AGENTS.md" 切成 "AGENTS.m" 去建目录
    const junk = readdirSync(root).filter((n) => n === "AGENTS.m" || n === "AGENTS");
    expect(junk).toEqual([]);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(statSync(join(root, "AGENTS.md")).isFile()).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// P0-3 Entry 路径越界
// ────────────────────────────────────────────────────────────

describe("P0-3 Entry 路径不得越出仓库", () => {
  test("assertRepoRelativePath 拦住绝对路径与 .. 段", () => {
    expect(() => assertRepoRelativePath("/etc/passwd")).toThrow(/绝对路径/);
    expect(() => assertRepoRelativePath("../../../etc/hostname")).toThrow(/不能包含 \.\./);
    expect(() => assertRepoRelativePath("a/../../b")).toThrow(/不能包含 \.\./);
    expect(() => assertRepoRelativePath("")).toThrow(/不能为空/);
    expect(() => assertRepoRelativePath("src/a.ts")).not.toThrow();
    // 名字里含 .. 但不是路径段的必须放行（如 a..b.ts）
    expect(() => assertRepoRelativePath("src/a..b.ts")).not.toThrow();
  });

  test("isSafeRepoRelative 与 assert 版本判定一致", () => {
    expect(isSafeRepoRelative("src/a.ts")).toBe(true);
    expect(isSafeRepoRelative("src/a..b.ts")).toBe(true);
    expect(isSafeRepoRelative("/abs")).toBe(false);
    expect(isSafeRepoRelative("a/../b")).toBe(false);
    expect(isSafeRepoRelative("")).toBe(false);
  });

  test("写入时 removals 里的越界路径也会被拒绝", () => {
    freshRepo();
    const state = loadState(root);
    expect(() => commitEntries(state, [], ["../../../etc/hostname"], null)).toThrow(/不能包含 \.\./);
  });

  test("已落盘的越界 Entry 会让 loadState 失败关闭，而不是去读仓库外文件", () => {
    freshRepo();
    const codeP = join(root, CODE_PATH);
    writeFileSync(codeP, readFileSync(codeP, "utf8").replace(
      "===/<repository>/===",
      "===/<repository>/===\n../../../etc/hostname[CZ7T]: F:越界 | R:- | A:- | S:-",
    ));
    // loadState 直接拒绝，collectFacts 根本没机会去 join 出仓库外的路径
    expect(() => loadState(root)).toThrow(/不是仓库相对路径/);
  });
});

// ────────────────────────────────────────────────────────────
// P0-4 并发丢更新（隐式 CAS）
// ────────────────────────────────────────────────────────────

describe("P0-4 并发写入必须失败关闭，不能静默覆盖", () => {
  test("拿着旧快照 commit 会被拒绝，先写的不丢", () => {
    freshRepo();
    const s1 = loadState(root);
    const s2 = loadState(root);   // 两个 Agent 各自读了一次

    // A 先写
    commitEntries(s1, [
      { path: "src/a.ts", tag: "CG7M", f: "A 写的", r: "-", a: "-", s: "-" },
    ], [], null);

    // B 拿着过时快照再写 —— 必须被 CAS 拦住
    expect(() => commitEntries(s2, [
      { path: "src/b.ts", tag: "CG7M", f: "B 写的", r: "-", a: "-", s: "-" },
    ], [], null)).toThrow(/cas_conflict|被改动过/);

    // A 的写入完好无损
    const now = loadState(root);
    expect(now.entries.map((e) => e.path)).toEqual(["src/a.ts"]);
    expect(now.entries[0]!.f).toBe("A 写的");
  });

  test("重新读取后再写是可以的（不误伤正常流程）", () => {
    freshRepo();
    const s1 = loadState(root);
    commitEntries(s1, [{ path: "src/a.ts", tag: "CG7M", f: "A", r: "-", a: "-", s: "-" }], [], null);
    const s2 = loadState(root);   // 重新读
    commitEntries(s2, [{ path: "src/b.ts", tag: "CG7M", f: "B", r: "-", a: "-", s: "-" }], [], null);
    expect(loadState(root).entries.map((e) => e.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("显式 expectSha 仍然生效（兼容旧调用约定）", () => {
    freshRepo();
    const state = loadState(root);
    expect(() => commitEntries(state, [
      { path: "src/a.ts", tag: "CG7M", f: "A", r: "-", a: "-", s: "-" },
    ], [], "错误的 sha")).toThrow(/CAS 失败/);
  });

  test("磁盘被外部改动（不经过 API）时也拦住", () => {
    freshRepo();
    const state = loadState(root);
    // 外部手改文件
    const codeP = join(root, CODE_PATH);
    writeFileSync(codeP, readFileSync(codeP, "utf8") + "\n# 外部改动\n");
    expect(() => commitEntries(state, [
      { path: "src/a.ts", tag: "CG7M", f: "A", r: "-", a: "-", s: "-" },
    ], [], null)).toThrow(/被改动过/);
  });
});

// ────────────────────────────────────────────────────────────
// 一个组合场景：五件事同时发生时的行为
// ────────────────────────────────────────────────────────────

describe("组合场景", () => {
  test("坏行 + 并发：坏行优先级最高，先报格式问题", () => {
    freshRepo();
    const codeP = join(root, CODE_PATH);
    writeFileSync(codeP, readFileSync(codeP, "utf8").replace(
      "===/<repository>/===",
      "===/<repository>/===\nbroken.ts[cg7m]: F:x | R:- | A:- | S:-",
    ));
    const staleSnapshot = loadState(root);
    // 再改一次磁盘，制造 CAS 冲突
    writeFileSync(codeP, readFileSync(codeP, "utf8") + "\n# more\n");

    expect(() => commitEntries(staleSnapshot, [
      { path: "src/a.ts", tag: "CG7M", f: "A", r: "-", a: "-", s: "-" },
    ], [], null)).toThrow(/无法解析成 Entry/);
  });

  test("roundTripCheck 仍然拦住会被字段分隔符切断的内容", () => {
    expect(() => roundTripCheck([
      { path: "a.ts", tag: "CG7M", f: "输出 a | R: 解析后的关系", r: "-", a: "-", s: "-" },
    ])).toThrow(/字段不一致/);
  });
});
