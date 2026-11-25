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

import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, statSync, rmSync,
  readFileSync, writeFileSync, renameSync,
} from "node:fs";
import {
  CONFIG_PATH, BASELINE_PATH, DATA_DIR, INDEX_PATH, META_PATH, CODE_PATH,
  DEFAULT_EXCLUDE_DIRS, MAX_FILE_BYTES, CHUNK_TOKENS_DEFAULT,
  CosError, sha256, isBinary, nowIso, estimateTokens,
  type Config, type Baseline, type Entry, type Facts, type Drift, type Role,
} from "./core.ts";
import {
  parseCodeVolume, renderCodeVolume, validateEntry, validateRelations,
  renderRoot, renderMeta, parseRootMeta, roundTripCheck,
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
    locale: "zh-CN",
    indexPath: INDEX_PATH,
    excludeDirs: [...DEFAULT_EXCLUDE_DIRS],
    chunkTokens: CHUNK_TOKENS_DEFAULT,
    refreshThreshold: 30,
    scopeRules: [
      { action: "exclude", pattern: "**/*.lock", reason: "锁文件是生成产物，无系统语义" },
      { action: "exclude", pattern: "**/*.png", reason: "图片是二进制资产，索引无法承载语义" },
      { action: "exclude", pattern: "**/*.jpg", reason: "图片是二进制资产，索引无法承载语义" },
      { action: "observe", pattern: "**/*.json", reason: "配置与数据文件只观察变化，不逐个写 Entry" },
      { action: "observe", pattern: "**/*.md", reason: "文档正文由人工维护，只观察字节变化" },
    ],
  };
}

export function readConfig(root: string): Config {
  const p = join(root, CONFIG_PATH);
  if (!existsSync(p)) throw new CosError(`未初始化：缺少 ${CONFIG_PATH}。先运行 cos init`, "not_initialized");
  return { ...defaultConfig(), ...JSON.parse(readText(p)) };
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
  const dir = p.slice(0, p.lastIndexOf(sep));
  if (dir) mkdirSync(dir, { recursive: true });
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
 * CAS 写：先校验 expectSha 与当前内容一致，不一致则失败关闭。
 * 对应 AOCI 的 compare-and-swap，但不需要多层事务。
 */
export function writeWithCas(p: string, content: string, expectSha: string | null): void {
  const current = existsSync(p) ? sha256(readText(p)) : null;
  if (expectSha !== null && current !== expectSha) {
    throw new CosError(
      `CAS 失败：${p} 已被他人修改（期望 ${expectSha.slice(0, 12)}，实际 ${(current ?? "不存在").slice(0, 12)}）。` +
      `请重新读取后再写。`,
      "cas_conflict",
    );
  }
  writeAtomic(p, content);
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

function globToRe(pattern: string): RegExp {
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
  return new RegExp(`^${re}$`);
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
  if (isBinary(fileBytes(full))) return { ok: false, reason: "binary" };
  return { ok: true };
}

// ────────────────────────────────────────────────────────────
// Baseline
// ────────────────────────────────────────────────────────────

export function emptyBaseline(): Baseline {
  return { version: 1, files: {}, entries: {}, source: {}, updatedAt: nowIso() };
}

export function readBaseline(root: string): Baseline {
  const p = join(root, BASELINE_PATH);
  if (!existsSync(p)) return emptyBaseline();
  try {
    return { ...emptyBaseline(), ...JSON.parse(readText(p)) };
  } catch {
    throw new CosError(`${BASELINE_PATH} 损坏，无法解析`, "bad_baseline");
  }
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
  return {
    root, cfg, rootText, metaText, codeText,
    entries: doc.entries, dirOrder: doc.order,
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

  // Missing：Entry 在，文件不在
  for (const e of entries) {
    if (!existsSync(join(root, e.path))) drift.push({ kind: "missing", path: e.path });
  }
  // Orphan：Entry 在，但对象已不是 index 角色
  for (const e of entries) {
    if (!existsSync(join(root, e.path))) continue;
    if (resolveRole(e.path, cfg) !== "index") drift.push({ kind: "orphan", path: e.path });
  }
  // Stale：文件 hash 变了
  for (const e of entries) {
    const full = join(root, e.path);
    if (!existsSync(full)) continue;
    if (baseline.files[e.path] && baseline.files[e.path] !== sha256(fileBytes(full))) {
      drift.push({ kind: "stale", path: e.path });
    }
  }
  // Unbaselined：受管文件未进基线，或 Entry 未进基线
  for (const f of indexable) {
    if (!baseline.files[f]) drift.push({ kind: "unbaselined", path: f });
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

  // 对齐：覆盖完整 + 无待删除 + 无过期 + 配额通过 + 预算内
  let alignment: Facts["alignment"] = "aligned";
  if (tokens > 240_000) alignment = "budget_exceeded";
  else if (needAuthoring.length > 0) alignment = needAuthoring.length === indexable.size ? "unbaselined" : "authoring_required";
  else if (needRemoval.length > 0) alignment = "authoring_required";
  else if (dedup.some((d) => d.kind === "stale")) alignment = "authoring_required";
  else if (quotaViolations.length > 0) alignment = "authoring_required";

  return {
    drift: dedup, alignment, entries: entries.length, files: indexable.size,
    tokens, quotaViolations, needAuthoring, needRemoval,
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
  if (expectSha !== null && currentSha !== expectSha) {
    throw new CosError(`CAS 失败：${CODE_PATH} 已被修改，请重新读取后再写`, "cas_conflict");
  }

  // 校验入参
  for (const e of upserts) {
    if (!e.path || e.path.startsWith("/") || e.path.includes("..")) {
      throw new CosError(`对象路径 "${e.path}" 必须是仓库相对路径且不含 ..`, "bad_path");
    }
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
      baseline.files[e.path] = sha256(fileBytes(full));
    }
    baseline.entries[e.path] = sha256(JSON.stringify(e));
    baseline.source[e.path] = "indexed";
  }
  for (const p of removals) {
    delete baseline.files[p];
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

  if (!existsSync(join(root, BASELINE_PATH))) {
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

  if (Object.keys(baseline.files).length > 0 && !force) {
    throw new CosError(
      `基线已存在（${Object.keys(baseline.files).length} 个文件）。` +
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
      baseline.files[f] = sha256(fileBytes(full));
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
