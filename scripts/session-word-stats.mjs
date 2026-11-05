#!/usr/bin/env node
/**
 * session-word-stats — 统计 DSH 全部会话中「用户本人输入」的词频。
 *
 * 数据源：<sessionsRoot>/<workspace>/<sessionId>/session.v4.jsonl.zstd
 *   每条记录一帧 zstd（append-only），Node 的流式解压只吐第一帧，
 *   所以按帧 magic 切分逐帧解压。
 * 口径（两道筛子，缺一不可）：
 *   1. 会话级：跳过 header.origin==="subagent" 的会话。子代理会话里，Lead 通过
 *      send_message 派发的任务同样记成 user/message + source.kind="user"，
 *      不排掉就会被当成用户输入。
 *   2. 消息级：只计 data.source.kind==="user"。其余 kind（runtime-context /
 *      skill-catalog / team-message / time-context …）都是引擎注入的上下文。
 *
 * 用法：
 *   node session-word-stats.mjs [--sessions <dir>] [--workspace <substr>]
 *                               [--since YYYY-MM-DD] [--top N]
 *                               [--include-subagents]
 *                               [--out <report.md>] [--json <data.json>]
 */
import { zstdDecompressSync } from "node:zlib";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 认得的会话格式版本。v3 与 v4 的记录结构一致（都是 user/message +
 * data.source.kind），差别的只是头部版本号，所以两个都读。
 * 出现列表外的版本要显式报出来——DSH 升级格式后如果静默算成 0 条，
 * 用户会以为"我没说过话"。
 */
export const SUPPORTED_VERSIONS = [3, 4];
const MAXN = 12; // 短语最长 12 字，够覆盖一整句指令

// ---------- 解压 ----------

/**
 * 解压 append-only 的多帧 zstd 日志。
 * Node 的 createZstdDecompress 只吐第一帧就停（后续帧直接报 prefix_unknown），
 * 所以按帧 magic 切开逐帧解压再拼接。
 */
export function decompressFrames(buf) {
  const starts = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) {
    starts.push(i);
    i = buf.indexOf(MAGIC, i + 4);
  }
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(from, to)));
    } catch {} // 压缩流内部巧合出现的 magic 会导致解压失败，跳过
  }
  return Buffer.concat(parts).toString("utf8");
}

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".jsonl.zstd")) out.push({ path: p, mtime: st.mtimeMs });
  }
  return out;
}

/** 工作区目录名是编码过的路径：`--E-~732B~732B~8FF7~5BAB--` → `E:\猫猫迷宫`（`-` 与 `~XXXX` 均为转义）。仅 Windows 形态验证过。 */
export function decodeWorkspace(dir) {
  const s = dir.replace(/^--|--$/g, "");
  return s
    .replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/-/g, "\\")
    .replace(/^([A-Za-z])\\/, "$1:\\");
}

// ---------- 采集 ----------

/**
 * 从会话目录里抽出用户本人输入的消息。
 * @returns {{messages:Array, sourceKinds:Map, versions:Map, scannedFiles:number,
 *            skippedSubagents:number, unsupported:Array<{version:number,path:string}>,
 *            formTaggedUsers:number, imageOnlyDropped:number, withImage:number}}
 */
