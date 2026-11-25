/**
 * mcp.ts — MCP server，基于官方 @modelcontextprotocol/sdk
 *
 * 不手写 JSON-RPC / 帧解析 / 生命周期协商：这些都交给 SDK。
 * 我们只负责：注册工具、每次调用解析仓库、把错误转成可读提示。
 *
 * 关键设计：
 *   · 启动绝不因「仓库没定位到」而退出 —— 宿主会在任意 cwd 启动我们，
 *     启动即退出会表现为「MCP 连接失败」，用户看不到真正原因。
 *   · 定位问题延后到具体工具调用时以 isError 返回，附可照做的修复步骤。
 *   · cos_rules 不依赖仓库，保证即使定位失败，Agent 也能读到使用方法。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import { CosError } from "./core.ts";

export interface ToolContext {
  /** 本次调用生效的仓库根 */
  root: string;
  /** 显式 --repo 传入的固定仓库；为 null 表示每次调用按 cwd 重新解析 */
  fixedRoot: string | null;
}

export interface ToolDef {
  name: string;
  description: string;
  /** zod raw shape，SDK 负责转 JSON Schema 并做入参校验 */
  inputSchema: ZodRawShape;
  /**
   * 是否需要仓库上下文。
   * cos_rules 只是返回静态会话合同，不碰仓库 —— 设为 false，
   * 这样即使宿主 cwd 不对，Agent 也能读到「怎么用、怎么修」。
   */
  needsRepo?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown> | unknown;
}

/** 每次调用重新解析仓库，让一份配置服务多个项目 */
export type RootResolver = () => string;

const SERVER_INFO = { name: "cos", version: "0.1.0" };

function log(...args: unknown[]): void {
  // stdout 归 SDK 用于 JSON-RPC，日志只能走 stderr
  process.stderr.write(`[cos] ${args.join(" ")}\n`);
}

/** 未定位到仓库时的可照做指引 */
function notInitializedHint(problem: string): string {
  return [
    `not_initialized: ${problem}`,
    ``,
    `这条错误说明 MCP server 已正常连接，只是找不到要操作的仓库。常见原因：`,
    `  1. 项目还没初始化 → 在项目根目录运行 cos init`,
    `  2. 宿主启动 server 时 cwd 不在项目内 → 在 MCP 配置里加 "--repo", "<绝对路径>"`,
    `  3. 换项目后没重启 Agent → 重启当前会话`,
    `可以先调 cos_rules 看完整使用方法。`,
  ].join("\n");
}

export async function runMcpServer(
  resolveRoot: RootResolver,
  tools: ToolDef[],
  fixedRoot: string | null = null,
): Promise<void> {
  // 探测一次仅用于打日志，失败不阻断启动
  let initialInfo: string;
  try {
    initialInfo = resolveRoot();
  } catch (err) {
    initialInfo = `未定位到仓库（${(err as CosError).message.split("\n")[0]}）`;
  }

  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (rawArgs: unknown): Promise<CallToolResult> => {
        // 1. 解析仓库
        let root = "";
        let problem: string | null = null;
        if (tool.needsRepo !== false) {
          try {
            root = resolveRoot();
          } catch (err) {
            problem = (err as CosError).message;
          }
        }

        // 2. 需要仓库却没定位到 → 返回指引而非抛错（抛错会变成裸栈信息）
        if (problem !== null) {
          return {
            isError: true,
            content: [{ type: "text", text: notInitializedHint(problem) }],
          };
        }

        // 3. 执行
        try {
          const out = await tool.handler(
            (rawArgs as Record<string, unknown>) ?? {},
            { root, fixedRoot },
          );
          return {
            content: [{
              type: "text",
              text: typeof out === "string" ? out : JSON.stringify(out, null, 2),
            }],
          };
        } catch (err) {
          const e = err as CosError;
          // 业务错误转成可读文本让模型自我修正；SDK 也支持抛错，但文本更可控
          return {
            isError: true,
            content: [{ type: "text", text: `${e.code ?? "error"}: ${e.message}` }],
          };
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(
    (fixedRoot
      ? `stdio server ready, repo=${initialInfo} (固定 --repo)`
      : `stdio server ready, repo=${initialInfo} (每次调用重新解析)`) +
    `, tools=${tools.length}`,
  );
}
