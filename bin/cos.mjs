#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/core.ts
import { createHash } from "node:crypto";
function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 19968 && cp <= 40959 || cp >= 12288 && cp <= 12351 || cp >= 65280 && cp <= 65519 || cp >= 13312 && cp <= 19903) {
      cjk++;
    } else {
      other++;
    }
  }
  return cjk + Math.ceil(other / 4);
}
function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0;i < n; i++)
    if (buf[i] === 0)
      return true;
  return false;
}
function splitByBytes(text, maxBytes) {
  const out = [];
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
  if (cur.length > 0)
    out.push(cur);
  return out;
}
function nowIso() {
  return new Date().toISOString();
}
var ROOT_MARKER = "#COS-ROOT-MANIFEST: 1", META_MARKER = "#COS-META-VOLUME: 1", CODE_MARKER = "#COS-CODE-VOLUME: 1", FORMAT_VERSION = "cognition-volumes/v1", OBJECT_PROTOCOL = "cognition-object/v1", DATA_DIR2 = ".codebase_store", INDEX_PATH2, META_PATH2, CODE_PATH2, CONFIG_PATH2, BASELINE_PATH2, META_BASENAME = "cos.meta.txt", CODE_BASENAME = "cos.code.txt", FIELD_QUOTA, WHOLE_INDEX_BUDGET, CHUNK_TOKENS_DEFAULT = 7000, CHUNK_TOKENS_MIN = 4000, CHUNK_TOKENS_MAX = 24000, DEFAULT_EXCLUDE_DIRS, MAX_FILE_BYTES2, CosError2;
var init_core = __esm(() => {
  INDEX_PATH2 = `${DATA_DIR2}/cos.txt`;
  META_PATH2 = `${DATA_DIR2}/cos.meta.txt`;
  CODE_PATH2 = `${DATA_DIR2}/cos.code.txt`;
  CONFIG_PATH2 = `${DATA_DIR2}/config.json`;
  BASELINE_PATH2 = `${DATA_DIR2}/baseline.json`;
  FIELD_QUOTA = {
    high: { f: 450, r: 400, a: 320, s: 1200 },
    mid: { f: 300, r: 250, a: 210, s: 400 },
    low: { f: 180, r: 150, a: 120, s: 120 }
  };
  WHOLE_INDEX_BUDGET = { target: 120000, warning: 180000, max: 240000 };
  DEFAULT_EXCLUDE_DIRS = [
    "node_modules",
    "vendor",
    "dist",
    "build",
    "target",
    ".next",
    "coverage",
    "tmp",
    "uploads",
    "backup",
    "backups",
    "artifacts",
    ".output",
    "__pycache__",
    ".venv",
    "venv",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".nox",
    "htmlcov",
    ".git",
    DATA_DIR2
  ];
  MAX_FILE_BYTES2 = 4 * 1024 * 1024;
  CosError2 = class CosError2 extends Error {
    code;
    constructor(message, code = "cos_error") {
      super(message);
      this.code = code;
      this.name = "CosError";
    }
  };
});

// src/format.ts
function parseTag(raw) {
  const m = /^([A-Z])([A-Z])([1-9])(?:([A-Z]))?([LMST])$/.exec(raw.trim());
  if (!m)
    throw new CosError2(`非法标签 "${raw}"，期望 A+B+C+[D]+E（如 CG9L）`, "bad_tag");
  const [, a, b, c, d, e] = m;
  return { a, b, c: Number(c), d: d ?? "", e, raw: raw.trim() };
}
function quotaBand(c) {
  if (c >= 8)
    return "high";
  if (c >= 5)
    return "mid";
  return "low";
}
function parseEntryLine(line, dirPath) {
  if (line.startsWith("#") && !ENTRY_RE.test(line))
    return null;
  const m = ENTRY_RE.exec(line.trimEnd());
  if (!m)
    return null;
  const [, name, tag, f, r, a, s] = m;
  const base = name.trim();
  const path = dirPath ? `${dirPath}/${base}` : base;
  return { path, tag, f: f.trim(), r: r.trim(), a: a.trim(), s: s.trim() };
}
function renderEntryLine(e) {
  return `${basename(e.path)}[${e.tag}]: F:${e.f} | R:${e.r} | A:${e.a} | S:${e.s}`;
}
function basename(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
function dirname2(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function parseSectionHeader(line) {
  const m = /^===\s*(?:[^=]*?)\s*(\/\S*?)\s*===\s*$/.exec(line);
  if (!m)
    return null;
  const full = m[1];
  const NEUTRAL = "/<repository>";
  if (full === NEUTRAL || full === `${NEUTRAL}/`)
    return "";
  if (full.startsWith(`${NEUTRAL}/`))
    return full.slice(NEUTRAL.length + 1).replace(/\/$/, "");
  throw new CosError2(`目录段根 "${full}" 不是中性根 /<repository>，无法安全重定位。` + `请手工改成 ===/<repository>/<dir>/=== 形式。`, "unsafe_section_root");
}
function renderSectionHeader(dir) {
  return dir ? `===/<repository>/${dir}/===` : `===/<repository>/===`;
}
function parseCodeVolume(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  const order = [];
  const malformed = [];
  let dir = "";
  let sawMarker = false;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "")
      continue;
    const e = parseEntryLine(line, dir);
    if (e) {
      entries.push(e);
      if (!order.includes(dir))
        order.push(dir);
      continue;
    }
    const sec = parseSectionHeader(line);
    if (sec !== null) {
      dir = sec;
      if (!order.includes(dir))
        order.push(dir);
      continue;
    }
    if (line.startsWith("#")) {
      if (!sawMarker && line.includes("COS-CODE-VOLUME"))
        sawMarker = true;
      continue;
    }
    malformed.push({ line: i + 1, text: line });
  }
  return { entries, order, malformed };
}
function renderCodeVolume(entries, dirOrder) {
  const byDir = new Map;
  for (const e of entries) {
    const d = dirname2(e.path);
    if (!byDir.has(d))
      byDir.set(d, []);
    byDir.get(d).push(e);
  }
  const dirs = dirOrder ? [...dirOrder.filter((d) => byDir.has(d)), ...[...byDir.keys()].filter((d) => !dirOrder.includes(d))] : [...byDir.keys()].sort();
  const out = [CODE_MARKER, ""];
  for (const d of dirs) {
    out.push(renderSectionHeader(d));
    for (const e of byDir.get(d))
      out.push(renderEntryLine(e));
    out.push("");
  }
  return out.join(`
`);
}
function validateEntry(e) {
  const tag = parseTag(e.tag);
  const q = FIELD_QUOTA[quotaBand(tag.c)];
  const out = [];
  for (const field of ["f", "r", "a", "s"]) {
    const limit = q[field];
    const actual = [...e[field]].length;
    if (actual > limit)
      out.push({ path: e.path, field, actual, limit });
  }
  return out;
}
function validateRelations(r) {
  const problems = [];
  const v = r.trim();
  if (v === "-" || v === "")
    return problems;
  for (const item of v.split(",").map((x) => x.trim())) {
    if (item === "-")
      continue;
    if (item.startsWith("code:") && item.length > 5)
      continue;
    if (item.startsWith("database://"))
      continue;
    problems.push(`R 值 "${item}" 不是合法引用形式。` + `请用 code:<仓库相对路径> 或 database://<source>/<ns>/<table>，无关系写 -`);
  }
  return problems;
}
function roundTripCheck(entries) {
  const text = renderCodeVolume(entries);
  const back = parseCodeVolume(text);
  if (back.entries.length !== entries.length) {
    throw new CosError2(`回读校验失败：写入 ${entries.length} 条，读回 ${back.entries.length} 条。路径可能含不可移植字符（如尾随空格）。`, "roundtrip_failed");
  }
  for (const e of entries) {
    const got = back.entries.find((x) => x.path === e.path);
    if (!got)
      throw new CosError2(`回读校验失败：对象 "${e.path}" 写不回来`, "roundtrip_failed");
    if (got.f !== e.f || got.r !== e.r || got.a !== e.a || got.s !== e.s) {
      throw new CosError2(`回读校验失败：对象 "${e.path}" 字段不一致`, "roundtrip_failed");
    }
  }
}
function renderRoot(project, invariants) {
  return [
    ROOT_MARKER,
    `#Format-Version: ${FORMAT_VERSION}`,
    `#Locale: zh-CN`,
    `#Project: ${project}`,
    `#Global-Invariants: ${invariants}`,
    `#Volume: id=meta kind=meta path=${META_BASENAME} format=meta-v1 depends=- state=enabled`,
    `#Volume: id=code kind=code path=${CODE_BASENAME} format=object-fras-v2 depends=meta state=enabled`,
    ""
  ].join(`
`);
}
function renderQuotaLine() {
  const bands = [["C9-8", "high"], ["C7-4", "mid"], ["C3-1", "low"]];
  return `#S quota: ${bands.map(([label, band]) => `${label}≤${FIELD_QUOTA[band].s}`).join(" ")}`;
}
function renderMeta() {
  return [
    META_MARKER,
    `#Object-Protocol: ${OBJECT_PROTOCOL}`,
    `#FRAS-Discipline: 1`,
    `#FRAS-Limits-Authority: machine-contract`,
    `#S-Admission: non-inferable-and-error-preventing`,
    renderQuotaLine(),
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
    ""
  ].join(`
`);
}
var ENTRY_RE;
var init_format = __esm(() => {
  init_core();
  ENTRY_RE = /^(.+?)\[([A-Z][A-Z][1-9](?:[A-Z])?[LMST])\]:\s*F:(.*?)\s*\|\s*R:(.*?)\s*\|\s*A:(.*?)\s*\|\s*S:(.*)$/;
});

