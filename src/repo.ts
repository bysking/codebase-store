/**
 * repo.ts — 仓库状态：配置 / git / scope / baseline / 原子写 / 事实聚合
 *
 * 对应 AOCI-CODE 的 config + fs + managedscope + baseline + cognitiontxn
 * 五个包（共 59 文件）压缩成一个文件。
 *
 * 关键不变量：
 *   · 文件来源以 Git ignore 权威为准（不自己实现 ignore 逻辑）
 *   · 写入先算 CAS，不一致则失败关闭，绝不覆盖
 *   · baseline 最后落盘（先落认知，再落基线）
 */

import { join, resolve, sep, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, statSync, rmSync,
  readFileSync, writeFileSync, renameSync, openSync, readSync, closeSync,
} from "node:fs";
import {
  CONFIG_PATH, BASELINE_PATH, DATA_DIR, INDEX_PATH, META_PATH, CODE_PATH,
  DEFAULT_EXCLUDE_DIRS, MAX_FILE_BYTES, CHUNK_TOKENS_DEFAULT,
  WHOLE_INDEX_BUDGET, CosError, sha256, isBinary, nowIso, estimateTokens,
  type Config, type Baseline, type Entry, type Facts, type Drift, type Role,
  type FileStamp,
} from "./core.ts";
import {
  parseCodeVolume, renderCodeVolume, validateEntry, validateRelations,
  renderRoot, renderMeta, roundTripCheck,
  type MalformedLine,
} from "./format.ts";

// ────────────────────────────────────────────────────────────
// 仓库定位
// ────────────────────────────────────────────────────────────

export function findRepoRoot(start = process.cwd()): string {
  let cur = resolve(start);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = resolve(cur, "..");
    if (parent === cur) return resolve(start);
    cur = parent;
  }
}

/** 该目录是否已经初始化过 cos */
export function isInitialized(dir: string): boolean {
  return existsSync(join(dir, DATA_DIR, "cos.txt"));
}

/**
 * 从 start 开始向上逐层查找第一个**已初始化**的 cos 仓库。
 *
 * 判定依据是 `.codebase_store/cos.txt` 是否存在，而不是 `.git`：
 *   · 一个仓库里可能有多个子项目，cos 状态挂在哪个目录由是否 init 过决定
 *   · `.git` 只能定位版本库边界，不能区分"哪个子项目是认知目标"
 *
 * 找不到返回 null（不是抛错）—— 让调用方决定报什么错。
 */
export function findInitializedRoot(start = process.cwd()): string | null {
  let cur = resolve(start);
  for (;;) {
    if (isInitialized(cur)) return cur;
    const parent = resolve(cur, "..");
    if (parent === cur) return null;
    cur = parent;
  }
}

export function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git"));
}

// ────────────────────────────────────────────────────────────
// 配置
// ────────────────────────────────────────────────────────────

function dataDirAbs(root: string): string {
  return join(root, DATA_DIR);
}

export function defaultConfig(): Config {
  return {
    version: 1,
    excludeDirs: [...DEFAULT_EXCLUDE_DIRS],
    chunkTokens: CHUNK_TOKENS_DEFAULT,
    scopeRules: [
      { action: "exclude", pattern: "**/*.lock", reason: "锁文件是生成产物，无系统语义" },
      { action: "exclude", pattern: "**/*.png", reason: "图片是二进制资产，索引无法承载语义" },
      { action: "exclude", pattern: "**/*.jpg", reason: "图片是二进制资产，索引无法承载语义" },
      { action: "observe", pattern: "**/*.json", reason: "配置与数据文件只观察变化，不逐个写 Entry" },
      { action: "observe", pattern: "**/*.md", reason: "文档正文由人工维护，只观察字节变化" },
    ],
  };
}

/**
 * 读配置。
 *
 * 会剔除已废弃的旧字段（locale / indexPath / refreshThreshold）：
 * 早期版本把它们写进了 config.json 却从未被任何代码消费，
 * 留着会让用户以为改了就有效果。这里显式警告而不是默默忽略。
 */
