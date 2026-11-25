/**
 * discovery.test.ts — 仓库定位：向上查找 .codebase_store + 多项目切换
 *
 * 核心诉求：一份 MCP 配置服务多个项目。
 * 命中依据是「最近的已初始化 .codebase_store」，不是 .git。
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, INDEX_PATH } from "../src/core.ts";
import {
  findInitializedRoot, isInitialized, initRepo, findRepoRoot,
} from "../src/repo.ts";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cos-disc-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** 造一个已初始化的项目（在 dir 下写 .codebase_store/cos.txt） */
function makeProject(dir: string, name = "p") {
  mkdirSync(join(dir, ".git"), { recursive: true });
  initRepo(dir, false);
  writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");
  return dir;
}

describe("isInitialized", () => {
  test("未初始化目录返回 false", () => {
    expect(isInitialized(base)).toBe(false);
  });
  test("有 .codebase_store/cos.txt 返回 true", () => {
    makeProject(base);
    expect(isInitialized(base)).toBe(true);
    expect(existsSync(join(base, DATA_DIR, "cos.txt"))).toBe(true);
  });
});

describe("findInitializedRoot：向上查找", () => {
  test("在项目根直接命中", () => {
    makeProject(base);
    expect(findInitializedRoot(base)).toBe(base);
  });

  test("在深层子目录也能命中项目根", () => {
    makeProject(base);
    const deep = join(base, "src", "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(findInitializedRoot(deep)).toBe(base);
  });

  test("未初始化的父目录不会误命中", () => {
    const noCog = join(base, "nothing");
    mkdirSync(noCog, { recursive: true });
    expect(findInitializedRoot(noCog)).toBeNull();
  });
});

describe("多项目共存：命中最近的那个", () => {
  test("嵌套项目取内层（最近的 .codebase_store）", () => {
    // 外层项目
    makeProject(base, "outer");
    // 内层子项目（也有自己的 .git 和 .codebase_store）
    const inner = join(base, "packages", "inner");
    mkdirSync(inner, { recursive: true });
    makeProject(inner, "inner");

    // 在 inner 里 → 命中 inner
    expect(findInitializedRoot(inner)).toBe(inner);
    // 在 inner 的子目录 → 仍命中 inner
    const innerDeep = join(inner, "src");
    mkdirSync(innerDeep, { recursive: true });
    expect(findInitializedRoot(innerDeep)).toBe(inner);
    // 在外层根 → 命中外层（不会被内层劫持）
    expect(findInitializedRoot(base)).toBe(base);
  });

  test("兄弟项目互不干扰", () => {
    const a = join(base, "proj-a");
    const b = join(base, "proj-b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    makeProject(a, "a");
    makeProject(b, "b");

    expect(findInitializedRoot(a)).toBe(a);
    expect(findInitializedRoot(b)).toBe(b);
  });

  test("父目录是项目、子目录不是 —— 子目录命中父项目", () => {
    makeProject(base, "root-proj");
    const sub = join(base, "some-lib");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(sub, ".git"), { recursive: true }); // 有 .git 但没 cos
    expect(findInitializedRoot(sub)).toBe(base);
  });
});

describe("与 .git 定位的区别", () => {
  test("findRepoRoot 用 .git，findInitializedRoot 用 .codebase_store", () => {
    const proj = join(base, "p");
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(proj, ".git"), { recursive: true });
    // 有 .git 未 init
    expect(findRepoRoot(proj)).toBe(proj);
    expect(findInitializedRoot(proj)).toBeNull();

    // init 之后两者一致
    initRepo(proj, false);
    expect(findInitializedRoot(proj)).toBe(proj);
  });

  test("同一仓库内多个子项目时 .git 无法区分，.codebase_store 可以", () => {
    makeProject(base, "mono");
    const pkg1 = join(base, "pkg1");
    const pkg2 = join(base, "pkg2");
    mkdirSync(pkg1, { recursive: true });
    mkdirSync(pkg2, { recursive: true });
    initRepo(pkg1, false);
    initRepo(pkg2, false);

    // .git 定位：三个目录都指同一个仓库根
    expect(findRepoRoot(pkg1)).toBe(base);
    expect(findRepoRoot(pkg2)).toBe(base);
    // .codebase_store 定位：各自命中自己
    expect(findInitializedRoot(pkg1)).toBe(pkg1);
    expect(findInitializedRoot(pkg2)).toBe(pkg2);
  });
});

describe("init 后立刻可被发现", () => {
  test("initRepo 之后 findInitializedRoot 立即生效", () => {
    expect(findInitializedRoot(base)).toBeNull();
    initRepo(base, false);
    expect(findInitializedRoot(base)).toBe(base);
  });

  test("--force 重新 init 不破坏可发现性", () => {
    initRepo(base, false);
    initRepo(base, true);
    expect(findInitializedRoot(base)).toBe(base);
    expect(existsSync(join(base, INDEX_PATH))).toBe(true);
  });
});

describe("cos_report 暴露仓库身份", () => {
  test("返回 root 与 rootSource，便于确认定位是否正确", async () => {
    const { TOOLS } = await import("../src/tools.ts");
    const report = TOOLS.find((t) => t.name === "cos_report")!;

    makeProject(base);
    writeFileSync(join(base, "src.ts"), "export const x = 1;\n");
    const scan = (await import("../src/repo.ts")).scanRepo;
    scan(base, false);

    // cwd 模式
    const a = await report.handler({}, { root: base, fixedRoot: null }) as Record<string, unknown>;
    expect(a.root).toBe(base);
    expect(a.rootSource).toBe("cwd");

    // --repo 模式
    const b = await report.handler({}, { root: base, fixedRoot: base }) as Record<string, unknown>;
    expect(b.rootSource).toBe("fixed_repo");
  });
});