// src/repo.ts
import { join as join3, resolve as resolve2, sep as sep2, dirname as dirname4 } from "node:path";
import { spawnSync } from "node:child_process";
import {
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  readdirSync as readdirSync2,
  statSync as statSync2,
  rmSync as rmSync2,
  readFileSync as readFileSync3,
  writeFileSync as writeFileSync2,
  renameSync as renameSync2,
  openSync as openSync2,
  readSync as readSync2,
  closeSync as closeSync2
} from "node:fs";
function isGitRepo(root) {
  return existsSync2(join3(root, ".git"));
}
function dataDirAbs(root) {
  return join3(root, DATA_DIR2);
}
function defaultConfig() {
  return {
    version: 1,
    excludeDirs: [...DEFAULT_EXCLUDE_DIRS],
    chunkTokens: CHUNK_TOKENS_DEFAULT,
    scopeRules: [
      { action: "exclude", pattern: "**/*.lock", reason: "锁文件是生成产物，无系统语义" },
      { action: "exclude", pattern: "**/*.png", reason: "图片是二进制资产，索引无法承载语义" },
      { action: "exclude", pattern: "**/*.jpg", reason: "图片是二进制资产，索引无法承载语义" },
      { action: "observe", pattern: "**/*.json", reason: "配置与数据文件只观察变化，不逐个写 Entry" },
      { action: "observe", pattern: "**/*.md", reason: "文档正文由人工维护，只观察字节变化" }
    ]
  };
}
function readConfig(root) {
  const p = join3(root, CONFIG_PATH2);
  if (!existsSync2(p))
    throw new CosError2(`未初始化：缺少 ${CONFIG_PATH2}。先运行 cos init`, "not_initialized");
  const raw = JSON.parse(readText(p));
  const OBSOLETE = ["locale", "indexPath", "refreshThreshold"];
  const stale = OBSOLETE.filter((k) => (k in raw));
  if (stale.length > 0) {
    process.stderr.write(`[cos] 警告：${CONFIG_PATH2} 里的 ${stale.join(" / ")} 已废弃且从未生效，可以删掉。` + `（真实生效的配置只有 excludeDirs / chunkTokens / scopeRules）
`);
    for (const k of stale)
      delete raw[k];
  }
  return { ...defaultConfig(), ...raw };
}
function writeConfig(root, cfg) {
  mkdirSync2(dataDirAbs(root), { recursive: true });
  writeAtomic(join3(root, CONFIG_PATH2), JSON.stringify(cfg, null, 2) + `
`);
}
function readText(p) {
  return readFileSync3(p, "utf8");
}
function fileBytes(p) {
  return new Uint8Array(readFileSync3(p));
}
function writeAtomic(p, content) {
  const dir = dirname4(p);
  mkdirSync2(dir === "" ? "." : dir, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync2(tmp, content, "utf8");
    renameSync2(tmp, p);
  } catch (err) {
    try {
      rmSync2(tmp, { force: true });
    } catch {}
    throw err;
  }
}
function assertRepoRelativePath(p) {
  if (isSafeRepoRelative(p))
    return;
  if (!p)
    throw new CosError2(`对象路径不能为空`, "bad_path");
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) {
    throw new CosError2(`对象路径 "${p}" 必须是仓库相对路径，不能是绝对路径`, "bad_path");
  }
  throw new CosError2(`对象路径 "${p}" 不能包含 ..`, "bad_path");
}
function isSafeRepoRelative(p) {
  if (!p)
    return false;
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p))
    return false;
  if (p.split("/").some((seg) => seg === ".."))
    return false;
  return true;
}
function fileSha(p) {
  if (!existsSync2(p))
    return null;
  try {
    return sha256(fileBytes(p));
  } catch {
    return null;
  }
}
function listGitFiles(root) {
  if (!isGitRepo(root))
    return null;
  const proc = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024
  });
  if (proc.error || proc.status !== 0 || !proc.stdout)
    return null;
  return proc.stdout.toString("utf8").split("\x00").filter(Boolean);
}
function listFsFiles(root, excludeDirs) {
  const out = [];
  const skip = new Set(excludeDirs);
  const walk = (dir) => {
    let items;
    try {
      items = readdirSync2(join3(root, dir));
    } catch {
      return;
    }
    for (const name of items) {
      const rel = dir ? `${dir}/${name}` : name;
      let st;
      try {
        st = statSync2(join3(root, rel));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!skip.has(name))
          walk(rel);
      } else if (st.isFile()) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out;
}
function globToRe(pattern) {
  const cached = globCache2.get(pattern);
  if (cached)
    return cached;
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (pattern[i] === "/")
        i++;
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
  globCache2.set(pattern, compiled);
  return compiled;
}
function resolveRole(path, cfg) {
  if (path === DATA_DIR2 || path.startsWith(DATA_DIR2 + "/"))
    return "exclude";
  if (path === "AGENTS.md")
    return "index";
  for (const rule of cfg.scopeRules) {
    if (globToRe(rule.pattern).test(path))
      return rule.action;
  }
  const top = path.split("/")[0];
  if (cfg.excludeDirs.includes(top))
    return "exclude";
  if (cfg.excludeDirs.includes(path))
    return "exclude";
  return "index";
}
function isIndexableSource(root, path) {
  const full = join3(root, path);
  let st;
  try {
    st = statSync2(full);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (st.size === 0)
    return { ok: false, reason: "empty" };
  if (st.size > MAX_FILE_BYTES2)
    return { ok: false, reason: "oversize" };
  if (isBinary(readHead(full, 8000)))
    return { ok: false, reason: "binary" };
  return { ok: true };
}
function readHead(fullPath, bytes) {
  try {
    const fd = openSync2(fullPath, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const n = readSync2(fd, buf, 0, bytes, 0);
      return new Uint8Array(buf.subarray(0, n));
    } finally {
      closeSync2(fd);
    }
  } catch {
    return new Uint8Array(0);
  }
}
function emptyBaseline() {
  return { version: 2, stamps: {}, entries: {}, source: {}, updatedAt: nowIso() };
}
function readBaseline(root) {
  const p = join3(root, BASELINE_PATH2);
  if (!existsSync2(p))
    return emptyBaseline();
  try {
    const raw = JSON.parse(readText(p));
    const base = emptyBaseline();
    const stamps = { ...base.stamps };
    const legacyFiles = raw.files;
    if (legacyFiles && typeof legacyFiles === "object") {
      for (const [path, sha] of Object.entries(legacyFiles)) {
        if (typeof sha === "string")
          stamps[path] = { sha, size: -1, mtimeMs: -1 };
      }
    }
    const rawStamps = raw.stamps;
    if (rawStamps && typeof rawStamps === "object")
      Object.assign(stamps, rawStamps);
    return {
      version: 2,
      stamps,
      entries: raw.entries ?? {},
      source: raw.source ?? {},
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso()
    };
  } catch {
    throw new CosError2(`${BASELINE_PATH2} 损坏，无法解析`, "bad_baseline");
  }
}
function stampFile(fullPath) {
  try {
    const st = statSync2(fullPath);
    return { sha: sha256(fileBytes(fullPath)), size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}
function fileChanged(fullPath, prev) {
  let st;
  try {
    st = statSync2(fullPath);
  } catch {
    return true;
  }
  if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.size >= 0) {
    return false;
  }
  const cur = fileSha(fullPath);
  return cur === null || !prev || prev.sha !== cur;
}
function writeBaseline(root, b) {
  b.updatedAt = nowIso();
  mkdirSync2(dataDirAbs(root), { recursive: true });
  writeAtomic(join3(root, BASELINE_PATH2), JSON.stringify(b, null, 2) + `
`);
}
function loadState(root) {
  const cfg = readConfig(root);
  const rootP = join3(root, INDEX_PATH2);
  const metaP = join3(root, META_PATH2);
  const codeP = join3(root, CODE_PATH2);
  if (!existsSync2(rootP))
    throw new CosError2(`缺少 ${INDEX_PATH2}，先运行 cos init`, "not_initialized");
  if (!existsSync2(metaP))
    throw new CosError2(`缺少 ${META_PATH2}（Root 声明了它但不存在），CognitionSet 失败关闭`, "missing_volume");
  const rootText = readText(rootP);
  const metaText = readText(metaP);
  const codeText = existsSync2(codeP) ? readText(codeP) : "";
  const doc = parseCodeVolume(codeText);
  const unsafe = doc.entries.filter((e) => !isSafeRepoRelative(e.path));
  if (unsafe.length > 0) {
    throw new CosError2(`${CODE_PATH2} 里有 ${unsafe.length} 条 Entry 的路径不是仓库相对路径：` + unsafe.slice(0, 5).map((e) => `
  ${e.path}`).join("") + `
绝对路径或以 .. 开头的路径会让索引指到仓库外。请改回仓库相对路径。`, "unsafe_entry_path");
  }
  return {
    root,
    cfg,
    rootText,
    metaText,
    codeText,
    entries: doc.entries,
    dirOrder: doc.order,
    malformed: doc.malformed,
    baseline: readBaseline(root)
  };
}
function collectFacts(state) {
  const { root, cfg, entries, baseline } = state;
  const drift = [];
  const gitFiles = listGitFiles(root);
  const allFiles = gitFiles ?? listFsFiles(root, cfg.excludeDirs);
  const entryByPath = new Map(entries.map((e) => [e.path, e]));
  const isCognitionAsset = (p) => p === INDEX_PATH2 || p === META_PATH2 || p === CODE_PATH2;
  const indexable = new Set;
  for (const f of allFiles) {
    if (f.startsWith(DATA_DIR2 + "/"))
      continue;
    if (isCognitionAsset(f))
      continue;
    if (resolveRole(f, cfg) !== "index")
      continue;
    if (entryByPath.has(f)) {
      indexable.add(f);
      continue;
    }
    if (!isIndexableSource(root, f).ok)
      continue;
    indexable.add(f);
  }
  for (const bad of state.malformed) {
    drift.push({ kind: "malformed", path: `L${bad.line}: ${bad.text}` });
  }
  for (const e of entries) {
    if (!existsSync2(join3(root, e.path)))
      drift.push({ kind: "missing", path: e.path });
  }
  for (const e of entries) {
    if (!existsSync2(join3(root, e.path)))
      continue;
    if (resolveRole(e.path, cfg) !== "index")
      drift.push({ kind: "orphan", path: e.path });
  }
  for (const e of entries) {
    const full = join3(root, e.path);
    if (!existsSync2(full))
      continue;
    const prev = baseline.stamps[e.path];
    if (prev && fileChanged(full, prev)) {
      drift.push({ kind: "stale", path: e.path });
    }
  }
  for (const f of indexable) {
    if (!baseline.stamps[f])
      drift.push({ kind: "unbaselined", path: f });
  }
  for (const e of entries) {
    if (!baseline.entries[e.path])
      drift.push({ kind: "unbaselined", path: e.path });
  }
  const seen = new Set;
  const dedup = drift.filter((d) => {
    const k = `${d.kind}:${d.path}`;
    if (seen.has(k))
      return false;
    seen.add(k);
    return true;
  });
  const needAuthoring = [...indexable].filter((p) => !entryByPath.has(p)).sort();
  const needRemoval = [
    ...entries.filter((e) => !existsSync2(join3(root, e.path))).map((e) => e.path),
    ...entries.filter((e) => existsSync2(join3(root, e.path)) && resolveRole(e.path, cfg) !== "index").map((e) => e.path)
  ].sort();
  const quotaViolations = entries.flatMap((e) => validateEntry(e));
  const tokens = estimateTokens(state.rootText + state.metaText + state.codeText);
  const hasBaseline = Object.keys(baseline.stamps).length > 0;
  let alignment = "aligned";
  if (tokens > WHOLE_INDEX_BUDGET.max)
    alignment = "budget_exceeded";
  else if (!hasBaseline)
    alignment = "unbaselined";
  else if (state.malformed.length > 0)
    alignment = "authoring_required";
  else if (needAuthoring.length > 0)
    alignment = "authoring_required";
  else if (needRemoval.length > 0)
    alignment = "authoring_required";
  else if (dedup.some((d) => d.kind === "stale"))
    alignment = "authoring_required";
  else if (quotaViolations.length > 0)
    alignment = "authoring_required";
  return {
    drift: dedup,
    alignment,
    entries: entries.length,
    files: indexable.size,
    tokens,
    quotaViolations,
    needAuthoring,
    needRemoval,
    hasBaseline
  };
}
function commitEntries(state, upserts, removals, expectSha) {
  const { root } = state;
  const codeP = join3(root, CODE_PATH2);
  const currentSha = existsSync2(codeP) ? sha256(readText(codeP)) : null;
  if (state.malformed.length > 0) {
    throw new CosError2(`${CODE_PATH2} 有 ${state.malformed.length} 行无法解析成 Entry，重写会永久丢掉它们。` + `请先手工修复这些行：` + state.malformed.slice(0, 5).map((m) => `
  L${m.line}: ${m.text}`).join("") + (state.malformed.length > 5 ? `
  …… 还有 ${state.malformed.length - 5} 行` : "") + `
（合法行只有三类：注释 / ===/<repository>/<dir>/=== / name[TAG]: F:.. | R:.. | A:.. | S:..）`, "malformed_volume");
  }
  const snapshotSha = state.codeText === "" && currentSha === null ? null : sha256(state.codeText);
  if (snapshotSha !== currentSha) {
    throw new CosError2(`CAS 失败：${CODE_PATH2} 在你读取之后被改动过（快照 ${(snapshotSha ?? "空").slice(0, 12)}，` + `磁盘 ${(currentSha ?? "空").slice(0, 12)}）。请重新读取后再写。`, "cas_conflict");
  }
  if (expectSha !== null && currentSha !== expectSha) {
    throw new CosError2(`CAS 失败：${CODE_PATH2} 已被修改，请重新读取后再写`, "cas_conflict");
  }
  for (const e of upserts) {
    assertRepoRelativePath(e.path);
    const problems = validateRelations(e.r);
    if (problems.length)
      throw new CosError2(`${e.path}: ${problems.join("; ")}`, "bad_relation");
    const viol = validateEntry(e);
    if (viol.length) {
      throw new CosError2(`${e.path}: 配额超限 ` + viol.map((v) => `${v.field} ${v.actual}>${v.limit}`).join(", ") + `。S 字段两问：能推断的不写，删了不出事的不写 —— 请收紧而不是放宽上限。`, "quota_exceeded");
    }
  }
  for (const p of removals)
    assertRepoRelativePath(p);
  const removalSet = new Set(removals);
  const upsertMap = new Map(upserts.map((e) => [e.path, e]));
  const next = [];
  for (const e of state.entries) {
    if (removalSet.has(e.path))
      continue;
    next.push(upsertMap.get(e.path) ?? e);
    upsertMap.delete(e.path);
  }
  for (const [, e] of upsertMap)
    next.push(e);
  roundTripCheck(next);
  const text = renderCodeVolume(next, state.dirOrder);
  writeAtomic(codeP, text);
  const baseline = readBaseline(root);
  for (const e of next) {
    const full = join3(root, e.path);
    if (existsSync2(full)) {
      const stamp = stampFile(full);
      if (stamp)
        baseline.stamps[e.path] = stamp;
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
function initRepo(root, force) {
  const created = [];
  const rootP = join3(root, INDEX_PATH2);
  if (existsSync2(rootP) && !force) {
    throw new CosError2(`${INDEX_PATH2} 已存在。用 --force 覆盖（会清空已有认知）。`, "already_initialized");
  }
  const project = root.split(sep2).pop() ?? "project";
  const invariants = "语义只由宿主模型创作，程序绝不生成、预填或判断；" + "写入前必须能读回自己写的字节，否则整批拒绝；" + "S 字段两问准入：能推断的不写，删了不出事的不写；" + "配额上限在程序里，改索引文本放宽不了";
  const files = [
    [INDEX_PATH2, renderRoot(project, invariants)],
    [META_PATH2, renderMeta()],
    [CODE_PATH2, `#COS-CODE-VOLUME: 1

===/<repository>/===
`]
  ];
  for (const [p, content] of files) {
    writeAtomic(join3(root, p), content);
    created.push(p);
  }
  writeConfig(root, defaultConfig());
  created.push(CONFIG_PATH2);
  const baselineP = join3(root, BASELINE_PATH2);
  if (force || !existsSync2(baselineP)) {
    writeBaseline(root, emptyBaseline());
    created.push(BASELINE_PATH2);
  }
  const agentsP = join3(root, "AGENTS.md");
  const existing = existsSync2(agentsP) ? readText(agentsP) : "";
  const block = renderAgentsBlock(project);
  writeAtomic(agentsP, upsertBlock(existing, block));
  created.push("AGENTS.md");
  const giP = join3(root, ".gitignore");
  const gi = existsSync2(giP) ? readText(giP) : "";
  const need = [`${DATA_DIR2}/*.tmp-*`, ".mcp.json", ".claude/settings.local.json"];
  const lines = gi.split(/\r?\n/);
  const missing = need.filter((n) => !lines.includes(n));
  if (missing.length) {
    writeAtomic(giP, gi + (gi.endsWith(`
`) || gi === "" ? "" : `
`) + `# cos
` + missing.join(`
`) + `
`);
    created.push(".gitignore");
  }
  return { created };
}
function scanRepo(root, force) {
  const cfg = readConfig(root);
  const state = loadState(root);
  const baseline = readBaseline(root);
  if (Object.keys(baseline.stamps).length > 0 && !force) {
    throw new CosError2(`基线已存在（${Object.keys(baseline.stamps).length} 个文件）。` + `新增/移除受管范围请改 ${CONFIG_PATH2} 的 scopeRules，而不是 scan --force。` + `只想刷新指纹用 cos_update 重提交，或 scan --force 明确重建。`, "baseline_exists");
  }
  const gitFiles = listGitFiles(root);
  const allFiles = gitFiles ?? listFsFiles(root, cfg.excludeDirs);
  let n = 0;
  for (const f of allFiles) {
    if (f.startsWith(DATA_DIR2 + "/"))
      continue;
    const role = resolveRole(f, cfg);
    if (role === "exclude")
      continue;
    const full = join3(root, f);
    if (!existsSync2(full))
      continue;
    try {
      const stamp = stampFile(full);
      if (stamp)
        baseline.stamps[f] = stamp;
      baseline.source[f] = role === "index" ? "indexed" : "observed";
      n++;
    } catch {}
  }
  for (const e of state.entries) {
    baseline.entries[e.path] = sha256(JSON.stringify(e));
  }
  writeBaseline(root, baseline);
  return { files: n, entries: state.entries.length };
}
function renderAgentsBlock(project) {
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
function upsertBlock(existing, block) {
  const s = existing.indexOf(BLOCK_START);
  if (s < 0) {
    const sep3 = existing === "" ? "" : existing.endsWith(`
`) ? `
` : `

`;
    return existing + sep3 + block + `
`;
  }
  const e = existing.indexOf(BLOCK_END, s);
  if (e > s) {
    return existing.slice(0, s) + block + existing.slice(e + BLOCK_END.length);
  }
  const head = existing.slice(0, s).replace(/\n+$/, "");
  return (head === "" ? "" : head + `

`) + block + `
`;
}
var globCache2, BLOCK_START = "<!-- cos:rules:start -->", BLOCK_END = "<!-- cos:rules:end -->";
var init_repo = __esm(() => {
  init_core();
  init_format();
  globCache2 = new Map;
});

// src/version.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname5, join as join5 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function readVersion2() {
  const candidates = [];
  const bunDir = import.meta.dir;
  if (typeof bunDir === "string" && bunDir)
    candidates.push(bunDir);
  try {
    candidates.push(dirname5(fileURLToPath2(import.meta.url)));
  } catch {}
  for (const start of candidates) {
    let dir = start;
    for (let i = 0;i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync4(join5(dir, "package.json"), "utf8"));
        if (typeof pkg.version === "string" && pkg.version)
          return pkg.version;
      } catch {}
      const parent = dirname5(dir);
      if (parent === dir)
        break;
      dir = parent;
    }
  }
  return "unknown";
}
var VERSION2;
var init_version = __esm(() => {
  VERSION2 = readVersion2();
});

// src/mcp.ts
var exports_mcp = {};
__export(exports_mcp, {
  runMcpServer: () => runMcpServer
});
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
function log(...args) {
  process.stderr.write(`[cos] ${args.join(" ")}
`);
}
function notInitializedHint(problem) {
  return [
    `not_initialized: ${problem}`,
    ``,
    `这条错误说明 MCP server 已正常连接，只是找不到要操作的仓库。常见原因：`,
    `  1. 项目还没初始化 → 在项目根目录运行 cos init`,
    `  2. 宿主启动 server 时 cwd 不在项目内 → 在 MCP 配置里加 "--repo", "<绝对路径>"`,
    `  3. 换项目后没重启 Agent → 重启当前会话`,
    `可以先调 cos_rules 看完整使用方法。`
  ].join(`
`);
}
async function runMcpServer(resolveRoot, tools, fixedRoot = null) {
  let initialInfo;
  try {
    initialInfo = resolveRoot();
  } catch (err) {
    initialInfo = `未定位到仓库（${err.message.split(`
`)[0]}）`;
  }
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} }
  });
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (rawArgs) => {
      let root = "";
      let problem = null;
      if (tool.needsRepo !== false) {
        try {
          root = resolveRoot();
        } catch (err) {
          problem = err.message;
        }
      }
      if (problem !== null) {
        return {
          isError: true,
          content: [{ type: "text", text: notInitializedHint(problem) }]
        };
      }
      try {
        const out = await tool.handler(rawArgs ?? {}, { root, fixedRoot });
        return {
          content: [{
            type: "text",
            text: typeof out === "string" ? out : JSON.stringify(out, null, 2)
          }]
        };
      } catch (err) {
        const e = err;
        return {
          isError: true,
          content: [{ type: "text", text: `${e.code ?? "error"}: ${e.message}` }]
        };
      }
    });
  }
  const transport = new StdioServerTransport;
  await server.connect(transport);
  log((fixedRoot ? `stdio server ready, repo=${initialInfo} (固定 --repo)` : `stdio server ready, repo=${initialInfo} (每次调用重新解析)`) + `, tools=${tools.length}`);
}
var SERVER_INFO;
var init_mcp = __esm(() => {
  init_version();
  SERVER_INFO = { name: "cos", version: VERSION2 };
});