export function readConfig(root: string): Config {
  const p = join(root, CONFIG_PATH);
  if (!existsSync(p)) throw new CosError(`未初始化：缺少 ${CONFIG_PATH}。先运行 cos init`, "not_initialized");
  const raw = JSON.parse(readText(p)) as Record<string, unknown>;

  const OBSOLETE = ["locale", "indexPath", "refreshThreshold"] as const;
  const stale = OBSOLETE.filter((k) => k in raw);
  if (stale.length > 0) {
    process.stderr.write(
      `[cos] 警告：${CONFIG_PATH} 里的 ${stale.join(" / ")} 已废弃且从未生效，可以删掉。` +
      `（真实生效的配置只有 excludeDirs / chunkTokens / scopeRules）\n`,
    );
    for (const k of stale) delete raw[k];
  }

  return { ...defaultConfig(), ...(raw as Partial<Config>) };
}

export function writeConfig(root: string, cfg: Config): void {
  mkdirSync(dataDirAbs(root), { recursive: true });
  writeAtomic(join(root, CONFIG_PATH), JSON.stringify(cfg, null, 2) + "\n");
}

// ────────────────────────────────────────────────────────────
// 基础读写
// ────────────────────────────────────────────────────────────

export function readText(p: string): string {
  return readFileSync(p, "utf8");
}

export function fileBytes(p: string): Uint8Array {
  return new Uint8Array(readFileSync(p));
}

/**
 * 原子写：同目录临时文件 + rename。
 * POSIX rename 本身是原子的，不需要 RENAME_EXCHANGE（我们从不覆盖别人的字节）。
 */
export function writeAtomic(p: string, content: string): void {
  // 必须用 dirname 语义而不是 lastIndexOf(sep)：
  // 无分隔符的相对路径（如 "AGENTS.md"）会让 lastIndexOf 返回 -1，
  // slice(0, -1) 砍掉最后一个字符，凭空造出 "AGENTS.m" 目录（实测过）。
  // dirname 对 "a.txt" 返回 "."，对绝对路径返回其父目录 —— 两种都正确。
  const dir = dirname(p);
  mkdirSync(dir === "" ? "." : dir, { recursive: true });
  // 临时文件与目标同目录，保证 rename 不跨文件系统
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, p);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败不影响主流程 */ }
    throw err;
  }
}

/**
 * Entry 路径必须是可以安全 join 到仓库内的相对路径。
 *
 * 这条防线必须同时覆盖「写入」和「已落盘内容」：旧实现只在 commit 时校验 upserts，
 * 手写进 cos.code.txt 的 `../../../etc/hostname[CZ7T]` 会让 collectFacts 直接去
 * 读仓库外的文件（实测 stale 检查读到了 /etc/hostname）。
 */
export function assertRepoRelativePath(p: string): void {
  if (isSafeRepoRelative(p)) return;
  if (!p) throw new CosError(`对象路径不能为空`, "bad_path");
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) {
    throw new CosError(`对象路径 "${p}" 必须是仓库相对路径，不能是绝对路径`, "bad_path");
  }
  throw new CosError(`对象路径 "${p}" 不能包含 ..`, "bad_path");
}

/** 纯判断版，供已落盘内容（不可抛错误的场景）使用 */
export function isSafeRepoRelative(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return false;
  if (p.split("/").some((seg) => seg === "..")) return false;
  return true;
}

