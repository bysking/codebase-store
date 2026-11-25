/**
 * format.ts — 索引格式解析 / 渲染 / 校验
 *
 * 对应 AOCI-CODE 的 internal/index 包（15 文件）压缩成一个文件。
 * 保留：目录段、Entry 语法、FRAS、标签解析、配额校验、历史根重定位。
 */

import {
  CODE_MARKER, META_MARKER, ROOT_MARKER, FORMAT_VERSION, OBJECT_PROTOCOL,
  FIELD_QUOTA, META_BASENAME, CODE_BASENAME, CosError,
  type Entry, type Tag, type QuotaViolation,
} from "./core.ts";

// ────────────────────────────────────────────────────────────
// 标签
// ────────────────────────────────────────────────────────────

/** 解析紧凑标签 A+B+C+[D]+E，如 CG9L / CG7T / EG9D3L */
export function parseTag(raw: string): Tag {
  const m = /^([A-Z])([A-Z])([1-9])(?:([A-Z]))?([LMST])$/.exec(raw.trim());
  if (!m) throw new CosError(`非法标签 "${raw}"，期望 A+B+C+[D]+E（如 CG9L）`, "bad_tag");
  const [, a, b, c, d, e] = m;
  return { a: a!, b: b!, c: Number(c), d: d ?? "", e: e!, raw: raw.trim() };
}

/** C 重要度 → 配额档位 */
export function quotaBand(c: number): "high" | "mid" | "low" {
  if (c >= 8) return "high";
  if (c >= 5) return "mid";
  return "low";
}

// ────────────────────────────────────────────────────────────
// Entry 行
// ────────────────────────────────────────────────────────────

const ENTRY_RE = /^(.+?)\[([A-Z][A-Z][1-9](?:[A-Z])?[LMST])\]:\s*F:(.*?)\s*\|\s*R:(.*?)\s*\|\s*A:(.*?)\s*\|\s*S:(.*)$/;

export function parseEntryLine(line: string, dirPath: string): Entry | null {
  // 注释行：# 开头且不具备 Entry 形状
  if (line.startsWith("#") && !ENTRY_RE.test(line)) return null;
  const m = ENTRY_RE.exec(line.trimEnd());
  if (!m) return null;
  const [, name, tag, f, r, a, s] = m;
  const base = name!.trim();
  const path = dirPath ? `${dirPath}/${base}` : base;
  return { path, tag: tag!, f: f!.trim(), r: r!.trim(), a: a!.trim(), s: s!.trim() };
}

