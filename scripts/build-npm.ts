/**
 * scripts/build-npm.ts — 产出 npx 用的预编译入口
 *
 * 双入口策略：
 *   · bunx  → 直接跑 src/cli.ts（TS 原生，无需构建）
 *   · npx   → 跑 bin/cos.mjs（预编译 JS，依赖 Node ≥ 18）
 *
 * 用 --packages=external 而非全量打包：
 * 依赖已在 package.json 的 dependencies 里，安装时会被带上。
 * 全量内联会让产物从 60KB 涨到 1.2MB，没必要。
 */

const result = await Bun.build({
  entrypoints: ["./src/cli.ts"],
  outdir: "./bin",
  naming: "cos.mjs",
  target: "node",
  format: "esm",
  minify: false,
  packages: "external",
});

if (!result.success) {
  console.error("构建失败：");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const { chmodSync, statSync, readFileSync, writeFileSync } = await import("node:fs");

/*
 * Bun 会把源文件 cli.ts 的 shebang 原样带进产物，再自己加一行 // @bun，
 * 结果产物开头是多行 shebang 堆叠。node 只会认第一行，所以必须清理：
 * 丢掉所有 `#!` 行和 `// @bun` 标记，然后写我们自己的 node shebang。
 */
const raw = readFileSync("./bin/cos.mjs", "utf8");
const lines = raw.split("\n");
let i = 0;
while (i < lines.length && (lines[i]!.startsWith("#!") || lines[i]!.trim() === "// @bun")) i++;
const cleaned = "#!/usr/bin/env node\n" + lines.slice(i).join("\n");
writeFileSync("./bin/cos.mjs", cleaned);

// 补可执行权限（npm 会保留 bin 脚本的执行位）
chmodSync("./bin/cos.mjs", 0o755);

const size = statSync("./bin/cos.mjs").size;
console.log(`✓ bin/cos.mjs  ${(size / 1024).toFixed(1)} KB`);
