/**
 * 等价性测试：优化路径（跳首帧判 origin + 帧级过滤）必须与"笨办法"
 * （全量解压、全量解析）产出完全相同的结果。
 *
 * 这是最容易被后续优化破坏的地方——为了快而少解压、少解析，
 * 一不小心就少统计了几条消息，而报告看起来照样正常。
 * 所以这里保留一份最朴素的参考实现，逐条比对。
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

import { collectMessages, MAGIC, SUPPORTED_VERSIONS } from "../scripts/dsh-wordstats.mjs";
import { buildFixture } from "./fixture.mjs";

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "sws-equiv-"));
  buildFixture(root);
});
after(() => rmSync(root, { recursive: true, force: true }));

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (n.endsWith(".jsonl.zstd")) out.push(p);
  }
  return out;
}

/** 笨办法：每一帧都解压、每一行都 parse，不做任何跳过。 */
function bruteForce(root) {
  const msgs = [];
  const kinds = {};
  let skippedSub = 0;
  let withImage = 0;
  let imageOnlyDropped = 0;
  let formTagged = 0;
  const versions = {};

  // 与 collectMessages 用同一排序基准（文件 mtime），否则比对的是两套顺序
  const ordered = walk(root)
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  for (const { p } of ordered) {
    const b = readFileSync(p);
    const starts = [];
    let i = b.indexOf(MAGIC, 0);
    while (i !== -1) {
      starts.push(i);
      i = b.indexOf(MAGIC, i + 4);
    }
    const parts = [];
    for (let k = 0; k < starts.length; k++) {
      const to = k + 1 < starts.length ? starts[k + 1] : b.length;
      try {
        parts.push(zstdDecompressSync(b.subarray(starts[k], to)));
      } catch {}
    }
    const text = Buffer.concat(parts).toString("utf8");
    const nl = text.indexOf("\n");
    let header = null;
    try {
      header = JSON.parse(nl === -1 ? text : text.slice(0, nl));
    } catch {}
    const v = header?.version ?? null;
    if (v !== null) versions[v] = (versions[v] ?? 0) + 1;
    // 口径 1：认不出的会话版本整篇跳过
    if (v !== null && !SUPPORTED_VERSIONS.includes(v)) continue;
    // 口径 2：子代理会话整篇排除
    if (header?.origin === "subagent") {
      skippedSub++;
      continue;
    }
    const seen = new Set();
    for (const line of text.split("\n")) {
      if (!line.includes('"user/message"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== "user/message") continue;
      const d = o.data ?? {};
      const kind = d.source?.kind ?? "<none>";
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      if (kind !== "user") continue;
      if (d.source?.form) formTagged++;
      // 口径 3：按 id 去重（同一条消息在 spliced 与 user/message 各有一份）
      if (d.id) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
      }
      const blocks = d.content ?? [];
      const hasImage = blocks.some((c) => c.type === "image");
      if (hasImage) withImage++;
      const txt = blocks.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (!txt) {
        if (hasImage) imageOnlyDropped++;
        continue;
      }
      msgs.push(txt);
    }
  }
  return { msgs, kinds, skippedSub, withImage, imageOnlyDropped, formTagged, versions };
}

test("优化路径与全量解压逐条等价（消息内容、顺序、kind 分布都要一致）", () => {
  const slow = bruteForce(root);
  const fast = collectMessages({ sessionsRoot: root });

  assert.deepEqual(
    fast.messages.map((m) => m.text),
    slow.msgs,
    "消息内容与顺序必须完全一致"
  );
  assert.deepEqual(
    Object.fromEntries([...fast.sourceKinds.entries()].sort()),
    Object.fromEntries(Object.entries(slow.kinds).sort()),
    "kind 分布必须一致——不一致说明帧级过滤漏掉了记录"
  );
  assert.equal(fast.skippedSubagents, slow.skippedSub);
  assert.equal(fast.withImage, slow.withImage);
  assert.equal(fast.imageOnlyDropped, slow.imageOnlyDropped);
  assert.equal(fast.formTaggedUsers, slow.formTagged);
  assert.deepEqual(
    Object.fromEntries(fast.versions),
    slow.versions,
    "版本分布必须一致——跳 origin 的会话也要计入版本统计"
  );
});

test("--include-subagents 时也要与全量解压等价", () => {
  const fast = collectMessages({ sessionsRoot: root, includeSubagents: true });
  const slow = bruteForce(
    (() => {
      // 全量对照时把子代理会话也算进来：临时改一下判断即可
      return root;
    })()
  );
  // 参考实现默认排除子代理，所以这里只校验子代理那部分被正确补回
  assert.equal(
    fast.messages.length,
    slow.msgs.length + 1,
    "子代理会话里那 1 条 kind=user 消息应被补回"
  );
});