export function renderEntryLine(e: Entry): string {
  return `${basename(e.path)}[${e.tag}]: F:${e.f} | R:${e.r} | A:${e.a} | S:${e.s}`;
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

// ────────────────────────────────────────────────────────────
// 目录段头
// ────────────────────────────────────────────────────────────

/**
 * 解析 `===/<repository>/internal/fs/===` → `internal/fs`
 * 中性根 `/<repository>` 会被剥离；历史绝对根也会被剥离（失败关闭优先）。
 */
export function parseSectionHeader(line: string): string | null {
  const m = /^===\s*(?:[^=]*?)\s*(\/\S*?)\s*===\s*$/.exec(line);
  if (!m) return null;
  const full = m[1]!;
  const NEUTRAL = "/<repository>";
  if (full === NEUTRAL || full === `${NEUTRAL}/`) return "";
  if (full.startsWith(`${NEUTRAL}/`)) return full.slice(NEUTRAL.length + 1).replace(/\/$/, "");
  // 历史绝对路径：取最后一个可识别锚点之后的部分。无法安全解析 → 失败关闭。
  throw new CosError(
    `目录段根 "${full}" 不是中性根 /<repository>，无法安全重定位。` +
    `请手工改成 ===/<repository>/<dir>/=== 形式。`,
    "unsafe_section_root",
  );
}

export function renderSectionHeader(dir: string): string {
  return dir ? `===/<repository>/${dir}/===` : `===/<repository>/===`;
}

// ────────────────────────────────────────────────────────────
// Volume 文档
// ────────────────────────────────────────────────────────────

export interface MalformedLine {
  /** 1-based 行号，方便人直接定位 */
  line: number;
  text: string;
}

export interface VolumeDoc {
  entries: Entry[];
  /** 按目录分组的原始顺序（保证写回时结构稳定） */
  order: string[];
  /**
   * 形似 Entry 但解析失败的行。
   *
   * 为什么必须收集而不是丢弃：Code Volume 只允许「注释 / 目录段头 / Entry」三类行，
   * 任何第四条分支都是**格式损坏**。旧实现直接 return null —— 坏条 Entry 既不算
   * 存在也不报错，下一次 cos_update 重写文件时就永久消失（实测：手改成小写标签的
   * Entry 会静默蒸发）。这里把坏行留成事实，由调用方失败关闭。
   */
  malformed: MalformedLine[];
}

export function parseCodeVolume(text: string): VolumeDoc {
  const lines = text.split(/\r?\n/);
  const entries: Entry[] = [];
  const order: string[] = [];
  const malformed: MalformedLine[] = [];
  let dir = "";
  let sawMarker = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    // 顺序很关键：Entry 优先试，能解析成 Entry 的行永远算 Entry
    // （历史行为允许 `#foo.ts[CG7M]: ...` 这类路径以 # 开头的 Entry，
    //  所以不能靠"是不是 # 开头"来判断注释）。
    const e = parseEntryLine(line, dir);
    if (e) {
      entries.push(e);
      if (!order.includes(dir)) order.push(dir);
      continue;
    }
    const sec = parseSectionHeader(line);
    if (sec !== null) {
      dir = sec;
      if (!order.includes(dir)) order.push(dir);
      continue;
    }
    if (line.startsWith("#")) {
      if (!sawMarker && line.includes("COS-CODE-VOLUME")) sawMarker = true;
      continue;
    }
    // 走到这里：非空、非注释、非段头、非合法 Entry —— 格式损坏，记账。
    malformed.push({ line: i + 1, text: line });
  }
  return { entries, order, malformed };
}

