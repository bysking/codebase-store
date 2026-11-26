/**
 * format.test.ts — 格式层单元测试
 */

import { describe, expect, test } from "bun:test";
import {
  parseTag, parseEntryLine, renderEntryLine, parseSectionHeader,
  renderSectionHeader, parseCodeVolume, renderCodeVolume, validateEntry,
  validateRelations, roundTripCheck, renderMeta,
} from "../src/format.ts";
import { estimateTokens, splitByBytes, FIELD_QUOTA } from "../src/core.ts";

describe("parseTag", () => {
  test("解析无 D 维度的紧凑标签", () => {
    expect(parseTag("CG9L")).toEqual({ a: "C", b: "G", c: 9, d: "", e: "L", raw: "CG9L" });
  });
  test("解析带 D 维度的标签", () => {
    expect(parseTag("EG9DL")).toEqual({ a: "E", b: "G", c: 9, d: "D", e: "L", raw: "EG9DL" });
  });
  test("拒绝 C 位为 0", () => {
    expect(() => parseTag("CG0L")).toThrow("非法标签");
  });
  test("拒绝缺少 E 轴", () => {
    expect(() => parseTag("CG9")).toThrow("非法标签");
  });
});

describe("parseSectionHeader", () => {
  test("中性根解析为仓库根", () => {
    expect(parseSectionHeader("===/<repository>/===")).toBe("");
  });
  test("中性根下的子目录", () => {
    expect(parseSectionHeader("===/<repository>/internal/fs/===")).toBe("internal/fs");
  });
  test("历史绝对根失败关闭而不是猜", () => {
    expect(() => parseSectionHeader("===/Users/alice/proj/src/===")).toThrow("无法安全重定位");
  });
  test("render 与 parse 互逆", () => {
    expect(parseSectionHeader(renderSectionHeader("src/a"))).toBe("src/a");
    expect(parseSectionHeader(renderSectionHeader(""))).toBe("");
  });
});

describe("Entry 解析与渲染", () => {
  const line = `atomic.go[CG9L]: F:提供持久化替换 CAS | R:code:internal/fs/lock.go | A:AtomicWrite | S:原生发布绝不降级为覆盖式重命名`;

  test("解析出完整字段", () => {
    const e = parseEntryLine(line, "internal/fs")!;
    expect(e.path).toBe("internal/fs/atomic.go");
    expect(e.tag).toBe("CG9L");
    expect(e.f).toBe("提供持久化替换 CAS");
    expect(e.r).toBe("code:internal/fs/lock.go");
    expect(e.a).toBe("AtomicWrite");
    expect(e.s).toContain("绝不降级");
  });

  test("渲染后能读回", () => {
    const e = parseEntryLine(line, "internal/fs")!;
    const back = parseEntryLine(renderEntryLine(e), "internal/fs")!;
    expect(back).toEqual(e);
  });

  test("注释行不当作 Entry", () => {
    expect(parseEntryLine("# 这是注释", "")).toBeNull();
  });

  test("文件名含 [ 时仍能解析", () => {
    const e = parseEntryLine(`[...id].jsx[EU7S]: F:动态路由页面 | R:- | A:- | S:-`, "pages")!;
    expect(e.path).toBe("pages/[...id].jsx");
    expect(e.tag).toBe("EU7S");
  });
});

describe("Volume 解析/渲染", () => {
  test("多目录往返一致", () => {
    const text = renderCodeVolume([
      { path: "a.ts", tag: "CG5T", f: "F1", r: "-", a: "A1", s: "S1" },
      { path: "src/b.ts", tag: "CK7M", f: "F2", r: "code:a.ts", a: "A2", s: "S2" },
    ]);
    const doc = parseCodeVolume(text);
    expect(doc.entries).toHaveLength(2);
    expect(doc.entries.map((e) => e.path).sort()).toEqual(["a.ts", "src/b.ts"]);
    expect(doc.order).toContain("src");
  });
});

describe("配额校验", () => {
  /*
   * 用例跟着 FIELD_QUOTA 走，而不是写死数字：配额是会被调整的机器合同，
   * 写死 600/50 的用例在每次调整时都要改一遍，而且改的时候很容易把
   * "上限 +1 被拒"这条真正的边界漏掉。
   */
  test("C9 的 S 恰好等于上限时通过", () => {
    const lim = FIELD_QUOTA.high.s;
    const e = { path: "x.ts", tag: "CG9T", f: "f", r: "-", a: "a", s: "s".repeat(lim) };
    expect(validateEntry(e)).toHaveLength(0);
  });
  test("C9 的 S 超过上限 1 字符被拒", () => {
    const e = { path: "x.ts", tag: "CG9T", f: "f", r: "-", a: "a", s: "s".repeat(FIELD_QUOTA.high.s + 1) };
    expect(validateEntry(e)).toHaveLength(1);
  });
  test("C3 用 low 档，S 超过上限被拒", () => {
    const lim = FIELD_QUOTA.low.s;
    const e = { path: "x.ts", tag: "CG3T", f: "f", r: "-", a: "a", s: "s".repeat(lim + 1) };
    const v = validateEntry(e);
    expect(v[0]!.field).toBe("s");
    expect(v[0]!.limit).toBe(lim);
  });
  test("三档配额随 C 重要度单调放宽", () => {
    for (const f of ["f", "r", "a", "s"] as const) {
      expect(FIELD_QUOTA.high[f]).toBeGreaterThan(FIELD_QUOTA.mid[f]);
      expect(FIELD_QUOTA.mid[f]).toBeGreaterThan(FIELD_QUOTA.low[f]);
    }
  });
});

describe("R 引用校验", () => {
  test("合法形式通过", () => {
    expect(validateRelations("code:a.ts,code:b.ts")).toHaveLength(0);
    expect(validateRelations("database://primary/public/orders")).toHaveLength(0);
    expect(validateRelations("-")).toHaveLength(0);
  });
  test("裸文件名被拒（不是写别名）", () => {
    expect(validateRelations("someRandomName").length).toBeGreaterThan(0);
  });
});

describe("Meta 渲染", () => {
  /*
   * Meta 的配额行是给人和模型看的说明，不是权威值。它一旦和 FIELD_QUOTA
   * 漂移，读者就会照着错的额度压缩内容 —— 要么白白丢信息，要么反复被拒
   * 却查不出原因。所以这里断言它是常量的投影，而非一份独立文本。
   */
  test("#S quota 行与 FIELD_QUOTA 一致", () => {
    const meta = renderMeta();
    const line = meta.split("\n").find((l) => l.startsWith("#S quota:"))!;
    expect(line).toBe(
      `#S quota: C9-8≤${FIELD_QUOTA.high.s} C7-4≤${FIELD_QUOTA.mid.s} C3-1≤${FIELD_QUOTA.low.s}`,
    );
  });
  test("#FRAS-Limits-Authority 仍声明配额归机器", () => {
    expect(renderMeta()).toContain("#FRAS-Limits-Authority: machine-contract");
  });
});

describe("回读校验", () => {
  test("正常 Entry 通过", () => {
    expect(() => roundTripCheck([
      { path: "a.ts", tag: "CG5T", f: "f", r: "-", a: "a", s: "s" },
    ])).not.toThrow();
  });
});

describe("token 估算", () => {
  test("中文按字计", () => {
    expect(estimateTokens("中文四个")).toBe(4);
  });
  test("ASCII 按 4 字符 1 token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("字节安全切分", () => {
  test("不破坏多字节字符", () => {
    const parts = splitByBytes("中文中文中文", 6);
    expect(parts.join("")).toBe("中文中文中文");
    for (const p of parts) expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(6);
  });
});