// src/tools.ts
var exports_tools = {};
__export(exports_tools, {
  chunkOverview: () => chunkOverview,
  TOOLS: () => TOOLS,
  RULES: () => RULES
});
import { join as join6 } from "node:path";
import { existsSync as existsSync3 } from "node:fs";
import { z } from "zod";
function renderQuotaTable() {
  const bands = [["9-8", "high"], ["7-4", "mid"], ["3-1", "low"]];
  return [
    "| C 重要度 | F | R | A | S |",
    "|---|---|---|---|---|",
    ...bands.map(([label, band]) => {
      const q = FIELD_QUOTA[band];
      return `| ${label} | ${q.f} | ${q.r} | ${q.a} | ${q.s} |`;
    })
  ].join(`
`);
}
function buildOverviewText(state) {
  return [
    "<!-- cos:overview:start -->",
    state.rootText.trimEnd(),
    "",
    state.metaText.trimEnd(),
    "",
    state.codeText.trimEnd(),
    "<!-- cos:overview:end -->"
  ].join(`
`);
}
function chunkOverview(text, chunkTokens) {
  const tokens = estimateTokens(text);
  if (tokens <= chunkTokens)
    return { chunks: [text], tokens };
  const chunks = [];
  let cur = [];
  let curTokens = 0;
  for (const line of text.split(`
`)) {
    const lineTokens = estimateTokens(line);
    if (lineTokens > chunkTokens) {
      if (cur.length > 0) {
        chunks.push(cur.join(`
`));
        cur = [];
        curTokens = 0;
      }
      for (const piece of splitByBytes(line, Math.max(1, Math.ceil(Buffer.byteLength(line, "utf8") / lineTokens * chunkTokens)))) {
        chunks.push(piece);
      }
      continue;
    }
    if (curTokens + lineTokens > chunkTokens && cur.length > 0) {
      chunks.push(cur.join(`
`));
      cur = [];
      curTokens = 0;
    }
    cur.push(line);
    curTokens += lineTokens;
  }
  if (cur.length > 0)
    chunks.push(cur.join(`
`));
  return { chunks, tokens };
}
function clampChunk(n) {
  if (!Number.isFinite(n))
    return 7000;
  return Math.max(CHUNK_TOKENS_MIN, Math.min(CHUNK_TOKENS_MAX, Math.floor(n)));
}
function parseCursor(cursor, expectSha) {
  const [idxStr, sha] = cursor.split(":");
  if (sha && sha !== expectSha) {
    throw new CosError2(`cursor 失效：索引在交付期间被修改（cursor sha=${sha}，当前 sha=${expectSha}）。` + `请不带 cursor 重新调 cos_overview。`, "cursor_stale");
  }
  const n = Number(idxStr);
  if (!Number.isInteger(n) || n < 0)
    throw new CosError2(`非法 cursor "${cursor}"`, "bad_cursor");
  return n;
}
function formatEntry(e) {
  return `${e.path}[${e.tag}]: F:${e.f} | R:${e.r} | A:${e.a} | S:${e.s}`;
}
function suggestTag(path) {
  for (const k of KEY_WORDS)
    if (k.re.test(path))
      return `${k.a}${k.b}5M`;
  return "CG5M";
}
function extractHeaderLines(text) {
  return text.split(/\r?\n/).filter((l) => l.startsWith("#")).slice(0, 12);
}
var RULES_TEXT, rulesTool, overviewTool, searchTool, KEY_WORDS, maintainTool, updateTool, reportTool, TOOLS, RULES;
var init_tools = __esm(() => {
  init_core();
  init_format();
  init_repo();
  RULES_TEXT = `# cos 会话合同

## 你面对的是什么

本仓库维护一份**认知索引**：模型为每个受管文件手写一行，说明它是什么、
和谁强关联、对外契约是什么、什么不能改坏。索引存在 Git 里，跨会话、跨 Agent 复用。

所有数据集中在仓库的 \`.codebase_store/\` 目录：

\`\`\`
.codebase_store/
├── cos.txt          Root：声明 Volume、项目定位、全局不变量
├── cos.meta.txt     Meta：标签字典、FRAS 规则、配额、创作约束
├── cos.code.txt     Code Volume：代码对象的 Entry（真正的内容在这里）
├── config.json      scope 规则、分块预算、刷新阈值
└── baseline.json    源码与 Entry 的指纹基线
\`\`\`

这个目录**不要手改**：\`cos.code.txt\` 只能通过 \`cos_update\` 写，程序会做配额、
引用、回读校验。\`config.json\` 可以手改（改 scope 规则是合法操作）。

**这不是检索工具。开工前先读完索引，之后不要再 grep 整个代码库。**

## 必读流程

1. 新会话开始：\`cos_overview\` 读完整索引。
   - 返回 \`nextCursor\` 时，必须顺链读到最后一个 chunk 才能声称"已读完"。
   - \`checkOnly=true\` 只是紧凑检查点，**不能替代**完整读取。
2. 干活：按索引里的 F/R/A/S 定位文件，用常规工具读源码。
3. 收工前：代码与测试稳定后调用 \`cos_maintain\`，按 \`nextAction\` 处理。

## 语义只能由你写（硬性）

程序**不会**替你生成、预填、摘要、压缩、补全 F/R/A/S。
「机器先出草稿，模型再润色」也被禁止 —— 那会让索引变成看起来合理但不可信的文本。

## FRAS 写作规范

| 字段 | 该写什么 | 不该写什么 |
|---|---|---|
| **F** Function | 一个核心职责**命题** | 功能清单、能力罗列 |
| **R** Relations | 理解或安全修改它**必须一起看**的强关系 | 完整依赖图、所有 import |
| **A** API | 稳定的、外部可依赖的契约 | 所有方法/字段/调用方 |
| **S** Non-obvious | 不可推断且删了会出事的约束 | 摘要、F/R/A 的重复 |

### S 字段的两问准入（每句话都要同时通过）

1. 能否从对象名、标签、F、R、A 直接推断？→ **能就不许写**
2. 删掉它会不会导致模型改错代码/数据/生命周期？→ **不会就不许写**

不合格的 S：「这是一个工具函数」「用于处理字符串」。
合格的 S：「失败时必须保留原始文件，不能降级为覆盖式重命名」、
「MySQL 5.7.6+，不支持 MariaDB」、「这个块由模板渲染，手改会被覆盖」。

### 配额（程序强制，改索引文本放宽不了）

${renderQuotaTable()}

超限会被拒。**正确做法是收紧内容，不是拆词凑数。**

### R 字段的合法形式

\`code:<仓库相对路径>\` 或 \`database://<source>/<ns>/<table>\`，逗号分隔，无关系写 \`-\`。
唯一裸文件名**不是**写别名，不会被静默补全。

## 标签（紧凑形态 A+B+C+[D]+E）

- A 架构层：C共享基础 E入口边界 A应用编排 D领域逻辑 K算法计算 M中间件 P持久化
  I集成适配 R运行基础 L库与SDK F声明配置 O运维交付 T测试验证 S文档规范 X开发工具 Z其他
- B 功能域：G跨域通用 U用户交互 B核心业务 D数据状态 I身份权限 N网络协议 M消息事件
  S安全隐私 C配置策略 O可观测性 R可靠性恢复 P性能资源 W流程调度 A分析智能
  H硬件设备 L本地化 V构建发布 Q质量保障 E扩展插件 Z其他
- C 重要度：9最高 8很高 7高 6较高 5中等 4较低 3低 2很低 1最低
- E 规模：L>400行 M200-400 S100-200 T<100

选 C 要有依据：9 = 挂了整个系统不可用；7 = 核心业务；5 = 常规；
3 = 支撑；1 = 边缘。**不要全打 9。**

## 禁止事项

- 禁止用 grep / 读源码冒充"已读索引"
- 禁止在上下文压缩后不复读索引就继续声称掌握系统
- 禁止把索引正文或摘要塞进 handoff（只留"请重载"指令）
- 禁止绕过 \`cos_update\` 直接编辑 \`.codebase_store/cos.code.txt\`（手改会被 CAS 冲突挡下）`;
  rulesTool = {
    name: "cos_rules",
    description: "返回会话合同：怎么用这套索引、F/R/A/S 怎么写、配额是多少、什么是禁止的。" + "新会话开始时先读一次。和 aoci_rules 同名同义。",
    inputSchema: {},
    needsRepo: false,
    handler: () => RULES_TEXT
  };
  overviewTool = {
    name: "cos_overview",
    description: "交付完整的仓库认知索引（Root + Meta + Code 三个 Volume 的原文）。" + "超预算时切成多块，必须顺 nextCursor 读到最后一个 chunk 才能声称读完。" + "checkOnly=true 返回紧凑检查点，不能替代完整读取。",
    inputSchema: {
      cursor: z.string().optional().describe("上一块返回的 nextCursor"),
      checkOnly: z.boolean().optional().describe("只返回对齐状态等紧凑检查点，不返回索引正文"),
      chunkTokens: z.number().int().min(CHUNK_TOKENS_MIN).max(CHUNK_TOKENS_MAX).optional().describe(`每块 token 预算，默认取配置，范围 ${CHUNK_TOKENS_MIN}~${CHUNK_TOKENS_MAX}`)
    },
    handler: (args, ctx) => {
      const state = loadState(ctx.root);
      const cfg = state.cfg;
      if (args.checkOnly === true) {
        const facts = collectFacts(state);
        return {
          checkOnly: true,
          alignment: facts.alignment,
          entries: facts.entries,
          files: facts.files,
          tokens: facts.tokens,
          driftCount: facts.drift.length,
          quotaViolations: facts.quotaViolations.length,
          note: "这是紧凑检查点。需要接手开发时请不带 checkOnly 调 cos_overview 读完整索引。"
        };
      }
      const chunkTokens = clampChunk(args.chunkTokens ?? cfg.chunkTokens);
      const text = buildOverviewText(state);
      const { chunks, tokens } = chunkOverview(text, chunkTokens);
      const textSha = sha256(text).slice(0, 12);
      const startIdx = args.cursor ? parseCursor(args.cursor, textSha) : 0;
      const idx = Math.min(startIdx, chunks.length - 1);
      const nextCursor = idx + 1 < chunks.length ? `${idx + 1}:${textSha}` : null;
      const result = {
        cursor: `${idx}:${textSha}`,
        nextCursor,
        chunkIndex: idx,
        chunkTotal: chunks.length,
        content: chunks[idx],
        tokens: estimateTokens(chunks[idx]),
        wholeIndexTokens: tokens,
        budget: WHOLE_INDEX_BUDGET
      };
      if (nextCursor) {
        result.entries = state.entries.length;
        result.hint = `还有 ${chunks.length - idx - 1} 块。用 cursor="${nextCursor}" 继续读，读到最后一块才算读完。`;
      } else {
        const facts = collectFacts(state);
        result.entries = facts.entries;
        result.alignment = facts.alignment;
        result.files = facts.files;
        result.needAuthoring = facts.needAuthoring.length;
        result.needRemoval = facts.needRemoval.length;
        result.complete = true;
        result.hint = "这是最后一块。你现在持有完整索引。";
      }
      return result;
    }
  };
  searchTool = {
    name: "cos_search",
    description: "在索引里检索。传 path 精确取单个对象的 Entry；传 query 在 F/R/A/S 与路径上做全文匹配。" + "这不是代码搜索 —— 它只查认知索引，不读源码。",
    inputSchema: {
      path: z.string().optional().describe("仓库相对路径，精确取一条 Entry"),
      query: z.string().optional().describe("全文关键词，匹配路径与 F/R/A/S"),
      tag: z.string().optional().describe("按标签前缀过滤，如 C 或 CG9"),
      limit: z.number().int().min(1).max(200).optional().describe("最多返回条数，默认 20")
    },
    handler: (args, ctx) => {
      const state = loadState(ctx.root);
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, args.limit)) : 20;
      if (typeof args.path === "string") {
        const hit = state.entries.find((e) => e.path === args.path);
        if (!hit) {
          return { found: false, path: args.path, hint: "该对象还没有 Entry。用 cos_maintain 看它是否在待补列表里。" };
        }
        return { found: true, entry: hit, formatted: formatEntry(hit) };
      }
      let pool = state.entries;
      if (typeof args.tag === "string" && args.tag) {
        const t = args.tag.trim();
        pool = pool.filter((e) => e.tag.startsWith(t));
      }
      if (typeof args.query === "string" && args.query.trim()) {
        const q = args.query.trim().toLowerCase();
        pool = pool.filter((e) => e.path.toLowerCase().includes(q) || e.f.toLowerCase().includes(q) || e.r.toLowerCase().includes(q) || e.a.toLowerCase().includes(q) || e.s.toLowerCase().includes(q));
      }
      return {
        total: pool.length,
        returned: Math.min(pool.length, limit),
        entries: pool.slice(0, limit).map((e) => ({ ...e, formatted: formatEntry(e) })),
        ...pool.length > limit ? { hint: `还有 ${pool.length - limit} 条，用 limit 或加 query 收窄` } : {}
      };
    }
  };
  KEY_WORDS = [
    { re: /(^|\/)(package\.json|tsconfig|go\.mod|Cargo\.toml|pyproject)/i, a: "F", b: "C" },
    { re: /(^|\/)(Dockerfile|Makefile|\.github\/)/i, a: "O", b: "V" },
    { re: /(^|\/)(test|spec|__tests__)/i, a: "T", b: "Q" },
    { re: /\.(test|spec)\.[a-z]+$/i, a: "T", b: "Q" },
    { re: /(^|\/)(auth|login|session|token|permission)/i, a: "I", b: "I" },
    { re: /(^|\/)(api|route|handler|controller)/i, a: "E", b: "N" },
    { re: /(^|\/)(db|model|schema|migration|repository)/i, a: "P", b: "D" },
    { re: /(^|\/)(config|settings|env)/i, a: "F", b: "C" },
    { re: /(^|\/)(util|common|shared|helper)/i, a: "C", b: "G" }
  ];
  maintainTool = {
    name: "cos_maintain",
    description: "无参数调用：服务器算出当前该做什么，返回 nextAction。这是权威状态机的唯一入口 —— " + "不要在脚本里复制它。按 nextAction 行动后再调一次拿下一批。",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe("本批最多返回多少个待补对象，默认 10")
    },
    handler: (args, ctx) => {
      const state = loadState(ctx.root);
      const facts = collectFacts(state);
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, args.limit)) : 10;
      const entryByPath = new Map(state.entries.map((e) => [e.path, e]));
      const stale = facts.drift.filter((d) => d.kind === "stale").map((d) => d.path);
      if (state.malformed.length > 0) {
        return {
          nextAction: "repair_required",
          phase: "malformed_volume",
          message: `索引里有 ${state.malformed.length} 行无法解析成 Entry。` + `在修好之前 cos_update 会拒绝写入（重写会把它们永久抹掉）。`,
          targets: state.malformed.slice(0, limit).map((m) => ({
            line: m.line,
            text: m.text,
            action: "repair_or_delete"
          })),
          remaining: Math.max(0, state.malformed.length - limit),
          hint: `合法行只有三类：注释（# 开头）、目录段头（===/<repository>/<dir>/===）、` + `Entry（name[TAG]: F:.. | R:.. | A:.. | S:..）。` + `请手工修正这一行，或确认它已无用后整行删除。`
        };
      }
      if (facts.needRemoval.length > 0) {
        const batch = facts.needRemoval.slice(0, limit);
        return {
          nextAction: "authoring_required",
          phase: "removal",
          message: `有 ${facts.needRemoval.length} 个 Entry 已失效（文件不存在，或对象已不是 index 角色）。` + `本批 ${batch.length} 个，确认后用 removals 删除。`,
          targets: batch.map((p) => ({ path: p, action: "remove", currentEntry: entryByPath.get(p) ?? null })),
          remaining: Math.max(0, facts.needRemoval.length - limit),
          hint: "删之前确认：是对象真的不该被索引，而不是你找错文件了。"
        };
      }
      if (facts.needAuthoring.length > 0) {
        const batch = facts.needAuthoring.slice(0, limit);
        const isFirst = facts.entries === 0;
        return {
          nextAction: "authoring_required",
          phase: isFirst ? "first_index" : "incremental",
          message: isFirst ? `首次建索引。本批 ${batch.length} 个对象（共 ${facts.needAuthoring.length} 个待创作）。` + `逐个读源码后写 Entry，用 cos_update 提交。` : `有 ${facts.needAuthoring.length} 个受管文件还没有 Entry。本批 ${batch.length} 个。`,
          targets: batch.map((p) => ({
            path: p,
            suggestedTag: suggestTag(p),
            hash: fileSha(join6(ctx.root, p))?.slice(0, 12)
          })),
          remaining: Math.max(0, facts.needAuthoring.length - limit),
          contractReminder: "F 是一个核心职责命题，不是清单；S 必须过两问（能推断的不写，删了不出事的不写）。" + "只写你读过源码的对象；suggestedTag 只是依据路径的起点，必须修正。"
        };
      }
      if (stale.length > 0) {
        const batch = stale.slice(0, limit);
        return {
          nextAction: "review_required",
          phase: "stale_review",
          message: `有 ${stale.length} 个对象源码变了，Entry 可能已过期。逐个复查后决定是否更新 F/R/A/S。`,
          targets: batch.map((p) => ({ path: p, currentEntry: entryByPath.get(p) ?? null })),
          remaining: Math.max(0, stale.length - limit),
          hint: "很多改动不影响语义（格式、改名、注释）。确认无变化就用 cos_update 重提交同内容刷新基线。"
        };
      }
      if (facts.quotaViolations.length > 0) {
        return {
          nextAction: "review_required",
          phase: "quota",
          message: `有 ${facts.quotaViolations.length} 处配额超限。`,
          targets: facts.quotaViolations.slice(0, limit),
          hint: "收紧内容，不要拆词凑数。S 两问：能推断的不写，删了不出事的不写。"
        };
      }
      return {
        nextAction: "none",
        phase: "aligned",
        message: "索引与代码一致。没有待处理项。",
        facts: {
          entries: facts.entries,
          files: facts.files,
          tokens: facts.tokens,
          alignment: facts.alignment
        }
      };
    }
  };
  updateTool = {
    name: "cos_update",
    description: "写入或删除索引条目。upserts 里每条是完整 Entry（不是 patch）；" + "removals 是路径数组。会做配额校验、R 引用校验和回读校验，任一失败整批拒绝。" + "传 expectSha 做 CAS（值来自上一次 cos_overview 或 cos_report 的 codeSha）。",
    inputSchema: {
      upserts: z.array(z.object({
        path: z.string().describe("仓库相对路径"),
        tag: z.string().describe("紧凑标签 A+B+C+[D]+E，如 CG9L"),
        f: z.string().describe("Function：一个核心职责命题，不是清单"),
        r: z.string().describe("Relations：code:<path> 逗号分隔，无关系写 -"),
        a: z.string().describe("API：稳定的对外契约，无则写 -"),
        s: z.string().describe("Non-obvious：过两问才写，无则写 -")
      })).optional().describe("要写入的完整 Entry 列表（整条覆盖，不是 patch）"),
      removals: z.array(z.string()).optional().describe("要删除的对象路径"),
      expectSha: z.string().optional().describe(".codebase_store/cos.code.txt 的期望 sha256，用于 CAS（值来自 cos_report 的 codeSha）")
    },
    handler: (args, ctx) => {
      const state = loadState(ctx.root);
      const upserts = args.upserts ?? [];
      const removals = args.removals ?? [];
      const expectSha = args.expectSha ?? null;
      if (upserts.length === 0 && removals.length === 0) {
        throw new CosError2("upserts 和 removals 都是空的，没有可做的", "no_op");
      }
      for (const e of upserts) {
        const role = resolveRole(e.path, state.cfg);
        if (role !== "index") {
          throw new CosError2(`"${e.path}" 在 scope 里是 ${role} 角色，不能写正式 Entry。` + `改 .codebase_store/config.json 的 scopeRules 才能纳入索引。`, "not_indexable");
        }
        if (!existsSync3(join6(ctx.root, e.path))) {
          throw new CosError2(`"${e.path}" 不存在。Entry 必须绑定真实文件。`, "no_such_file");
        }
        try {
          parseTag(e.tag);
        } catch (err) {
          throw err;
        }
      }
      const result = commitEntries(state, upserts, removals, expectSha);
      const after = loadState(ctx.root);
      const facts = collectFacts(after);
      return {
        ok: true,
        entries: result.entries,
        codeSha: result.sha,
        alignment: facts.alignment,
        remainingDrift: facts.drift.length,
        nextStep: facts.drift.length === 0 ? "索引已对齐。可以继续开发任务。" : "还有待处理项，再调 cos_maintain 拿下一批。"
      };
    }
  };
  reportTool = {
    name: "cos_report",
    description: "治理报告：对齐状态、漂移清单、配额违规、覆盖统计、Root/Meta 头部信息、codeSha。" + "人看的摘要，也可以用来取 expectSha。",
    inputSchema: {
      verbose: z.boolean().optional().describe("包含完整漂移清单，默认只给计数")
    },
    handler: (args, ctx) => {
      const state = loadState(ctx.root);
      const facts = collectFacts(state);
      const codeSha = state.codeText ? sha256(state.codeText) : null;
      const verbose = args.verbose === true;
      const byKind = {};
      for (const d of facts.drift)
        byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      return {
        root: state.root,
        ...ctx.fixedRoot ? { rootSource: "fixed_repo" } : { rootSource: "cwd" },
        alignment: facts.alignment,
        entries: facts.entries,
        managedFiles: facts.files,
        tokens: facts.tokens,
        tokenBudget: WHOLE_INDEX_BUDGET,
        codeSha,
        drift: {
          total: facts.drift.length,
          byKind,
          ...verbose ? { items: facts.drift } : { sample: facts.drift.slice(0, 10) }
        },
        quotaViolations: {
          total: facts.quotaViolations.length,
          ...verbose ? { items: facts.quotaViolations } : {}
        },
        header: {
          root: extractHeaderLines(state.rootText),
          meta: extractHeaderLines(state.metaText)
        },
        nextAction: facts.alignment === "aligned" ? "none" : facts.entries === 0 ? "authoring_required" : facts.drift.length > 0 ? "maintain" : "review_required"
      };
    }
  };
  TOOLS = [
    rulesTool,
    overviewTool,
    searchTool,
    maintainTool,
    updateTool,
    reportTool
  ];
  RULES = RULES_TEXT;
});

