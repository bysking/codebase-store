/**
 * stdout-pipe.test.ts — 管道输出完整性回归
 *
 * 事故：`cos verify --json | jq` 只拿到 65536 字节就断掉，JSON 解析失败。
 * 根因：cli.ts 在模块顶层静态 import 了 MCP SDK（mcp.ts / tools.ts）。
 * SDK 加载会往进程里注册东西，改变退出路径行为，使尚未 flush 的 stdout 被丢弃；
 * 再加上 `process.exit()` 不等 flush，输出就停在内核缓冲上限（64 KB）。
 *
 * 修法：① mcp.ts / tools.ts 改成在 mcp 分支里懒加载；② process.exit → process.exitCode。
 *
 * ⚠️ 测试必须走**真实 shell 管道**才能复现。
 * Bun.spawnSync({stdout:"pipe"}) 会把子进程跑完再读全部字节，看不到这个 bug
 * （我第一版就是这么写的，回退代码后测试照样全绿 —— 等于假测试）。
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo } from "../src/repo.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");
const DIST = join(ROOT, "bin", "cos.mjs");

let bigRepo: string;

beforeAll(() => {
  bigRepo = mkdtempSync(join(tmpdir(), "cos-pipe-"));
  // 3000 个未创作 Entry 的文件 → verify --json 输出约 200 KB（远超 64 KB 缓冲）
  for (let i = 0; i < 3000; i++) {
    const d = join(bigRepo, `d${i % 20}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `f${i}.ts`), "export const x = 1;\n");
  }
  initRepo(bigRepo, false);
});

afterAll(() => {
  rmSync(bigRepo, { recursive: true, force: true });
});

/**
 * 通过 bash 走真实管道。
 * `| cat` 让下游立刻消费，与 `| jq` / `| wc` 的失败模式一致。
 */
function runThroughShellPipe(argv: string[]): { bytes: number; exitCode: number } {
  const quoted = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const script = `${quoted} 2>/dev/null | cat | wc -c`;
  const res = Bun.spawnSync(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
  return { bytes: Number(res.stdout.toString().trim()), exitCode: res.exitCode ?? 0 };
}

/** 同一命令重定向到文件：不受 flush 影响，作为"完整输出"基准 */
function runRedirected(argv: string[]): number {
  const outfile = join(tmpdir(), `cos-pipe-ref-${process.pid}-${Date.now()}.json`);
  try {
    const quoted = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    Bun.spawnSync(["bash", "-c", `${quoted} > '${outfile}' 2>/dev/null`], { stdout: "pipe" });
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(outfile).byteLength;
  } finally {
    rmSync(outfile, { force: true });
  }
}

describe("cos verify --json 走 shell 管道时输出完整", () => {
  test("输出确实超过 64 KB（保证这个测试有意义）", () => {
    const ref = runRedirected(["bun", "run", CLI, "verify", "--repo", bigRepo, "--json"]);
    expect(ref).toBeGreaterThan(64 * 1024);
  });

  test("shell 管道拿到的字节数等于重定向到文件的字节数", () => {
    const piped = runThroughShellPipe(["bun", "run", CLI, "verify", "--repo", bigRepo, "--json"]);
    const ref = runRedirected(["bun", "run", CLI, "verify", "--repo", bigRepo, "--json"]);
    // 旧实现: piped = 65536, ref = 211110 → 立刻红
    expect(piped.bytes).toBe(ref);
  });

  test("管道输出可以被 JSON 解析（jq/CI 的真实用法）", () => {
    const quoted = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
    const cmd = ["bun", "run", CLI, "verify", "--repo", bigRepo, "--json"].map(quoted).join(" ");
    const res = Bun.spawnSync(["bash", "-c", `${cmd} 2>/dev/null | cat`], {
      stdout: "pipe", stderr: "pipe",
    });
    const text = res.stdout.toString("utf8");
    let parsed: { drift: unknown[] };
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `管道输出被截断（${text.length} 字符）：${(err as Error).message}\n` +
        `末 40 字符: ${JSON.stringify(text.slice(-40))}`,
      );
    }
    expect(parsed.drift.length).toBeGreaterThanOrEqual(3000);
  });

  test("退出码仍然正确：有 drift 时非零", () => {
    const quoted = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
    const cmd = ["bun", "run", CLI, "verify", "--repo", bigRepo, "--json"].map(quoted).join(" ");
    // 用 PIPESTATUS[0] 取上游退出码，而不是 wc 的退出码
    const res = Bun.spawnSync(["bash", "-c",
      `${cmd} 2>/dev/null | cat > /dev/null; exit \${PIPESTATUS[0]}`], { stdout: "pipe" });
    expect(res.exitCode).toBe(1);
  });

  test("预编译产物 bin/cos.mjs 走 shell 管道同样完整（node 运行时）", () => {
    if (!existsSync(DIST)) return; // 产物缺失由 dist-freshness 测试负责报错
    const piped = runThroughShellPipe(["node", DIST, "verify", "--repo", bigRepo, "--json"]);
    const ref = runRedirected(["node", DIST, "verify", "--repo", bigRepo, "--json"]);
    expect(piped.bytes).toBe(ref);
  });
});
