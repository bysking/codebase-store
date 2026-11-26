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

/**
 * 单条 Entry 字段长度上限（字符）。按 C 重要度分档：c9-8 / c7-4 / c3-1。
 *
 * 为什么是这个量级：S 字段常常要装一条"删了会出事的"约束细节（如"必须保留原始文件"、
 * "MySQL 5.7 不支持 MariaDB"），600 字符时作者被迫压缩成语义模糊的半句，反而丢失
 * 了本该防止错误的信息。实测 70 万行规模仓库的索引仍在 240k token 硬上限内（
 * WHOLE_INDEX_BUDGET），所以放宽单条上限不会把整体预算撑爆 —— 单条写得再长，
 * 条数才是预算的主导项。
 */
export const FIELD_QUOTA: Record<"high" | "mid" | "low", { f: number; r: number; a: number; s: number }> = {
  high: { f: 450, r: 400, a: 320, s: 1200 },
  mid: { f: 300, r: 250, a: 210, s: 400 },
  low: { f: 180, r: 150, a: 120, s: 120 },
};

/** Whole-Index 预算（token） */
export const WHOLE_INDEX_BUDGET = { target: 120_000, warning: 180_000, max: 240_000 };

/** overview 分块大小（token） */
export const CHUNK_TOKENS_DEFAULT = 7_000;
export const CHUNK_TOKENS_MIN = 4_000;
export const CHUNK_TOKENS_MAX = 24_000;

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
  excludeDirs: string[];
  chunkTokens: number;
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

/**
 * 单个文件的指纹。
 *
 * 为什么除了 sha 还要记 size+mtime：collectFacts 每次都要判断所有受管文件是否
 * 变过。只存 sha 的话，唯一办法是把每个文件整读一遍再算哈希 —— 实测 1500 文件
 * / 117 MB 的仓库，一次 status 要 372ms，而 cos_overview 读多个 chunk 时
 * 每块都重算一遍。
 *
 * 加上 size+mtime 后可以先 stat 比对：绝大多数文件没变，一条 stat 就够了。
 * 这不是为了"绝对正确"（mtime 精度可能骗人），而是为了把开销压在常态路径上 ——
 * 一旦 size/mtime 有差异，仍然回落到 sha 比对，结论不会变错。
 */
export interface FileStamp {
  sha: string;
  size: number;
  mtimeMs: number;
}

export interface Baseline {
  version: number;
  /** path -> 指纹（sha + size + mtime） */
  stamps: Record<string, FileStamp>;
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
  | { kind: "unbaselined"; path: string }
  /** Code Volume 里有解析不了的行（手改坏了格式）。此时任何写入都会丢数据。 */
  | { kind: "malformed"; path: string };

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
  /**
   * baseline.files 是否非空。
   *
   * 这是「基线存在」与「还没有 Entry」两件事的分界：alignment 的 unbaselined
   * 只在 hasBaseline=false 时成立。旧实现把它们混成一个状态，导致刚 init+scan
   * 完的项目被报成 unbaselined（用户去重跑 scan 只会被告知基线已存在）。
   */
  hasBaseline: boolean;
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