// src/cli.ts
import { resolve as resolve3 } from "path";
import { existsSync as existsSync4 } from "fs";

// src/core.ts
var DATA_DIR = ".codebase_store";
var INDEX_PATH = `${DATA_DIR}/cos.txt`;
var META_PATH = `${DATA_DIR}/cos.meta.txt`;
var CODE_PATH = `${DATA_DIR}/cos.code.txt`;
var CONFIG_PATH = `${DATA_DIR}/config.json`;
var BASELINE_PATH = `${DATA_DIR}/baseline.json`;
var MAX_FILE_BYTES = 4 * 1024 * 1024;
class CosError extends Error {
  code;
  constructor(message, code = "cos_error") {
    super(message);
    this.code = code;
    this.name = "CosError";
  }
}

// src/version.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function readVersion() {
  const candidates = [];
  const bunDir = import.meta.dir;
  if (typeof bunDir === "string" && bunDir)
    candidates.push(bunDir);
  try {
    candidates.push(dirname(fileURLToPath(import.meta.url)));
  } catch {}
  for (const start of candidates) {
    let dir = start;
    for (let i = 0;i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (typeof pkg.version === "string" && pkg.version)
          return pkg.version;
      } catch {}
      const parent = dirname(dir);
      if (parent === dir)
        break;
      dir = parent;
    }
  }
  return "unknown";
}
var VERSION = readVersion();

