/**
 * agents-block.test.ts — AGENTS.md 托管块的幂等与自愈
 *
 * 核心不变量：无论输入多乱，upsertBlock 输出里**有且只有一个** start 标记，
 * 且用户手写在块外的内容永远不被破坏。
 */

import { describe, expect, test } from "bun:test";
import { upsertBlock, renderAgentsBlock } from "../src/repo.ts";

const START = "<!-- cos:rules:start -->";
const END = "<!-- cos:rules:end -->";
const BLOCK = renderAgentsBlock("demo");

/** 数 start 标记出现次数 —— 这是"是否重复追加"的唯一判据 */
function countStart(s: string): number {
  return s.split(START).length - 1;
}

describe("情况 3：没有块时追加", () => {
  test("空文件只得到块", () => {
    const out = upsertBlock("", BLOCK);
    expect(countStart(out)).toBe(1);
    expect(out.trim()).toBe(BLOCK.trim());
  });

  test("已有手写内容被完整保留", () => {
    const mine = "# 我的项目\n\n- 不要用 any\n";
    const out = upsertBlock(mine, BLOCK);
    expect(out).toContain("# 我的项目");
    expect(out).toContain("- 不要用 any");
    expect(countStart(out)).toBe(1);
  });

  test("原文件末尾无换行也能正确分隔", () => {
    const out = upsertBlock("内容没有结尾换行", BLOCK);
    expect(out).toContain("内容没有结尾换行");
    expect(out).toMatch(/内容没有结尾换行\n\n<!-- cos:rules:start -->/);
  });
});

describe("情况 1：完整块时替换", () => {
  test("块内内容被替换，块外不变", () => {
    const before = "# 项目\n\n手写头部\n\n";
    const after = "\n\n手写尾部\n";
    const existing = before + START + "\n旧的托管内容\n" + END + after;
    const out = upsertBlock(existing, BLOCK);
    expect(out).toContain("手写头部");
    expect(out).toContain("手写尾部");
    expect(out).not.toContain("旧的托管内容");
    expect(countStart(out)).toBe(1);
  });

  test("反复调用保持幂等", () => {
    let out = upsertBlock("# 项目\n", BLOCK);
    for (let i = 0; i < 5; i++) out = upsertBlock(out, BLOCK);
    expect(countStart(out)).toBe(1);
    expect(out.split(END).length - 1).toBe(1);
  });

  test("换块内容时旧内容消失", () => {
    let out = upsertBlock("", renderAgentsBlock("第一次"));
    out = upsertBlock(out, renderAgentsBlock("第二次"));
    expect(out).toContain("第二次");
    expect(out).not.toContain("第一次");
    expect(countStart(out)).toBe(1);
  });
});

describe("情况 2：块结构损坏时自愈", () => {
  test("end 标记被删 —— 不重复追加", () => {
    const broken = "# 项目\n\n" + START + "\n残缺内容没有结束标记\n";
    const out = upsertBlock(broken, BLOCK);
    expect(countStart(out)).toBe(1);
    expect(out).toContain("# 项目");
    expect(out).not.toContain("残缺内容");
  });

  test("end 在 start 之前（错序）—— 不重复追加", () => {
    const broken = END + "\n怪顺序\n" + START + "\n残缺\n";
    const out = upsertBlock(broken, BLOCK);
    expect(countStart(out)).toBe(1);
  });

  test("自愈后继续调用仍幂等", () => {
    let out = upsertBlock(START + "\n残缺\n", BLOCK);
    out = upsertBlock(out, BLOCK);
    out = upsertBlock(out, BLOCK);
    expect(countStart(out)).toBe(1);
  });

  test("损坏文件里 start 之前的内容保留", () => {
    const broken = "# 重要头部\n\n手写规则\n\n" + START + "\n残缺";
    const out = upsertBlock(broken, BLOCK);
    expect(out).toContain("# 重要头部");
    expect(out).toContain("手写规则");
  });
});

describe("块内容本身", () => {
  test("用目录树把文件归在 .codebase_store/ 下", () => {
    // 树形写法：目录名出现一次，文件名缩进列出。读者不会以为它们在仓库根。
    expect(BLOCK).toContain(".codebase_store/");
    expect(BLOCK).toMatch(/\.codebase_store\/\n├── cos\.txt/);
    expect(BLOCK).toContain("├── cos.meta.txt");
    expect(BLOCK).toContain("├── cos.code.txt");
  });

  test("手改指引用完整路径，不产生歧义", () => {
    expect(BLOCK).toContain("`.codebase_store/cos.code.txt`");
  });

  test("含数据目录说明与手改禁令", () => {
    expect(BLOCK).toContain(".codebase_store/");
    expect(BLOCK).toContain("cos_maintain");
    expect(BLOCK).toContain("不要手改");
  });
});