export function collectMessages({
  sessionsRoot,
  workspaceFilter = null,
  includeSubagents = false,
} = {}) {
  const files = walk(sessionsRoot).sort((a, b) => a.mtime - b.mtime);
  const messages = [];
  const sourceKinds = new Map();
  const versions = new Map();
  const unsupported = [];
  let scannedFiles = 0;
  let skippedSubagents = 0;
  // 引擎侧的可选统计：图片消息、以及"kind=user 却带 form"的异常
  let formTaggedUsers = 0;
  let imageOnlyDropped = 0;
  let withImage = 0;

  for (const f of files) {
    const parts = f.path.split(/[\\/]/);
    const rawWorkspace = parts[parts.length - 3] ?? "";
    if (workspaceFilter && !rawWorkspace.includes(workspaceFilter)) continue;

    let text;
    try {
      text = decompressFrames(readFileSync(f.path));
    } catch {
      continue;
    }
    scannedFiles++;

    const nl = text.indexOf("\n");
    let header = null;
    try {
      const h = JSON.parse(nl === -1 ? text : text.slice(0, nl));
      if (h?.type === "session") header = h;
    } catch {}

    // 版本不认识就明确记下来，别静默产出 0 条让用户以为"我没说过话"
    if (header) {
      const v = header.version;
      versions.set(v, (versions.get(v) ?? 0) + 1);
      if (!SUPPORTED_VERSIONS.includes(v)) {
        unsupported.push({ version: v, path: f.path });
        continue;
      }
    }
    if (!includeSubagents && header?.origin === "subagent") {
      skippedSubagents++;
      continue;
    }

    const workspace = decodeWorkspace(rawWorkspace);
    const sessionId = header?.id ?? parts[parts.length - 2];
    const seen = new Set();

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== "user/message") continue;
      const d = o.data ?? {};
      const kind = d.source?.kind ?? "<none>";
      sourceKinds.set(kind, (sourceKinds.get(kind) ?? 0) + 1);
      if (kind !== "user") continue;
      // kind=user 却带 form，说明引擎开始用 form 标注注入内容却仍留了 user 这个 kind。
      // 此时单靠 kind 过滤会漏掉注入文本，必须让人知道。
      if (d.source?.form) formTaggedUsers++;
      if (d.id) {
        if (seen.has(d.id)) continue; // 同一条消息在 inbox/spliced 与 user/message 里各出现一次
        seen.add(d.id);
      }
      // 新版会往 content 里放 image 块。只统计文字；纯图片消息没有文字可数，
      // 记一笔再从词频里排除，别让它静默消失。
      const blocks = d.content ?? [];
      if (blocks.some((c) => c.type === "image")) withImage++;
      const txt = blocks
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (!txt) {
        if (blocks.some((c) => c.type === "image")) imageOnlyDropped++;
        continue;
      }
      messages.push({ sessionId, workspace, time: o.time ?? null, text: txt });
    }
  }

  return {
    messages,
    sourceKinds,
    versions,
    scannedFiles,
    skippedSubagents,
    unsupported,
    formTaggedUsers,
    imageOnlyDropped,
    withImage,
  };
}

// ---------- 清洗 ----------

// 代码块里的注释/标识符会污染中文词频，统计前剔除（英文词榜用原文，不剔除）
const stripCode = (t) => t.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");

/**
 * UI「继续」按钮也会落成 kind="user" 的消息，正文是引擎措辞而不是用户打字：
 *   "继续。宿主在你上一轮运行期间重启了; … (上一步工具「pwsh」可能未完成, …)"
 * 这些措辞会挤满词榜（工具/状态/确认/执行/重复/上一），先剥掉再统计。
 */
const ENGINE_NOISE = [
  /宿主在你上一轮运行期间重启了;[\s\S]*?(?:外部状态[。.]|$)/g,
  /\(上一步工具「[^」]*」可能未完成[^)]*\)/g,
  /\(上一步工具「[^」]*」可能未完成[^)]*$/g,
];
const AUTO_CONTINUE = /^继续[。.]?\s*(宿主在你上一轮|$)/;

export function cleanUserText(t) {
  let s = t;
  for (const re of ENGINE_NOISE) s = s.replace(re, " ");
  return s.replace(/[ \t]+/g, " ").trim();
}