// src/repo.ts
import { join as join2, resolve, sep, dirname as dirname3 } from "node:path";
init_core();
init_format();
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
  readFileSync as readFileSync2,
  writeFileSync,
  renameSync,
  openSync,
  readSync,
  closeSync
} from "node:fs";
function findRepoRoot(start = process.cwd()) {
  let cur = resolve(start);
  for (;; ) {
    if (existsSync(join2(cur, ".git")))
      return cur;
    const parent = resolve(cur, "..");
    if (parent === cur)
      return resolve(start);
    cur = parent;
  }
}
function isInitialized(dir) {
  return existsSync(join2(dir, DATA_DIR2, "cos.txt"));
}
function findInitializedRoot(start = process.cwd()) {
  let cur = resolve(start);
  for (;; ) {
    if (isInitialized(cur))
      return cur;
    const parent = resolve(cur, "..");
    if (parent === cur)
      return null;
    cur = parent;
  }
}
var globCache = new Map;

// src/commands.ts
init_core();
init_repo();
import { join as join4 } from "node:path";
var C = {
  dim: (s) => `\x1B[2m${s}\x1B[0m`,
  bold: (s) => `\x1B[1m${s}\x1B[0m`,
  green: (s) => `\x1B[32m${s}\x1B[0m`,
  yellow: (s) => `\x1B[33m${s}\x1B[0m`,
  red: (s) => `\x1B[31m${s}\x1B[0m`,
  cyan: (s) => `\x1B[36m${s}\x1B[0m`
};
function cmdInit(root, flags) {
  try {
    const { created } = initRepo(root, flags.force === true);
    console.log(C.green("✓") + ` 初始化完成：${root}`);
    console.log(C.dim(`  数据全部存放在 ${DATA_DIR2}/ 下（该目录应随 Git 一起提交）`));
    for (const f of created)
      console.log(`  ${C.dim("+")} ${f}`);
    console.log("");
    console.log(C.bold("下一步："));
    console.log("  1. " + C.cyan("cos scan") + "  建立基线（按 git ignore 权威枚举文件）");
    console.log("  2. 在 Agent 里加 MCP 配置（见下方片段），重启 Agent");
    console.log("  3. 对 Agent 说：" + C.cyan("「读 cos_rules，然后建立索引」"));
    console.log("");
    console.log(C.bold("MCP 配置（Claude Code: .mcp.json）"));
    console.log(C.dim(JSON.stringify({
      mcpServers: {
        cos: { command: "npx", args: ["-y", "@bysking/codebase-store", "mcp"] }
      }
    }, null, 2)));
    console.log("");
    console.log(C.dim("  没写 --repo：server 会按宿主 cwd 向上找 .codebase_store，多项目共用一份配置。"));
    console.log(C.dim('  若宿主不保证 cwd 在项目内，再显式加 "--repo", "' + root + '"。'));
    console.log(C.dim('  已全局安装的话，可把 command 改成 "cos"、args 改成 ["mcp"]。'));
    return 0;
  } catch (err) {
    return fail(err);
  }
}
function cmdScan(root, flags) {
  try {
    const r = scanRepo(root, flags.force === true);
    console.log(C.green("✓") + ` 基线建立：${r.files} 个文件，${r.entries} 条已有 Entry`);
    console.log(C.dim("  Git ignore 是文件来源的唯一权威，未追踪被忽略的文件不会进来。"));
    return 0;
  } catch (err) {
    return fail(err);
  }
}
function cmdVerify(root, flags) {
  try {
    const state = loadState(root);
    const facts = collectFacts(state);
    const pending = facts.needAuthoring.length + facts.needRemoval.length;
    const exitCode = facts.drift.length === 0 && pending === 0 ? 0 : 1;
    if (flags.json) {
      console.log(JSON.stringify({
        alignment: facts.alignment,
        drift: facts.drift,
        entries: facts.entries,
        files: facts.files,
        hasBaseline: facts.hasBaseline,
        needAuthoring: facts.needAuthoring.length,
        needRemoval: facts.needRemoval.length,
        pending
      }, null, 2));
      return exitCode;
    }
    console.log(C.bold("verify") + `  ${state.root}`);
    console.log("");
    if (facts.drift.length === 0 && pending === 0) {
      console.log(C.green("  ✓ 无漂移，无待创作项"));
      return 0;
    }
    if (facts.drift.length === 0) {
      console.log(C.green("  ✓ 无漂移"));
    }
    const groups = new Map;
    for (const d of facts.drift) {
      if (!groups.has(d.kind))
        groups.set(d.kind, []);
      groups.get(d.kind).push(d.path);
    }
    const label = {
      malformed: "Malformed（索引里有解析不了的行，写入会丢数据）",
      missing: "Missing（Entry 在，文件不在）",
      orphan: "Orphan（Entry 在，对象已不是 index 角色）",
      stale: "Stale（源码变了，Entry 未更新）",
      unbaselined: "Unbaselined（受管但未进基线）"
    };
    for (const [kind, paths] of groups) {
      console.log(C.yellow(`  ${label[kind] ?? kind}`) + C.dim(`  ${paths.length} 项`));
      for (const p of paths.slice(0, 20))
        console.log(`    ${p}`);
      if (paths.length > 20)
        console.log(C.dim(`    ... 还有 ${paths.length - 20} 项`));
      console.log("");
    }
    if (facts.needAuthoring.length > 0) {
      console.log(C.yellow("  NeedAuthoring（受管但还没有 Entry，待创作）") + C.dim(`  ${facts.needAuthoring.length} 项`));
      for (const p of facts.needAuthoring.slice(0, 20))
        console.log(`    ${p}`);
      if (facts.needAuthoring.length > 20)
        console.log(C.dim(`    ... 还有 ${facts.needAuthoring.length - 20} 项`));
      console.log(C.dim("    用 cos_maintain 拿下一批写的目标。"));
      console.log("");
    }
    if (facts.needRemoval.length > 0) {
      console.log(C.yellow("  NeedRemoval（Entry 已失效，待删除）") + C.dim(`  ${facts.needRemoval.length} 项`));
      for (const p of facts.needRemoval.slice(0, 20))
        console.log(`    ${p}`);
      if (facts.needRemoval.length > 20)
        console.log(C.dim(`    ... 还有 ${facts.needRemoval.length - 20} 项`));
      console.log("");
    }
    return exitCode;
  } catch (err) {
    return fail(err);
  }
}
function cmdCheck(root, flags) {
  try {
    const state = loadState(root);
    const facts = collectFacts(state);
    const problems = [];
    const warnings = [];
    if (facts.entries === 0)
      problems.push("索引为空：还没有任何 Entry。让 Agent 跑 cos_maintain 建索引。");
    if (facts.tokens > WHOLE_INDEX_BUDGET.max) {
      problems.push(`索引 ${facts.tokens} token 超过硬上限 ${WHOLE_INDEX_BUDGET.max}。需要裁剪或拆分。`);
    } else if (facts.tokens > WHOLE_INDEX_BUDGET.warning) {
      warnings.push(`索引 ${facts.tokens} token 已过警戒线 ${WHOLE_INDEX_BUDGET.warning}（目标 ${WHOLE_INDEX_BUDGET.target}）。` + `现在还不算失败，但该开始裁剪了。`);
    }
    for (const v of facts.quotaViolations) {
      problems.push(`配额超限 ${v.path} 的 ${v.field}：${v.actual} > ${v.limit}`);
    }
    if (facts.alignment !== "aligned") {
      problems.push(`对齐状态是 ${facts.alignment}，期望 aligned（${facts.drift.length} 项漂移，${facts.needAuthoring.length} 项待创作）`);
    }
    if (flags.json) {
      console.log(JSON.stringify({
        ok: problems.length === 0,
        alignment: facts.alignment,
        entries: facts.entries,
        files: facts.files,
        tokens: facts.tokens,
        hasBaseline: facts.hasBaseline,
        needAuthoring: facts.needAuthoring.length,
        needRemoval: facts.needRemoval.length,
        problems,
        warnings
      }, null, 2));
      return problems.length === 0 ? 0 : 1;
    }
    console.log(C.bold("check") + `  ${state.root}`);
    console.log("");
    for (const w of warnings)
      console.log(C.yellow("  ! ") + w);
    if (problems.length === 0) {
      console.log(C.green("  ✓ 通过"));
      console.log(C.dim(`    ${facts.entries} 条 Entry / ${facts.files} 个受管文件 / ${facts.tokens} token`));
      return 0;
    }
    for (const p of problems)
      console.log(C.red("  ✗ ") + p);
    return 1;
  } catch (err) {
    return fail(err);
  }
}
function cmdStatus(root) {
  try {
    const state = loadState(root);
    const facts = collectFacts(state);
    const pct = Math.round(facts.entries / Math.max(1, facts.files) * 100);
    console.log(C.bold("cos status"));
    console.log(`  仓库      ${state.root}`);
    console.log(`  对齐      ${colorAlign(facts.alignment)}`);
    console.log(`  基线      ${facts.hasBaseline ? C.green("已建立") : C.yellow("未建立（先跑 cos scan）")}`);
    console.log(`  Entry     ${facts.entries}`);
    console.log(`  受管文件  ${facts.files}`);
    console.log(`  覆盖率    ${pct}%`);
    console.log(`  待创作    ${facts.needAuthoring.length}`);
    console.log(`  待删除    ${facts.needRemoval.length}`);
    console.log(`  token     ${facts.tokens} / 目标 ${WHOLE_INDEX_BUDGET.target} / 警戒 ${WHOLE_INDEX_BUDGET.warning} / 上限 ${WHOLE_INDEX_BUDGET.max}`);
    console.log(`  漂移      ${facts.drift.length}`);
    if (facts.drift.length > 0) {
      const byKind = {};
      for (const d of facts.drift)
        byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      for (const [k, v] of Object.entries(byKind))
        console.log(`            ${k}: ${v}`);
    }
    console.log(`  配额违规  ${facts.quotaViolations.length}`);
    console.log("");
    console.log(C.dim("  完整索引：cat " + join4(root, INDEX_PATH2) + " " + join4(root, META_PATH2) + " " + join4(root, CODE_PATH2)));
    return 0;
  } catch (err) {
    return fail(err);
  }
}
function colorAlign(a) {
  if (a === "aligned")
    return C.green(a);
  if (a === "budget_exceeded")
    return C.red(a);
  return C.yellow(a);
}
function fail(err) {
  const e = err;
  console.error(C.red("✗ ") + (e.message ?? String(err)));
  if (e.code && e.code !== "cos_error")
    console.error(C.dim(`  code: ${e.code}`));
  return 2;
}