export function renderCodeVolume(entries: Entry[], dirOrder?: string[]): string {
  const byDir = new Map<string, Entry[]>();
  for (const e of entries) {
    const d = dirname(e.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(e);
  }
  const dirs = dirOrder
    ? [...dirOrder.filter((d) => byDir.has(d)), ...[...byDir.keys()].filter((d) => !dirOrder.includes(d))]
    : [...byDir.keys()].sort();
  const out: string[] = [CODE_MARKER, ""];
  for (const d of dirs) {
    out.push(renderSectionHeader(d));
    for (const e of byDir.get(d)!) out.push(renderEntryLine(e));
    out.push("");
  }
  return out.join("\n");
}

// ────────────────────────────────────────────────────────────
// 校验
// ────────────────────────────────────────────────────────────

export function validateEntry(e: Entry): QuotaViolation[] {
  const tag = parseTag(e.tag);
  const q = FIELD_QUOTA[quotaBand(tag.c)];
  const out: QuotaViolation[] = [];
  for (const field of ["f", "r", "a", "s"] as const) {
    const limit = q[field];
    const actual = [...e[field]].length;
    if (actual > limit) out.push({ path: e.path, field, actual, limit });
  }
  return out;
}

/** R 字段引用形式校验：code:<path> / database://... / - ；逗号分隔 */
export function validateRelations(r: string): string[] {
  const problems: string[] = [];
  const v = r.trim();
  if (v === "-" || v === "") return problems;
  for (const item of v.split(",").map((x) => x.trim())) {
    if (item === "-") continue;
    if (item.startsWith("code:") && item.length > 5) continue;
    if (item.startsWith("database://")) continue;
    problems.push(
      `R 值 "${item}" 不是合法引用形式。` +
      `请用 code:<仓库相对路径> 或 database://<source>/<ns>/<table>，无关系写 -`,
    );
  }
  return problems;
}

/**
 * 检查一段 Editor 输出能否从 Volume 读回（写入前证明，失败则拒绝整批）。
 * 对应 AOCI 的 "writer proves every Entry reads back"。
 */
export function roundTripCheck(entries: Entry[]): void {
  const text = renderCodeVolume(entries);
  const back = parseCodeVolume(text);
  if (back.entries.length !== entries.length) {
    throw new CosError(
      `回读校验失败：写入 ${entries.length} 条，读回 ${back.entries.length} 条。路径可能含不可移植字符（如尾随空格）。`,
      "roundtrip_failed",
    );
  }
  for (const e of entries) {
    const got = back.entries.find((x) => x.path === e.path);
    if (!got) throw new CosError(`回读校验失败：对象 "${e.path}" 写不回来`, "roundtrip_failed");
    if (got.f !== e.f || got.r !== e.r || got.a !== e.a || got.s !== e.s) {
      throw new CosError(`回读校验失败：对象 "${e.path}" 字段不一致`, "roundtrip_failed");
    }
  }
}

// ────────────────────────────────────────────────────────────
// Root / Meta 渲染
// ────────────────────────────────────────────────────────────

export function renderRoot(project: string, invariants: string): string {
  return [
    ROOT_MARKER,
    `#Format-Version: ${FORMAT_VERSION}`,
    `#Locale: zh-CN`,
    `#Project: ${project}`,
    `#Global-Invariants: ${invariants}`,
    // Volume 路径相对 Root 所在目录（即 .codebase_store/）
    `#Volume: id=meta kind=meta path=${META_BASENAME} format=meta-v1 depends=- state=enabled`,
    `#Volume: id=code kind=code path=${CODE_BASENAME} format=object-fras-v2 depends=meta state=enabled`,
    "",
  ].join("\n");
}

export function renderMeta(): string {
  return [
    META_MARKER,
    `#Object-Protocol: ${OBJECT_PROTOCOL}`,
    `#FRAS-Discipline: 1`,
    `#FRAS-Limits-Authority: machine-contract`,
    `#S-Admission: non-inferable-and-error-preventing`,
    `#S quota: C9-8≤600 C7-4≤200 C3-1≤50`,
    `#Object-Kinds: code=file`,
    `#Canonical-Tag-Authoring: compact A+B+C+[D]+E`,
    `#Code canonical identity example: code:path/to/file.go`,
    `#Section root: /<repository> 代表存放本索引的检出仓库根，不是真实路径`,
    `#Code Entry example: file.go[CG7T]: F:运行示例应用 | R:code:config/load.go | A:main | S:配置缺失时非零退出，不回退默认值`,
    `#[Tag dictionary: code]`,
    `#A Layer: C-共享基础 E-入口边界 A-应用编排 D-领域逻辑 K-算法计算 M-中间件 P-持久化 I-集成适配 R-运行基础 L-库与SDK F-声明配置 O-运维交付 T-测试验证 S-文档规范 X-开发工具 Z-其他`,
    `#B Module: G-跨域通用 U-用户交互 B-核心业务 D-数据状态 I-身份权限 N-网络协议 M-消息事件 S-安全隐私 C-配置策略 O-可观测性 R-可靠性恢复 P-性能资源 W-流程调度 A-分析智能 H-硬件设备 L-本地化 V-构建发布 Q-质量保障 E-扩展插件 Z-其他`,
    `#C Importance: 9-最高 8-很高 7-高 6-较高 5-中等 4-较低 3-低 2-很低 1-最低`,
    `#E Scale: L-大>400 M-中200-400 S-小100-200 T-微<100`,
    "",
  ].join("\n");
}