// 虚词字：整词都是虚词字的组合（"的是""了我"）没有信息量
const STOP_HAN = new Set(
  (
    "的了是在和与也就都而及或把被给对你这那我他它们个有没不要会能可" +
    "上下至从到于以为所之其此该等又再很更最还只并不太多少好么呢吧啊呀哦嗯就才"
  ).split("")
);
const STOP_WORDS = new Set([
  "一个", "这个", "那个", "什么", "怎么", "因为", "所以", "但是", "然后", "如果",
  "已经", "可以", "需要", "应该", "一下", "一些", "这样", "那样", "没有", "不是",
  "就是", "还是", "只是", "这些", "那些", "我们", "你们", "他们", "自己", "时候",
  "东西", "之间", "之后", "之前", "现在", "这里", "那里", "为什么", "是不是",
]);
const EN_STOP = new Set(
  "the a an and or but if then of to in on for with at by is are was were be been it this that these those as from we you they i not no do does did can will would should could have has had my your our their".split(
    " "
  )
);

// ---------- 分析 ----------

/** 跑完整统计，返回报告数据（渲染交给 renderReport）。 */
export function analyze({
  sessionsRoot,
  workspaceFilter = null,
  since = null,
  top = 30,
  includeSubagents = false,
} = {}) {
  const {
    messages,
    sourceKinds,
    versions,
    scannedFiles,
    skippedSubagents,
    unsupported,
    formTaggedUsers,
    imageOnlyDropped,
    withImage,
  } = collectMessages({
    sessionsRoot,
    workspaceFilter,
    includeSubagents,
  });

  const filtered = since
    ? messages.filter((m) => m.time && new Date(m.time).toISOString().slice(0, 10) >= since)
    : messages;

  let autoContinuations = 0;
  for (const m of filtered) {
    if (AUTO_CONTINUE.test(m.text)) {
      autoContinuations++;
      m.text = "继续"; // 整条都是引擎措辞，用户只是点了「继续」
    } else {
      m.text = cleanUserText(m.text);
    }
  }

  // --- 中文 n-gram ---
  const tf = new Map(); // n-gram -> 总出现次数
  const df = new Map(); // n-gram -> 出现在多少条消息中
  let hanChars = 0;

  for (const m of filtered) {
    if (!m.text) continue;
    const prose = stripCode(m.text);
    const local = new Set();
    for (const run of prose.match(/[\u4e00-\u9fa5]+/g) ?? []) {
      hanChars += run.length;
      for (let n = 1; n <= Math.min(MAXN, run.length); n++)
        for (let i = 0; i + n <= run.length; i++) {
          const g = run.slice(i, i + n);
          tf.set(g, (tf.get(g) ?? 0) + 1);
          local.add(g);
        }
    }
    for (const g of local) df.set(g, (df.get(g) ?? 0) + 1);
  }

  // 最长覆盖减除：indep(g) = tf(g) - max(tf(包含 g 的更长片段))
  // 滑窗错位碎片（"认状态再继续" 只出现在 "先确认状态再继续" 里）独立次数为 0，直接出局。
  // 只对 tf>=2 的片段做，避免百万级空转。
  const maxLonger = new Map();
  for (const [s, c] of tf) {
    const n = s.length;
    if (n < 3 || c < 2) continue;
    for (let len = 2; len < n; len++)
      for (let i = 0; i + len <= n; i++) {
        const sub = s.slice(i, i + len);
        if (c > (maxLonger.get(sub) ?? 0)) maxLonger.set(sub, c);
      }
  }

  // 双字片段还要过一道结合强度：PMI 低的（"成一""上一""是很"）是跨词碎片，
  // 不是用户真在用的词。实测真词 PMI 4~6，碎片 1~3。
  //
  // 但 PMI 在小语料上系统性偏低（"继续"在 12 个字的语料里只有 0.69），
  // 所以语料不足时关掉这道闸——几千字以内本来也不值得重过滤。
  const PMI_MIN = 3.0;
  const PMI_MIN_CORPUS = 5000; // 汉字数
  const pmiOn = hanChars >= PMI_MIN_CORPUS;
  const pmi = (g) => {
    const a = tf.get(g[0]);
    const b = tf.get(g[1]);
    const p = tf.get(g);
    if (!a || !b || !p || !hanChars) return -99;
    return Math.log((p / hanChars) / ((a / hanChars) * (b / hanChars)));
  };

  const rank = (minN, maxN, limit) => {
    const rows = [];
    for (const [term, count] of tf) {
      const n = term.length;
      if (n < minN || n > maxN) continue;
      const docs = df.get(term) ?? 0;
      if (docs < 2) continue;
      if (STOP_WORDS.has(term)) continue;
      if ([...term].every((ch) => STOP_HAN.has(ch))) continue;
      const longer = maxLonger.get(term) ?? 0;
      if (longer >= count * 0.9) continue; // 几乎只在更长的片段里出现 → 碎片
      if (n === 2 && pmiOn && pmi(term) < PMI_MIN) continue;
      rows.push({ term, count, docs });
    }
    rows.sort((a, b) => b.docs - a.docs || b.count - a.count);
    return rows.slice(0, limit);
  };

  // --- 消息开头惯用语（前 2 字，同前缀自然合并） ---
  const openerMap = new Map();
  for (const m of filtered) {
    const run = stripCode(m.text).trim().match(/^[\u4e00-\u9fa5]+/)?.[0];
    if (run && run.length >= 2) {
      const key = run.slice(0, 2);
      openerMap.set(key, (openerMap.get(key) ?? 0) + 1);
    }
  }
  const openers = [...openerMap.entries()]
    .filter(([s, c]) => c >= 2 && !STOP_WORDS.has(s))
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([term, count]) => ({ term, count }));

  // --- 反复输入的整句 ---
  const lineMap = new Map();
  for (const m of filtered) {
    for (const raw of stripCode(m.text).split(/[\n\r]+/)) {
      const s = raw.trim().replace(/\s+/g, " ");
      if (s.length < 6 || s.length > 80) continue;
      if (/^[#<|>\-*`~+=\[]/.test(s)) continue; // markdown/标签行不是"句子"
      if (/system-reminder/i.test(s)) continue;
      lineMap.set(s, (lineMap.get(s) ?? 0) + 1);
    }
  }
  const repeated = [...lineMap.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, top)
    .map(([text, count]) => ({ text, count }));

  // --- 英文 / 技术词 ---
  const enTf = new Map();
  const enDf = new Map();
  for (const m of filtered) {
    const local = new Set();
    for (const w of m.text.match(/[A-Za-z][A-Za-z0-9_+#.-]{1,}/g) ?? []) {
      const k = w.toLowerCase();
      if (EN_STOP.has(k) || k.length < 2) continue;
      enTf.set(k, (enTf.get(k) ?? 0) + 1);
      local.add(k);
    }
    for (const k of local) enDf.set(k, (enDf.get(k) ?? 0) + 1);
  }
  // 同样的覆盖减除：`send` 若总在 `send_message` 里出现，就不该单独上榜
  const enLonger = new Map();
  for (const [w, c] of enTf) {
    if (c < 2) continue;
    for (const part of w.split(/[_.\-/]/)) {
      if (part !== w && part.length >= 2 && c > (enLonger.get(part) ?? 0)) enLonger.set(part, c);
    }
  }
  const enTerms = [...enTf.entries()]
    .filter(([w, c]) => (enDf.get(w) ?? 0) >= 2 && (enLonger.get(w) ?? 0) < c * 0.9)
    .map(([term, count]) => ({ term, count, docs: enDf.get(term) }))
    .sort((a, b) => b.docs - a.docs || b.count - a.count)
    .slice(0, top);

  // --- 分布 ---
  const byWorkspace = new Map();
  for (const m of filtered) byWorkspace.set(m.workspace, (byWorkspace.get(m.workspace) ?? 0) + 1);
  const byMonth = new Map();
  for (const m of filtered) {
    if (!m.time) continue;
    const k = new Date(m.time).toISOString().slice(0, 7);
    byMonth.set(k, (byMonth.get(k) ?? 0) + 1);
  }

  return {
    generatedAt: new Date().toISOString(),
    sessionsRoot,
    scannedFiles,
    matchedSessions: new Set(filtered.map((m) => m.sessionId)).size,
    messages: filtered.length,
    hanChars,
    shortMessages: filtered.filter((m) => m.text.length <= 8).length,
    autoContinuations,
    pmiApplied: pmiOn,
    versions: Object.fromEntries([...versions.entries()].sort((a, b) => a[0] - b[0])),
    formTaggedUsers,
    imageOnlyDropped,
    withImage,
    skippedSubagents,
    includeSubagents,
    unsupported,
    sourceKinds: Object.fromEntries([...sourceKinds.entries()].sort((a, b) => b[1] - a[1])),
    words: rank(2, 3, top),
    phrases: rank(4, MAXN, top),
    openers,
    repeated,
    enTerms,
    byWorkspace: [...byWorkspace.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ workspace: k, count: v })),
    byMonth: [...byMonth.entries()].sort().map(([k, v]) => ({ month: k, count: v })),
  };
}

// ---------- 渲染 ----------

export function renderReport(data) {
  const pct = (c) => (data.messages ? `${((c / data.messages) * 100).toFixed(0)}%` : "–");
  const verDesc = Object.entries(data.versions ?? {})
    .map(([v, n]) => `v${v} × ${n}`)
    .join("、");
  const md = [];
  md.push(`# 会话输入词频统计`);
  md.push("");
  md.push(
    `扫描 **${data.scannedFiles}** 个会话文件${verDesc ? `（${verDesc}）` : ""}，其中有用户输入的 **${data.matchedSessions}** 个会话，共 **${data.messages}** 条用户消息、**${data.hanChars.toLocaleString()}** 个汉字。`
  );
  md.push("");
  md.push(
    `口径：只计用户本人输入（\`source.kind="user"\`），排除系统注入的上下文。表中「条数」= 出现在多少条消息里，「次数」= 总出现次数。`
  );
  md.push("");

  if (data.skippedSubagents) {
    md.push(
      `已跳过 ${data.skippedSubagents} 个子代理会话——那里的 \`kind="user"\` 是 Lead 派下去的任务，不是你的输入。加 \`--include-subagents\` 可一并统计。`
    );
    md.push("");
  }

  const section = (title, rows, render) => {
    if (!rows.length) return;
    md.push(`## ${title}`);
    md.push("");
    md.push("| # | 词/片段 | 条数 | 次数 | 覆盖消息 |");
    md.push("|---|---|---|---|---|");
    rows.forEach((r, i) => {
      md.push(`| ${i + 1} | ${render(r)} | ${r.docs ?? r.count} | ${r.count} | ${pct(r.docs ?? r.count)} |`);
    });
    md.push("");
  };

  section("高频词（2–3 字）", data.words, (r) => r.term);
  section("高频短语（4 字以上）", data.phrases, (r) => r.term);
  section("消息开头惯用语", data.openers, (r) => r.term);
  section("反复输入的整句", data.repeated, (r) => r.text.replace(/\|/g, "\\|"));
  section("高频英文 / 技术词", data.enTerms, (r) => r.term);

  md.push("## 分布");
  md.push("");
  md.push("| 工作区 | 消息数 |");
  md.push("|---|---|");
  data.byWorkspace.forEach((w) => md.push(`| ${w.workspace} | ${w.count} |`));
  md.push("");
  md.push("| 月份 | 消息数 |");
  md.push("|---|---|");
  data.byMonth.forEach((m) => md.push(`| ${m.month} | ${m.count} |`));
  md.push("");

  const kindRows = Object.entries(data.sourceKinds);
  if (kindRows.length) {
    md.push("## 被过滤掉的注入内容");
    md.push("");
    md.push(`会话里的 \`user/message\` 记录按来源分类如下，只有 \`user\` 计入统计：`);
    md.push("");
    md.push("| source.kind | 记录数 |");
    md.push("|---|---|");
    kindRows.forEach(([k, v]) => md.push(`| ${k} | ${v} |`));
    md.push("");
    md.push(
      `> 出现不认识的 kind 说明 DSH 新增了注入类型，统计口径可能失真——请核对上面这张表。`
    );
    md.push("");
  }

  // kind=user 却带 source.form：引擎改用 form 标注注入内容的信号，这条口径会失效
  if (data.formTaggedUsers) {
    md.push(
      `> ⚠️ 有 **${data.formTaggedUsers}** 条 \`kind="user"\` 的消息带了 \`source.form\` 标记。`
    );
    md.push(
      `> 新版 DSH 用 \`form\` 区分注入种类（snapshot / notice / relay / catalog / instructions），`
    );
    md.push(
      `> 正常用户输入不带这个字段。它们被当成了用户输入计入统计，词榜可能被注入文本污染。`
    );
    md.push(`> 请开 issue 附上你的 DSH 版本，这一条口径需要跟着引擎改。`);
    md.push("");
  }

  md.push(
    `其中 ${data.shortMessages} 条消息不超过 8 个字符（${pct(data.shortMessages)} 的消息是"继续""好"这类短指令）；${data.autoContinuations} 条是界面「继续」按钮触发的自动续跑消息（已剥掉引擎附言，只留开头的"继续"）。`
  );
  md.push("");
  if (data.withImage) {
    md.push(
      `另有 ${data.withImage} 条消息带图片，文字部分照常计入${
        data.imageOnlyDropped ? `；其中 ${data.imageOnlyDropped} 条纯图片没有文字，无法计入词频` : ""
      }。`
    );
    md.push("");
  }
  if (!data.pmiApplied) {
    md.push(`> 语料不足 5000 汉字，未启用 PMI 跨词碎片过滤，词榜可能混入"成一""上一"这类碎片。数据够多时会自动启用。`);
    md.push("");
  }
  return md.join("\n");
}

// ---------- CLI ----------

const argOf = (argv, name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

export function main(argv = process.argv.slice(2)) {
  if (typeof zstdDecompressSync !== "function") {
    console.error(
      `需要 Node 22.15 及以上（用到内置 zstd）。当前是 ${process.version}，升级 Node 即可，不用装任何包。`
    );
    return 2;
  }

  const sessionsRoot = argOf(argv, "sessions", join(homedir(), ".dsh", "sessions"));
  const outReport = argOf(argv, "out", null);
  const outJson = argOf(argv, "json", null);

  let data;
  try {
    data = analyze({
      sessionsRoot,
      workspaceFilter: argOf(argv, "workspace", null),
      since: argOf(argv, "since", null),
      top: Number(argOf(argv, "top", 30)),
      includeSubagents: argv.includes("--include-subagents"),
    });
  } catch (e) {
    console.error(`读取会话失败：${e.message}`);
    return 2;
  }

  if (data.messages === 0 && data.unsupported.length) {
    const versions = [...new Set(data.unsupported.map((u) => u.version))].join(", ");
    console.error(
      `没有可统计的会话：找到 ${data.unsupported.length} 个 v${versions} 格式的会话文件，本工具只认 v${SUPPORTED_VERSIONS.join(" / v")}。\n` +
        `DSH 升级过会话格式时会出现这种情况，请开 issue 而不是以为"我没说过话"。`
    );
    return 2;
  }

  if (data.unsupported.length) {
    const versions = [...new Set(data.unsupported.map((u) => u.version))].join(", ");
    console.error(
      `警告：跳过 ${data.unsupported.length} 个 v${versions} 格式的会话（只认 v${SUPPORTED_VERSIONS.join(" / v")}）。`
    );
  }

  const report = renderReport(data);
  if (outReport) writeFileSync(outReport, report, "utf8");
  if (outJson) writeFileSync(outJson, JSON.stringify(data, null, 2), "utf8");
  console.log(
    outReport
      ? `report → ${outReport}  (${data.messages} msgs, ${data.matchedSessions} sessions)`
      : report
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