// src/cli.ts
var VERSION3 = VERSION;
var HELP = `cos ${VERSION3} \u2014 \u4ED3\u5E93\u8BA4\u77E5\u7D22\u5F15 MCP

\u7528\u6CD5: cos <\u547D\u4EE4> [\u9009\u9879]

\u547D\u4EE4:
  init              \u521D\u59CB\u5316\uFF1A\u5199 Root/Meta/Code \u6A21\u677F + \u914D\u7F6E\u6587\u4EF6 + AGENTS.md \u89C4\u5219\u5757
  scan              \u5EFA\u7ACB\u57FA\u7EBF\uFF08\u6309 git ignore \u6743\u5A01\u679A\u4E3E\u6587\u4EF6\uFF09
  verify            \u62A5\u544A\u6F02\u79FB\uFF08missing / orphan / stale / unbaselined\uFF09
  check             \u6CBB\u7406\u95E8\u7981\uFF08\u914D\u989D + \u8986\u76D6 + \u5BF9\u9F50\uFF09\uFF0C\u975E\u96F6\u9000\u51FA\u53EF\u63A5 CI
  status            \u4EBA\u770B\u7684\u6458\u8981
  mcp               \u542F\u52A8 stdio MCP Server

\u5168\u5C40\u9009\u9879:
  --repo <path>     \u6307\u5B9A\u4ED3\u5E93\u6839\uFF08\u9ED8\u8BA4\u6309 cwd \u5411\u4E0A\u67E5\u627E .codebase_store\uFF09
  --force           init \u8986\u76D6\u5DF2\u6709\u7D22\u5F15 / scan \u91CD\u5EFA\u57FA\u7EBF
  --json            verify \u548C check \u8F93\u51FA JSON
  -h, --help        \u663E\u793A\u5E2E\u52A9
  -v, --version     \u663E\u793A\u7248\u672C

\u4ED3\u5E93\u5B9A\u4F4D\u89C4\u5219:
  \u9664 init \u5916\uFF0C\u6240\u6709\u547D\u4EE4\u90FD\u4ECE\u5F53\u524D\u76EE\u5F55\u5411\u4E0A\u9010\u5C42\u67E5\u627E\u6700\u8FD1\u7684 .codebase_store/\u3002
  \u8FD9\u6837\u5728\u5B50\u76EE\u5F55\u91CC\u8DD1\u547D\u4EE4\u4E5F\u80FD\u547D\u4E2D\u9879\u76EE\u7D22\u5F15\uFF0C\u591A\u4E2A\u9879\u76EE\u5171\u5B58\u65F6\u4E92\u4E0D\u5E72\u6270\u3002
  MCP \u6A21\u5F0F\u4E0D\u56FA\u5B9A\u4ED3\u5E93\u65F6\uFF0C\u6BCF\u6B21\u5DE5\u5177\u8C03\u7528\u90FD\u4F1A\u91CD\u65B0\u89E3\u6790 \u2014\u2014 \u5BBF\u4E3B\u628A cwd \u8BBE\u5728\u54EA\u4E2A
  \u9879\u76EE\uFF0C\u5C31\u4F5C\u7528\u4E8E\u54EA\u4E2A\u9879\u76EE\uFF0C\u4E00\u4EFD MCP \u914D\u7F6E\u53EF\u4EE5\u670D\u52A1\u591A\u4E2A\u9879\u76EE\u3002

\u5178\u578B\u6D41\u7A0B:
  cos init
  cos scan
  # \u5728 Agent \u91CC\u52A0 MCP \u914D\u7F6E\uFF0C\u91CD\u542F
  # \u5BF9 Agent \u8BF4\uFF1A\u300C\u8BFB cos_rules\uFF0C\u7136\u540E\u5EFA\u7ACB\u7D22\u5F15\u300D
  cos verify && cos check
`;
function parseArgs(argv) {
  const out = { command: "", force: false, json: false, help: false, version: false };
  const rest = [];
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") {
      out.repo = argv[++i];
      continue;
    }
    if (a.startsWith("--repo=")) {
      out.repo = a.slice(7);
      continue;
    }
    if (a === "--force") {
      out.force = true;
      continue;
    }
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "-v" || a === "--version") {
      out.version = true;
      continue;
    }
    if (a.startsWith("-"))
      throw new CosError(`\u672A\u77E5\u9009\u9879 ${a}`, "bad_flag");
    rest.push(a);
  }
  out.command = rest[0] ?? "";
  return out;
}
function resolveRepoForRead(start) {
  const found = findInitializedRoot(start);
  if (found)
    return found;
  const gitRoot = findRepoRoot(start);
  if (isInitialized(gitRoot))
    return gitRoot;
  throw new CosError(`\u4ECE ${start} \u5411\u4E0A\u6CA1\u6709\u627E\u5230\u5DF2\u521D\u59CB\u5316\u7684\u4ED3\u5E93\uFF08\u7F3A\u5C11 ${DATA_DIR}/${INDEX_PATH.replace(DATA_DIR + "/", "")}\uFF09\u3002
` + `  \xB7 \u5982\u679C\u8FD9\u662F\u65B0\u9879\u76EE\uFF1A\u5148\u5728\u9879\u76EE\u6839\u76EE\u5F55\u8FD0\u884C cos init
` + `  \xB7 \u5982\u679C\u9879\u76EE\u5728\u522B\u5904\uFF1A\u7528 --repo <path> \u663E\u5F0F\u6307\u5B9A
` + `  \xB7 \u5982\u679C\u4F60\u4EE5\u4E3A\u5DF2\u7ECF\u521D\u59CB\u5316\u8FC7\uFF1A\u786E\u8BA4 ${DATA_DIR}/ \u662F\u5426\u88AB\u79FB\u52A8\u6216\u5220\u9664`, "not_initialized");
}
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (args.version) {
    console.log(`cos ${VERSION3}`);
    return 0;
  }
  if (args.help || args.command === "" || args.command === "help") {
    console.log(HELP);
    return 0;
  }
  if (args.command === "mcp") {
    const [{ runMcpServer: runMcpServer2 }, { TOOLS: TOOLS2 }] = await Promise.all([
      Promise.resolve().then(() => (init_mcp(), exports_mcp)),
      Promise.resolve().then(() => (init_tools(), exports_tools))
    ]);
    if (args.repo) {
      const fixed = resolve3(args.repo);
      if (!existsSync4(fixed)) {
        console.error(`\u4ED3\u5E93\u8DEF\u5F84\u4E0D\u5B58\u5728\uFF1A${fixed}`);
        return 2;
      }
      await runMcpServer2(() => fixed, TOOLS2, fixed);
    } else {
      await runMcpServer2(() => resolveRepoForRead(process.cwd()), TOOLS2, null);
    }
    await new Promise((resolveHold) => {
      const stop = () => resolveHold();
      process.stdin.once("end", stop);
      process.stdin.once("close", stop);
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
    return 0;
  }
  let root;
  try {
    root = args.repo ? resolve3(args.repo) : args.command === "init" ? findRepoRoot() : resolveRepoForRead(process.cwd());
  } catch (err) {
    console.error(err.message);
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
      console.error(`\u672A\u77E5\u547D\u4EE4 "${args.command}"\u3002\u8FD0\u884C cos --help \u67E5\u770B\u53EF\u7528\u547D\u4EE4\u3002`);
      return 2;
  }
}
main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(err instanceof CosError ? err.message : err);
  process.exitCode = 2;
});
