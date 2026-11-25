/**
 * version.ts — 版本号的唯一来源
 *
 * 事故隐患：cli.ts、mcp.ts、package.json 各写一份 "0.1.0"。
 * 发布时漏改任何一处，`cos --version` 和 MCP 握手里的 serverInfo.version
 * 就会给出与实际安装版本不符的值 —— 而且没有任何报错，只有用户会困惑。
 *
 * 做法：直接读 package.json。它是 npm 发布时的权威版本来源，不必再维护第二份。
 * 两条运行时路径都成立：
 *   · bun run src/cli.ts   → 源码目录里的 ../package.json
 *   · bin/cos.mjs (node)   → 同一个包根下的 package.json
 * 构建脚本把 src/ 输出到 bin/，两者相对 package.json 的位置一致（..）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 从当前文件所在目录向上找最近的 package.json，取其 version。
 * 找不到就返回 "unknown" —— 宁可显示未知，也不要编一个假的版本号。
 */
function readVersion(): string {
  // import.meta.dir 在 Bun 里可用；ESM 标准路径在 node 里是 fileURLToPath(import.meta.url)。
  // 两者都算一遍，保证同一份源码在 bun / node 下都正确。
  const candidates: string[] = [];
  const bunDir = (import.meta as { dir?: string }).dir;
  if (typeof bunDir === "string" && bunDir) candidates.push(bunDir);
  try {
    candidates.push(dirname(fileURLToPath(import.meta.url)));
  } catch { /* 某些打包环境没有 import.meta.url，忽略 */ }

  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
        if (typeof pkg.version === "string" && pkg.version) return pkg.version;
      } catch { /* 这个目录没有可读的 package.json，继续向上 */ }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return "unknown";
}

export const VERSION = readVersion();
