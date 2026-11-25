/**
 * core.ts — 类型、机器常量、通用工具
 *
 * 设计原则（移植自 AOCI-CODE）：
 *   所有"魔法数字"只活在这里，别处不得硬编码。
 *   配额权威在代码里，不在索引文本里 —— 项目改自己的 Meta 也放宽不了上限。
 *
 * 运行时无关：只用 node:* 标准 API，不依赖 Bun 专有能力。
 * 这样同一份源码既能被 bunx 直跑（TS），也能编译成 JS 给 npx 用。
 */

import { createHash } from "node:crypto";

// ────────────────────────────────────────────────────────────
// 机器常量（machine contract）
// ────────────────────────────────────────────────────────────

export const ROOT_MARKER = "#COS-ROOT-MANIFEST: 1";
export const META_MARKER = "#COS-META-VOLUME: 1";
export const CODE_MARKER = "#COS-CODE-VOLUME: 1";

export const FORMAT_VERSION = "cognition-volumes/v1";
export const OBJECT_PROTOCOL = "cognition-object/v1";

/**
 * 所有数据集中存放在项目目录下的这个目录里，不在仓库根散落文件。
 *
 *   <project>/.codebase_store/
 *   ├── cos.txt          Root
 *   ├── cos.meta.txt     Meta
 *   ├── cos.code.txt     Code Volume
 *   ├── config.json      团队策略 / scope 规则 / 分块预算
 *   └── baseline.json    源码与 Entry 的指纹基线
 *
 * 下面这些常量都是**仓库相对路径**（含目录前缀），所以 `join(root, INDEX_PATH)`
 * 和 scope 比较可以直接用。
 */
export const DATA_DIR = ".codebase_store";

export const INDEX_PATH = `${DATA_DIR}/cos.txt`;
export const META_PATH = `${DATA_DIR}/cos.meta.txt`;
export const CODE_PATH = `${DATA_DIR}/cos.code.txt`;
export const CONFIG_PATH = `${DATA_DIR}/config.json`;
export const BASELINE_PATH = `${DATA_DIR}/baseline.json`;

/** Volume 声明里的路径：相对 Root 所在目录 */
export const META_BASENAME = "cos.meta.txt";
export const CODE_BASENAME = "cos.code.txt";

export const RULES_BLOCK_ID = "cos-rules";

/** 单条 Entry 字段长度上限（字符）。按 C 重要度分档：c9-8 / c7-4 / c3-1 */
export const FIELD_QUOTA: Record<"high" | "mid" | "low", { f: number; r: number; a: number; s: number }> = {
  high: { f: 300, r: 240, a: 200, s: 600 },
  mid: { f: 200, r: 160, a: 140, s: 200 },
  low: { f: 120, r: 100, a: 90, s: 50 },
};

/** Whole-Index 预算（token） */
export const WHOLE_INDEX_BUDGET = { target: 120_000, warning: 180_000, max: 240_000 };

/** overview 分块大小（token） */
export const CHUNK_TOKENS_DEFAULT = 7_000;
export const CHUNK_TOKENS_MIN = 4_000;
export const CHUNK_TOKENS_MAX = 24_000;

/** 单帧 JSON-RPC 上限 16 MiB */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** 默认排除目录 */
export const DEFAULT_EXCLUDE_DIRS = [
  "node_modules", "vendor", "dist", "build", "target", ".next", "coverage",
  "tmp", "uploads", "backup", "backups", "artifacts", ".output", "__pycache__",
  ".venv", "venv", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox",
  "htmlcov", ".git", DATA_DIR,
];

/** 被挡在 index 角色之外的源文件（空/二进制/超限） */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

// ────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────

export type Role = "index" | "observe" | "exclude";

export interface ScopeRule {
  action: Role;
  pattern: string;
  reason: string;
}

export interface Config {
  version: number;
  locale: string;
  indexPath: string;
  excludeDirs: string[];
  chunkTokens: number;
  refreshThreshold: number;
  scopeRules: ScopeRule[];
}

export interface Entry {
  /** 仓库相对路径，如 internal/fs/atomic.go */
  path: string;
  /** 紧凑标签 A+B+C+[D]+E，如 CG9L */
  tag: string;
  f: string;
  r: string;
  a: string;
  s: string;
}

export interface Tag {
  a: string;
  b: string;
  c: number;
  d: string;
  e: string;
  raw: string;
}

export interface Baseline {
  version: number;
  /** path -> sha256 */
  files: Record<string, string>;
  /** path -> sha256 of the Entry line (决定 Entry 是否被改过) */
  entries: Record<string, string>;
  /** path -> 对象来源标记 */
  source: Record<string, "indexed" | "observed">;
  updatedAt: string;
}

export type Drift =
  | { kind: "missing"; path: string }
  | { kind: "orphan"; path: string }
  | { kind: "stale"; path: string }
  | { kind: "unbaselined"; path: string };

export type Alignment =
  | "aligned"
  | "authoring_required"
  | "unbaselined"
  | "budget_exceeded";

export interface QuotaViolation {
  path: string;
  field: string;
  actual: number;
  limit: number;
}

export interface Facts {
  drift: Drift[];
  alignment: Alignment;
  entries: number;
  files: number;
  tokens: number;
  quotaViolations: QuotaViolation[];
  /** index 角色、可索引、但还没有 Entry 的对象 —— 「待创作」 */
  needAuthoring: string[];
  /** 有 Entry 但对象已不该被索引 / 文件已不存在 —— 「待删除」 */
  needRemoval: string[];
}

export interface OverviewChunk {
  cursor: string;
  nextCursor: string | null;
  chunkIndex: number;
  chunkTotal: number;
  content: string;
  tokens: number;
}

// ────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────

export function sha256(data: string | Uint8Array): string {
  // 用 node:crypto 而非 Bun.CryptoHasher —— Deno/Bun/Node 都支持，
  // 这样同一份源码既能被 bunx 直跑，也能被 tsc/esbuild 编译给 npx。
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 粗略 token 估算：CJK 约 1 字 = 1 token，ASCII 约 4 字符 = 1 token。
 * 不引 tokenizer 依赖 —— 预算只需要稳定且偏保守。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f) ||
        (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x3400 && cp <= 0x4dbf)) {
      cjk++;
    } else {
      other++;
    }
  }
  return cjk + Math.ceil(other / 4);
}

export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** 按 UTF-8 字节安全切分文本（不破坏多字节字符） */
export function splitByBytes(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (curBytes + b > maxBytes && cur.length > 0) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class CosError extends Error {
  constructor(message: string, readonly code = "cos_error") {
    super(message);
    this.name = "CosError";
  }
}
