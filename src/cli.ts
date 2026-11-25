#!/usr/bin/env bun
/**
 * cli.ts — 命令分发入口
 *
 * 6 个命令：init / scan / verify / check / status / mcp
 * 加上 --help / --version
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { CosError, DATA_DIR, INDEX_PATH } from "./core.ts";
import { VERSION as COS_VERSION } from "./version.ts";
import { findRepoRoot, findInitializedRoot, isInitialized } from "./repo.ts";
import { cmdInit, cmdScan, cmdVerify, cmdCheck, cmdStatus } from "./commands.ts";
// 注意：mcp.ts / tools.ts 必须**懒加载**，不能在模块顶层 import。
//
// 静态 import @modelcontextprotocol/sdk 会让 Bun 在 CLI 退出路径上静默丢弃
// 尚未 flush 的 stdout —— `cos verify --json | jq` 只会拿到 64 KB 就断掉。
// 让 SDK 只在真正跑 mcp 时才被加载，才保得住管道输出完整性。
// （回归：verify --json | wc -c 必须等于重定向到文件的大小）

const VERSION = COS_VERSION;

const HELP = `cos ${VERSION} — 仓库认知索引 MCP

用法: cos <命令> [选项]

命令:
  init              初始化：写 Root/Meta/Code 模板 + 配置文件 + AGENTS.md 规则块
  scan              建立基线（按 git ignore 权威枚举文件）
  verify            报告漂移（missing / orphan / stale / unbaselined）
  check             治理门禁（配额 + 覆盖 + 对齐），非零退出可接 CI
  status            人看的摘要
  mcp               启动 stdio MCP Server

全局选项:
  --repo <path>     指定仓库根（默认按 cwd 向上查找 .codebase_store）
  --force           init 覆盖已有索引 / scan 重建基线
  --json            verify 和 check 输出 JSON
  -h, --help        显示帮助
  -v, --version     显示版本

仓库定位规则:
  除 init 外，所有命令都从当前目录向上逐层查找最近的 .codebase_store/。
  这样在子目录里跑命令也能命中项目索引，多个项目共存时互不干扰。
  MCP 模式不固定仓库时，每次工具调用都会重新解析 —— 宿主把 cwd 设在哪个
  项目，就作用于哪个项目，一份 MCP 配置可以服务多个项目。

典型流程:
  cos init
  cos scan
  # 在 Agent 里加 MCP 配置，重启
  # 对 Agent 说：「读 cos_rules，然后建立索引」
  cos verify && cos check
`;

interface Parsed {
  command: string;
  repo?: string;
  force: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { command: "", force: false, json: false, help: false, version: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--repo") { out.repo = argv[++i]; continue; }
    if (a.startsWith("--repo=")) { out.repo = a.slice(7); continue; }
    if (a === "--force") { out.force = true; continue; }
    if (a === "--json") { out.json = true; continue; }
    if (a === "-h" || a === "--help") { out.help = true; continue; }
    if (a === "-v" || a === "--version") { out.version = true; continue; }
    if (a.startsWith("-")) throw new CosError(`未知选项 ${a}`, "bad_flag");
    rest.push(a);
  }
  out.command = rest[0] ?? "";
  return out;
}

/**
 * 读取类操作（mcp / verify / check / status / scan）的仓库定位。
 *
 * 优先向上查找已初始化的 .codebase_store —— 这样在子目录里执行命令
 * 也能命中项目的认知索引，多个项目共存时互不干扰。
 *
 * 找不到时给一条能直接照做的指引，而不是抛"仓库不存在"让人猜。
 */
function resolveRepoForRead(start: string): string {
  const found = findInitializedRoot(start);
  if (found) return found;

  // 回退：如果当前目录本身像是个仓库但没 init，提示先 init
  const gitRoot = findRepoRoot(start);
  if (isInitialized(gitRoot)) return gitRoot;

  throw new CosError(
    `从 ${start} 向上没有找到已初始化的仓库（缺少 ${DATA_DIR}/${INDEX_PATH.replace(DATA_DIR + "/", "")}）。\n` +
    `  · 如果这是新项目：先在项目根目录运行 cos init\n` +
    `  · 如果项目在别处：用 --repo <path> 显式指定\n` +
    `  · 如果你以为已经初始化过：确认 ${DATA_DIR}/ 是否被移动或删除`,
    "not_initialized",
  );
}

async function main(): Promise<number> {
  let args: Parsed;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as CosError).message);
    return 2;
  }

  if (args.version) { console.log(`cos ${VERSION}`); return 0; }
  if (args.help || args.command === "" || args.command === "help") { console.log(HELP); return 0; }

  // ── mcp：仓库可以延迟到每次调用时解析 ──────────────────────────
  if (args.command === "mcp") {
    // 懒加载：只在这里才把 MCP SDK 拉进进程（见文件顶部注释）
    const [{ runMcpServer }, { TOOLS }] = await Promise.all([
      import("./mcp.ts"),
      import("./tools.ts"),
    ]);
    if (args.repo) {
      const fixed = resolve(args.repo);
      if (!existsSync(fixed)) {
        console.error(`仓库路径不存在：${fixed}`);
        return 2;
      }
      await runMcpServer(() => fixed, TOOLS, fixed);
    } else {
      // 不固定仓库：每次工具调用按 cwd 重新向上找 .codebase_store
      // 这样同一个 server 进程可以在多个项目之间切换
      await runMcpServer(() => resolveRepoForRead(process.cwd()), TOOLS, null);
    }
    // SDK 的 connect() 是立即返回的，不是阻塞调用。
    // 这里必须挂住进程，让 stdio 事件循环继续处理请求 ——
    // 否则 main() 返回后 process.exit 会立刻杀掉 server，
    // 宿主只看到「连接已关闭」。
    await new Promise<void>((resolveHold) => {
      const stop = () => resolveHold();
      process.stdin.once("end", stop);
      process.stdin.once("close", stop);
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
    return 0;
  }

  // ── 其余命令：启动时解析一次 ──────────────────────────────────
  let root: string;
  try {
    root = args.repo
      ? resolve(args.repo)
      : args.command === "init"
        ? findRepoRoot()          // init 尚无 .codebase_store，用 .git 定位
        : resolveRepoForRead(process.cwd());
  } catch (err) {
    console.error((err as CosError).message);
    return 2;
  }

  switch (args.command) {
    case "init":
      return cmdInit(root, { force: args.force });
    case "scan":
      return cmdScan(root, { force: args.force });
    case "verify":
      return cmdVerify(root, { json: args.json });
    case "check":
      return cmdCheck(root, { json: args.json });
    case "status":
      return cmdStatus(root);
    default:
      console.error(`未知命令 "${args.command}"。运行 cos --help 查看可用命令。`);
      return 2;
  }
}

// 用 exitCode 而不是 process.exit()：
// process.exit 会立刻杀进程，尚未 flush 的 stdout 直接丢弃（`| jq` 拿到半截 JSON）。
// 设 exitCode 让事件循环自然收尾，输出完整落地后再退出。
main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(err instanceof CosError ? err.message : err);
  process.exitCode = 2;
});
