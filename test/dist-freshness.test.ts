/**
 * dist-freshness.test.ts — 保证提交的 bin/cos.mjs 与 src/ 同步
 *
 * 为什么要这个测试：
 *   bin/cos.mjs 是构建产物但需要提交进 Git（否则 git 依赖 / npm link 装不上）。
 *   提交产物最大的风险是「改了 src 忘了重建」——用户装到的还是旧逻辑，
 *   而且没有任何报错。
 *
 * 这里的做法：把 src/ 重新构建一份到临时目录，与 bin/cos.mjs 逐字节比对。
 * 不一致就 fail，并告诉你怎么修。
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "bin", "cos.mjs");
const SRC = join(ROOT, "src");

/** 递归取 src/**\/*.ts 的 (相对路径, mtimeMs, size) */
function srcFingerprint(): string {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, prefix ? `${prefix}/${name}` : name);
      else out.push(`${prefix}/${name}:${st.size}`);
    }
  };
  walk(SRC, "");
  return out.join("|");
}

describe("bin/cos.mjs 与源码同步", () => {
  test("产物存在", () => {
    expect(existsSync(BIN)).toBe(true);
  });

  test("产物有 node shebang 且没有 bun 残留", () => {
    const head = readFileSync(BIN, "utf8").split("\n").slice(0, 5).join("\n");
    expect(head.startsWith("#!/usr/bin/env node")).toBe(true);
    // bun build 会带出源文件 shebang 和 // @bun 标记，构建脚本必须清掉
    expect(head).not.toContain("/usr/bin/env bun");
    expect(head).not.toContain("// @bun");
  });

  test("重新构建的结果与提交的产物一致", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cos-dist-"));
    try {
      const outfile = join(tmp, "cos.mjs");
      const res = Bun.spawnSync([
        "bun", "build", join(SRC, "cli.ts"),
        "--target=node", "--format=esm", "--packages=external",
        `--outfile=${outfile}`,
      ], { stdout: "pipe", stderr: "pipe" });
      if (res.exitCode !== 0) {
        throw new Error(`构建失败：${res.stderr.toString()}`);
      }

      // 复用与 scripts/build-npm.ts 相同的清理逻辑
      const raw = readFileSync(outfile, "utf8");
      const lines = raw.split("\n");
      let i = 0;
      while (i < lines.length && (lines[i]!.startsWith("#!") || lines[i]!.trim() === "// @bun")) i++;
      const cleaned = "#!/usr/bin/env node\n" + lines.slice(i).join("\n");

      const committed = readFileSync(BIN, "utf8");
      if (committed !== cleaned) {
        throw new Error(
          "bin/cos.mjs 与源码不同步。\n" +
          "运行 `bun run build:npm` 重新生成后再提交。\n" +
          `（产物 ${committed.length} 字节，重建后 ${cleaned.length} 字节）`
        );
      }
      expect(cleaned).toBe(committed);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("package.json 与产物一致", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  test("bin 指向 bin/cos.mjs（npx 入口）", () => {
    expect(pkg.bin.cos).toBe("./bin/cos.mjs");
  });

  test("files 包含 bin/，否则发布时产物会被漏掉", () => {
    expect(pkg.files).toContain("bin/");
    expect(pkg.files).toContain("src/");
  });

  test("prepack 会重建产物", () => {
    expect(pkg.scripts.prepack).toContain("build:npm");
  });

  test("engines 同时声明 node 和 bun", () => {
    expect(pkg.engines.node).toBeDefined();
    expect(pkg.engines.bun).toBeDefined();
  });

  test("publishConfig 是 public（scoped 包默认 private）", () => {
    expect(pkg.publishConfig.access).toBe("public");
  });
});