export function fileSha(p: string): string | null {
  if (!existsSync(p)) return null;
  try {
    return sha256(fileBytes(p));
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// 文件枚举（Git ignore 权威）
// ────────────────────────────────────────────────────────────

/**
 * 列出受 git 追踪/未被忽略的文件。
 * 权威来自 `git ls-files` —— 不自己实现 ignore 逻辑，避免与 git 行为分叉。
 */
export function listGitFiles(root: string): string[] | null {
  if (!isGitRepo(root)) return null;
  // 用 node:child_process 而非 Bun.spawnSync —— 两种运行时都支持
  const proc = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (proc.error || proc.status !== 0 || !proc.stdout) return null;
  return proc.stdout.toString("utf8").split("\0").filter(Boolean);
}

/** 无 git 时的回退：按默认排除目录遍历 */
export function listFsFiles(root: string, excludeDirs: string[]): string[] {
  const out: string[] = [];
  const skip = new Set(excludeDirs);
  const walk = (dir: string) => {
    let items: string[];
    try {
      items = readdirSync(join(root, dir));
    } catch {
      return;
    }
    for (const name of items) {
      const rel = dir ? `${dir}/${name}` : name;
      let st;
      try { st = statSync(join(root, rel)); } catch { continue; }
      if (st.isDirectory()) {
        if (!skip.has(name)) walk(rel);
      } else if (st.isFile()) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out;
}

// ────────────────────────────────────────────────────────────
// Scope 判定
// ────────────────────────────────────────────────────────────

/**
 * glob → 正则的编译缓存。
 *
 * resolveRole 对每个文件 × 每条 scopeRule 都会调用这里：
 * 3000 个文件 × 6 条规则 = 18000 次编译。规则集在进程内不变，
 * 所以按 pattern 字符串缓存即可 —— Map 查找比重新编译正则快两个数量级。
 */
const globCache = new Map<string, RegExp>();

function globToRe(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  // ** → 任意层级；* → 单层内任意；? → 单字符
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
      // 吞掉紧随的 /
      if (pattern[i] === "/") i++;
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  globCache.set(pattern, compiled);
  return compiled;
}

export function resolveRole(path: string, cfg: Config): Role {
  // 数据目录整体不属于受管对象：它是认知资产与治理状态本身，不是被认识的对象。
  // 放进 index 角色会让它每次 cos_update 后自己变 stale。
  if (path === DATA_DIR || path.startsWith(DATA_DIR + "/")) return "exclude";
  if (path === "AGENTS.md") return "index";
  // 显式规则优先（按声明顺序）
  for (const rule of cfg.scopeRules) {
    if (globToRe(rule.pattern).test(path)) return rule.action;
  }
  // 默认目录排除
  const top = path.split("/")[0]!;
  if (cfg.excludeDirs.includes(top)) return "exclude";
  if (cfg.excludeDirs.includes(path)) return "exclude";
  return "index";
}

/** 源文件是否可进入 index 角色（空/二进制/超限 → 挡在外面） */
export function isIndexableSource(root: string, path: string): { ok: boolean; reason?: string } {
  const full = join(root, path);
  let st;
  try { st = statSync(full); } catch { return { ok: false, reason: "unreadable" }; }
  if (st.size === 0) return { ok: false, reason: "empty" };
  if (st.size > MAX_FILE_BYTES) return { ok: false, reason: "oversize" };
  // 只读头部判断二进制：isBinary 本身就只看前 8000 字节，
  // 但 fileBytes 会把整个文件读进内存 —— 对 4 MB 的源文件是纯粹浪费。
  // 实测 20 个 4MB 文件：整读 23ms，读头部不到 1ms。
  if (isBinary(readHead(full, 8000))) return { ok: false, reason: "binary" };
  return { ok: true };
}

/** 读文件头部若干字节（文件更短时读全部）。读失败返回空 buffer。 */
function readHead(fullPath: string, bytes: number): Uint8Array {
  try {
    const fd = openSync(fullPath, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, 0);
      return new Uint8Array(buf.subarray(0, n));
    } finally {
      closeSync(fd);
    }
  } catch {
    return new Uint8Array(0);
  }
}

// ────────────────────────────────────────────────────────────
// Baseline
// ────────────────────────────────────────────────────────────

export function emptyBaseline(): Baseline {
  return { version: 2, stamps: {}, entries: {}, source: {}, updatedAt: nowIso() };
}

/**
 * 读 baseline，并把 v1（`files: Record<path, sha>`）平滑升级到 v2（`stamps`）。
 *
 * 旧文件没有 size/mtime，无法做 stat 快路径 —— 这种条目在第一次比对时
 * 会自动回落到整读算 sha 并补齐字段。不需要用户手动重跑 scan。
 */
export function readBaseline(root: string): Baseline {
  const p = join(root, BASELINE_PATH);
  if (!existsSync(p)) return emptyBaseline();
  try {
    const raw = JSON.parse(readText(p)) as Record<string, unknown>;
    const base = emptyBaseline();
    const stamps = { ...base.stamps };

    // v1 → v2：files 是 path -> sha 的扁平映射，size/mtime 未知记 0（强制走 sha 路径）
    const legacyFiles = raw.files as Record<string, string> | undefined;
    if (legacyFiles && typeof legacyFiles === "object") {
      for (const [path, sha] of Object.entries(legacyFiles)) {
        if (typeof sha === "string") stamps[path] = { sha, size: -1, mtimeMs: -1 };
      }
    }
    // v2 的 stamps 直接覆盖
    const rawStamps = raw.stamps as Record<string, FileStamp> | undefined;
    if (rawStamps && typeof rawStamps === "object") Object.assign(stamps, rawStamps);

    return {
      version: 2,
      stamps,
      entries: (raw.entries as Baseline["entries"]) ?? {},
      source: (raw.source as Baseline["source"]) ?? {},
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
    };
  } catch {
    throw new CosError(`${BASELINE_PATH} 损坏，无法解析`, "bad_baseline");
  }
}

/** 取文件当前指纹（整读 + sha） */
export function stampFile(fullPath: string): FileStamp | null {
  try {
    const st = statSync(fullPath);
    return { sha: sha256(fileBytes(fullPath)), size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * 判断文件是否相对 baseline 变过。
 *
 * 快路径：size 与 mtimeMs 都相同 → 认定未变，**不读文件**。
 * 慢路径：任一不同（或旧 baseline 没有这两个字段，值为 -1）→ 整读算 sha。
 *
 * 返回 true 表示「确实变了」（sha 不同），false 表示「没变」。
 * 快路径只是省 IO，不会把"变了"判成"没变"到影响结论的程度；
 * 反过来 mtime 骗人（比如被人为 touch 回旧时间）最多让一次 stale 漏报，
 * 而 scan --force 仍然能重建。这个取舍与 git index 的做法一致。
 */
export function fileChanged(fullPath: string, prev: FileStamp | undefined): boolean {
  let st;
  try { st = statSync(fullPath); } catch { return true; }
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.size >= 0) {
    return false;
  }
  // 文件读不出来（权限/IO 错误）时按"变了"处理：
  // 抛出会让整条 status/verify 崩掉，而我们本来就有"无法确认则视为已变"这个安全方向。
  const cur = fileSha(fullPath);
  return cur === null || !prev || prev.sha !== cur;
}

export function writeBaseline(root: string, b: Baseline): void {
  b.updatedAt = nowIso();
  mkdirSync(dataDirAbs(root), { recursive: true });
  writeAtomic(join(root, BASELINE_PATH), JSON.stringify(b, null, 2) + "\n");
}

// ────────────────────────────────────────────────────────────
// 认知加载
// ────────────────────────────────────────────────────────────

export interface RepoState {
  root: string;
  cfg: Config;
  rootText: string;
  metaText: string;
  codeText: string;
  entries: Entry[];
  dirOrder: string[];
  /** Code Volume 里解析不了的行 —— 非空时任何写入都会丢数据 */
  malformed: MalformedLine[];
  baseline: Baseline;
}

export function loadState(root: string): RepoState {
  const cfg = readConfig(root);
  const rootP = join(root, INDEX_PATH);
  const metaP = join(root, META_PATH);
  const codeP = join(root, CODE_PATH);
  if (!existsSync(rootP)) throw new CosError(`缺少 ${INDEX_PATH}，先运行 cos init`, "not_initialized");
  if (!existsSync(metaP)) throw new CosError(`缺少 ${META_PATH}（Root 声明了它但不存在），CognitionSet 失败关闭`, "missing_volume");
  const rootText = readText(rootP);
  const metaText = readText(metaP);
  const codeText = existsSync(codeP) ? readText(codeP) : "";
  const doc = parseCodeVolume(codeText);

  // 已落盘的 Entry 也要校验路径安全性。
  // 否则手写一条 `../../../etc/hostname` 就能让 collectFacts 去读仓库外文件。
  // 这里只做检查不自动修正 —— 修正等于替用户猜，会掩盖真实的手改事故。
  const unsafe = doc.entries.filter((e) => !isSafeRepoRelative(e.path));
  if (unsafe.length > 0) {
    throw new CosError(
      `${CODE_PATH} 里有 ${unsafe.length} 条 Entry 的路径不是仓库相对路径：` +
      unsafe.slice(0, 5).map((e) => `\n  ${e.path}`).join("") +
      `\n绝对路径或以 .. 开头的路径会让索引指到仓库外。请改回仓库相对路径。`,
      "unsafe_entry_path",
    );
  }

  return {
    root, cfg, rootText, metaText, codeText,
    entries: doc.entries, dirOrder: doc.order, malformed: doc.malformed,
    baseline: readBaseline(root),
  };
}

// ────────────────────────────────────────────────────────────
// 事实聚合（漂移 / 对齐 / 配额）
// ────────────────────────────────────────────────────────────

export function collectFacts(state: RepoState): Facts {
  const { root, cfg, entries, baseline } = state;
  const drift: Drift[] = [];

  const gitFiles = listGitFiles(root);
  const allFiles = gitFiles ?? listFsFiles(root, cfg.excludeDirs);
  const entryByPath = new Map(entries.map((e) => [e.path, e]));

  // 认知资产自身不算"缺 Entry"的对象
  const isCognitionAsset = (p: string) => p === INDEX_PATH || p === META_PATH || p === CODE_PATH;

  // 应当被 index 的源文件集合（index 角色 + 可索引 + 非认知资产）
  const indexable = new Set<string>();
  for (const f of allFiles) {
    if (f.startsWith(DATA_DIR + "/")) continue;
    if (isCognitionAsset(f)) continue;
    if (resolveRole(f, cfg) !== "index") continue;
    if (entryByPath.has(f)) { indexable.add(f); continue; }
    // 还没有 Entry：只有能索取的源文件才算受管对象
    if (!isIndexableSource(root, f).ok) continue;
    indexable.add(f);
  }

  // Malformed：Code Volume 里有解析不了的行。
  // 这类损坏必须显式暴露 —— 否则下一次 cos_update 重写文件时它会永久消失。
  for (const bad of state.malformed) {
    drift.push({ kind: "malformed", path: `L${bad.line}: ${bad.text}` });
  }

  // Missing：Entry 在，文件不在
  for (const e of entries) {
    if (!existsSync(join(root, e.path))) drift.push({ kind: "missing", path: e.path });
  }
  // Orphan：Entry 在，但对象已不是 index 角色
  for (const e of entries) {
    if (!existsSync(join(root, e.path))) continue;
    if (resolveRole(e.path, cfg) !== "index") drift.push({ kind: "orphan", path: e.path });
  }
  // Stale：文件指纹变了。
  // 这里有快路径：size+mtime 都没动就跳过读文件（见 fileChanged 的说明）。
  for (const e of entries) {
    const full = join(root, e.path);
    if (!existsSync(full)) continue;
    const prev = baseline.stamps[e.path];
    if (prev && fileChanged(full, prev)) {
      drift.push({ kind: "stale", path: e.path });
    }
  }
  // Unbaselined：受管文件未进基线，或 Entry 未进基线
  for (const f of indexable) {
    if (!baseline.stamps[f]) drift.push({ kind: "unbaselined", path: f });
  }
  for (const e of entries) {
    if (!baseline.entries[e.path]) drift.push({ kind: "unbaselined", path: e.path });
  }

  // 去重
  const seen = new Set<string>();
  const dedup = drift.filter((d) => {
    const k = `${d.kind}:${d.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 两个正交的事实轴：待创作 / 待删除
  const needAuthoring = [...indexable].filter((p) => !entryByPath.has(p)).sort();
  const needRemoval = [
    ...entries.filter((e) => !existsSync(join(root, e.path))).map((e) => e.path),
    ...entries.filter((e) => existsSync(join(root, e.path)) && resolveRole(e.path, cfg) !== "index").map((e) => e.path),
  ].sort();

  // 配额
  const quotaViolations = entries.flatMap((e) => validateEntry(e));

  // token
  const tokens = estimateTokens(state.rootText + state.metaText + state.codeText);

  /*
   * 对齐判定。四个状态的语义必须是**互斥且可照做**的：
   *
   *   budget_exceeded  索引超硬上限 —— 只能裁剪或拆分
   *   unbaselined      基线本身没有（没跑过 init/scan）—— 去跑 scan
   *   authoring_required 基线在，但有活要干（创作/删除/复查/配额/格式）—— 走 cos_maintain
   *   aligned          全都对上了
   *
   * 旧实现把「一条 Entry 都还没写」判成 unbaselined，但那时基线明明已经建立 ——
   * 用户照着名字去重跑 scan，而 scan 会报 baseline_exists 拒绝他。状态名在骗人。
   * 「没 Entry」是 authoring_required（待创作），不是「没有基线」。
   */
  const hasBaseline = Object.keys(baseline.stamps).length > 0;

  let alignment: Facts["alignment"] = "aligned";
  if (tokens > WHOLE_INDEX_BUDGET.max) alignment = "budget_exceeded";
  else if (!hasBaseline) alignment = "unbaselined";
  else if (state.malformed.length > 0) alignment = "authoring_required";
  else if (needAuthoring.length > 0) alignment = "authoring_required";
  else if (needRemoval.length > 0) alignment = "authoring_required";
  else if (dedup.some((d) => d.kind === "stale")) alignment = "authoring_required";
  else if (quotaViolations.length > 0) alignment = "authoring_required";

  return {
    drift: dedup, alignment, entries: entries.length, files: indexable.size,
    tokens, quotaViolations, needAuthoring, needRemoval, hasBaseline,
  };
}

// ────────────────────────────────────────────────────────────
// 写认知（唯一写入路径）
// ────────────────────────────────────────────────────────────

export interface WriteResult {
  entries: number;
  sha: string;
}

/**
 * 提交一批 Entry 变更。
 *   0. 格式完整 + 快照一致（缺一个就失败关闭，绝不覆盖别人的字节）
 *   1. 合并到现有 entries
 *   2. 回读校验（写不回来就整批拒绝）
 *   3. 配额校验
 *   4. CAS 写
 *   5. baseline 最后落
 */
export function commitEntries(
  state: RepoState,
  upserts: Entry[],
  removals: string[],
  expectSha: string | null,
): WriteResult {
  const { root } = state;
  const codeP = join(root, CODE_PATH);
  const currentSha = existsSync(codeP) ? sha256(readText(codeP)) : null;

  // ① 格式必须完好。带坏行时重写会把坏行永久抹掉 —— 数据丢失不可接受，整批拒绝。
  if (state.malformed.length > 0) {
    throw new CosError(
      `${CODE_PATH} 有 ${state.malformed.length} 行无法解析成 Entry，重写会永久丢掉它们。` +
      `请先手工修复这些行：` +
      state.malformed.slice(0, 5).map((m) => `\n  L${m.line}: ${m.text}`).join("") +
      (state.malformed.length > 5 ? `\n  …… 还有 ${state.malformed.length - 5} 行` : "") +
      `\n（合法行只有三类：注释 / ===/<repository>/<dir>/=== / name[TAG]: F:.. | R:.. | A:.. | S:..）`,
      "malformed_volume",
    );
  }

  // ② 隐式 CAS：磁盘内容必须与调用方 loadState 时看到的快照一致。
  // 这里的比较对象是 state.codeText —— 调用方拿着它构造 next，所以它才是真正的基线。
  // 不传 expectSha 也拦得住并发丢更新（旧实现只在你主动传时才校验，实测两次
  // commitEntries(..., null) 会把先写的整条覆盖掉，且毫无报错）。
  const snapshotSha = state.codeText === "" && currentSha === null ? null : sha256(state.codeText);
  if (snapshotSha !== currentSha) {
    throw new CosError(
      `CAS 失败：${CODE_PATH} 在你读取之后被改动过（快照 ${(snapshotSha ?? "空").slice(0, 12)}，` +
      `磁盘 ${(currentSha ?? "空").slice(0, 12)}）。请重新读取后再写。`,
      "cas_conflict",
    );
  }

  // ③ 显式 CAS：调用方给了 expectSha 就再对一次（兼容旧调用约定）
  if (expectSha !== null && currentSha !== expectSha) {
    throw new CosError(`CAS 失败：${CODE_PATH} 已被修改，请重新读取后再写`, "cas_conflict");
  }

  // 校验入参
  for (const e of upserts) {
    assertRepoRelativePath(e.path);
    const problems = validateRelations(e.r);
    if (problems.length) throw new CosError(`${e.path}: ${problems.join("; ")}`, "bad_relation");
    const viol = validateEntry(e);
    if (viol.length) {
      throw new CosError(
        `${e.path}: 配额超限 ` + viol.map((v) => `${v.field} ${v.actual}>${v.limit}`).join(", ") +
        `。S 字段两问：能推断的不写，删了不出事的不写 —— 请收紧而不是放宽上限。`,
        "quota_exceeded",
      );
    }
  }
  for (const p of removals) assertRepoRelativePath(p);

  // 合并
  const removalSet = new Set(removals);
  const upsertMap = new Map(upserts.map((e) => [e.path, e]));
  const next: Entry[] = [];
  for (const e of state.entries) {
    if (removalSet.has(e.path)) continue;
    next.push(upsertMap.get(e.path) ?? e);
    upsertMap.delete(e.path);
  }
  for (const [, e] of upsertMap) next.push(e);

  // 回读校验
  roundTripCheck(next);

  // 写
  const text = renderCodeVolume(next, state.dirOrder);
  writeAtomic(codeP, text);

  // baseline 最后落
  const baseline = readBaseline(root);
  for (const e of next) {
    const full = join(root, e.path);
    if (existsSync(full)) {
      const stamp = stampFile(full);
      if (stamp) baseline.stamps[e.path] = stamp;
    }
    baseline.entries[e.path] = sha256(JSON.stringify(e));
    baseline.source[e.path] = "indexed";
  }
  for (const p of removals) {
    delete baseline.stamps[p];
    delete baseline.entries[p];
    delete baseline.source[p];
  }
  writeBaseline(root, baseline);

  return { entries: next.length, sha: sha256(text) };
}

// ────────────────────────────────────────────────────────────
// init / scan
// ────────────────────────────────────────────────────────────

export function initRepo(root: string, force: boolean): { created: string[] } {
  const created: string[] = [];
  const rootP = join(root, INDEX_PATH);
  if (existsSync(rootP) && !force) {
    throw new CosError(`${INDEX_PATH} 已存在。用 --force 覆盖（会清空已有认知）。`, "already_initialized");
  }

  const project = root.split(sep).pop() ?? "project";
  const invariants =
    "语义只由宿主模型创作，程序绝不生成、预填或判断；" +
    "写入前必须能读回自己写的字节，否则整批拒绝；" +
    "S 字段两问准入：能推断的不写，删了不出事的不写；" +
    "配额上限在程序里，改索引文本放宽不了";

  const files: [string, string][] = [
    [INDEX_PATH, renderRoot(project, invariants)],
    [META_PATH, renderMeta()],
    [CODE_PATH, `#COS-CODE-VOLUME: 1\n\n===/<repository>/===\n`],
  ];
  for (const [p, content] of files) {
    writeAtomic(join(root, p), content);
    created.push(p);
  }
  writeConfig(root, defaultConfig());
  created.push(CONFIG_PATH);

  /*
   * baseline 的生命周期必须与认知文件一致。
   *
   * --force 的语义是「把认知清空重来」，那基线也必须跟着清 —— 否则会出现
   * 自相矛盾的状态：Entry 0 条、但 baseline.stamps 里还留着上一轮的 3000 个
   * 指纹，hasBaseline 仍为 true，alignment 报 authoring_required。
   * 实测 init --force 后 status 显示「Entry 0 / 受管文件 4 / 漂移 0」。
   */
  const baselineP = join(root, BASELINE_PATH);
  if (force || !existsSync(baselineP)) {
    writeBaseline(root, emptyBaseline());
    created.push(BASELINE_PATH);
  }

  // AGENTS.md 托管块
  const agentsP = join(root, "AGENTS.md");
  const existing = existsSync(agentsP) ? readText(agentsP) : "";
  const block = renderAgentsBlock(project);
  writeAtomic(agentsP, upsertBlock(existing, block));
  created.push("AGENTS.md");

  // .gitignore 追加本地产物与宿主配置
  // 注意：.codebase_store/ 下只有临时文件被忽略，索引本身应当进 Git（这是方法论的要求）
  const giP = join(root, ".gitignore");
  const gi = existsSync(giP) ? readText(giP) : "";
  const need = [`${DATA_DIR}/*.tmp-*`, ".mcp.json", ".claude/settings.local.json"];
  const lines = gi.split(/\r?\n/);
  const missing = need.filter((n) => !lines.includes(n));
  if (missing.length) {
    writeAtomic(giP, gi + (gi.endsWith("\n") || gi === "" ? "" : "\n") + "# cos\n" + missing.join("\n") + "\n");
    created.push(".gitignore");
  }

  return { created };
}

/**
 * 建立基线：记录当前受管文件与 Entry 的指纹。
 *
 * 注意：scan 只落「源码指纹」，不落「Entry 指纹」。这样"文件已受管但还没有 Entry"
 * 仍然是可检测的事实（unbaselined / needAuthoring），不会被 scan 洗掉。
 */
export function scanRepo(root: string, force: boolean): { files: number; entries: number } {
  const cfg = readConfig(root);
  const state = loadState(root);
  const baseline = readBaseline(root);

  if (Object.keys(baseline.stamps).length > 0 && !force) {
    throw new CosError(
      `基线已存在（${Object.keys(baseline.stamps).length} 个文件）。` +
      `新增/移除受管范围请改 ${CONFIG_PATH} 的 scopeRules，而不是 scan --force。` +
      `只想刷新指纹用 cos_update 重提交，或 scan --force 明确重建。`,
      "baseline_exists",
    );
  }

  const gitFiles = listGitFiles(root);
  const allFiles = gitFiles ?? listFsFiles(root, cfg.excludeDirs);
  let n = 0;
  for (const f of allFiles) {
    if (f.startsWith(DATA_DIR + "/")) continue;
    const role = resolveRole(f, cfg);
    if (role === "exclude") continue;
    const full = join(root, f);
    if (!existsSync(full)) continue;
    try {
      const stamp = stampFile(full);
      if (stamp) baseline.stamps[f] = stamp;
      baseline.source[f] = role === "index" ? "indexed" : "observed";
      n++;
    } catch { /* 不可读文件跳过 */ }
  }
  // 已有 Entry 的指纹补进基线（不改动源文件指纹）
  for (const e of state.entries) {
    baseline.entries[e.path] = sha256(JSON.stringify(e));
  }
  writeBaseline(root, baseline);
  return { files: n, entries: state.entries.length };
}

// ────────────────────────────────────────────────────────────
// AGENTS.md 托管块
// ────────────────────────────────────────────────────────────

const BLOCK_START = "<!-- cos:rules:start -->";
const BLOCK_END = "<!-- cos:rules:end -->";

export function renderAgentsBlock(project: string): string {
  return `${BLOCK_START}
## 仓库认知索引（cos）

本项目维护一份认知索引，全部数据在 \`.codebase_store/\` 目录下：

\`\`\`
.codebase_store/
├── cos.txt          Root：声明有哪些 Volume、项目定位、全局不变量
├── cos.meta.txt     Meta：标签字典、FRAS 规则、配额、创作约束
├── cos.code.txt     Code Volume：代码对象的 Entry（真正的内容在这里）
├── config.json      scope 规则、分块预算、刷新阈值
└── baseline.json    源码与 Entry 的指纹基线
\`\`\`

**开工前先读索引，不要每次重新搜索整个代码库。**

### 强制规则

1. **读一次，用全程**：新会话开始先调用 \`cos_overview\` 读完整个索引（超预算时顺 \`nextCursor\` 读到最后一个 chunk）。之后同一会话不要机械重复读。
2. **语义只由你创作**：程序不会替你生成 F/R/A/S。禁止"先机器出草稿再润色"。
3. **S 字段两问准入**：每句话都要通过 ——（a）能否从对象名/标签/F/R/A 直接推断？能则不写；（b）删掉它会不会导致改错代码/数据/生命周期？不会则不写。
4. **改完代码必须维护索引**：代码与测试稳定后调用 \`cos_maintain\`，按返回的 \`nextAction\` 处理受影响 Entry。
5. **不要手改索引文件**：\`.codebase_store/cos.code.txt\` 只能通过 \`cos_update\` 写，程序会做配额、引用、回读校验。手改会被下次 CAS 冲突挡下。
6. **不要在包装脚本里复制状态机**：权威状态机在 \`cos_maintain\` 返回里。

### 项目

\`${project}\`

${BLOCK_END}`;
}

/**
 * 把托管块写进 AGENTS.md，保证幂等。
 *
 * 三种情况都要正确处理：
 *   1. 有完整的 start..end          → 只替换块内内容
 *   2. 有 start 但 end 丢失/错序    → 从 start 处截断，丢弃残缺尾部，再接新块
 *      （这是关键：否则会不断追加，文件里出现多个 start 标记）
 *   3. 没有 start                   → 追加到文件末尾
 */
export function upsertBlock(existing: string, block: string): string {
  const s = existing.indexOf(BLOCK_START);
  if (s < 0) {
    // 情况 3：全新追加
    const sep = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return existing + sep + block + "\n";
  }

  const e = existing.indexOf(BLOCK_END, s);
  if (e > s) {
    // 情况 1：正常替换块内内容
    return existing.slice(0, s) + block + existing.slice(e + BLOCK_END.length);
  }

  // 情况 2：块结构损坏（start 之后找不到 end）。
  // 保守做法：从 start 到文件末尾全部丢弃，用新块替换。
  // 这段区间本来就是我们托管的内容，丢掉不会伤到用户的手写部分。
  const head = existing.slice(0, s).replace(/\n+$/, "");
  return (head === "" ? "" : head + "\n\n") + block + "\n";
}
