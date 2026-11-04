/**
 * smoke test —— 钉住几个口径坑，任何一个退回去都会红。
 * 跑：node test/smoke.test.mjs
 * （受限环境里 `node --test` 的子进程模式可能被拦，直接跑文件即可。）
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  decompressFrames,
  collectMessages,
  analyze,
  renderReport,
  decodeWorkspace,
  main,
} from "../scripts/session-word-stats.mjs";
import { buildFixture, MAIN_SESSION } from "./fixture.mjs";

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "sws-fixture-"));
  buildFixture(root);
});
after(() => rmSync(root, { recursive: true, force: true }));

const mainFile = () => join(root, "--E-~732B~732B~8FF7~5BAB--", MAIN_SESSION, "session.v4.jsonl.zstd");

test("多帧 zstd 必须全部解出来，不能只吐第一帧", () => {
  const text = decompressFrames(readFileSync(mainFile()));
  const lines = text.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 7, "7 条记录 = 7 帧，一行都不能丢");
  assert.ok(text.includes("帮我生成一个 Godot 项目"), "最后一帧的内容也要读出来");
});

test("解不出帧内容时不能崩，静默跳过坏帧", () => {
  // 帧中间插入一段假的 magic（压缩流内部巧合出现时会这样）
  const raw = readFileSync(mainFile());
  const corrupted = Buffer.concat([raw, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])]);
  assert.ok(decompressFrames(corrupted).includes("Godot"), "坏尾帧之后仍返回已解出的内容");
});

test("只统计 source.kind===\"user\"，注入内容挡在外面", () => {
  const { messages, sourceKinds } = collectMessages({ sessionsRoot: root });
  // m1 + auto1 + m2（重复 id 去重）+ o1（v3 会话里的真输入）
  assert.equal(messages.length, 4);
  assert.equal(sourceKinds.get("runtime-context"), 1, "注入内容仍然被计数，只是不计入消息");
  assert.equal(sourceKinds.get("user"), 5, "kind=user 的原始记录数（含重复 id）");
});

test("子代理会话整条排除，--include-subagents 才放进来", () => {
  const off = collectMessages({ sessionsRoot: root });
  assert.equal(off.skippedSubagents, 1);
  assert.ok(!off.messages.some((m) => m.text.includes("质检团队")), "Lead 派的任务不算用户输入");

  const on = collectMessages({ sessionsRoot: root, includeSubagents: true });
  assert.equal(on.messages.length, 5);
  assert.ok(on.messages.some((m) => m.text.includes("质检团队")));
});

test("v3 会话结构同 v4，必须照常统计，不能当成旧格式丢掉", () => {
  const { messages, versions } = collectMessages({ sessionsRoot: root });
  assert.ok(messages.some((m) => m.text.includes("帮我安装官方桌面版")), "v3 里的真输入要统计");
  assert.equal(versions.get(3), 1);
  assert.equal(versions.get(4), 2);
});

test("认不出的版本要报出来，不能静默产出 0 条", () => {
  const { messages, unsupported } = collectMessages({ sessionsRoot: root });
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].version, 5);
  assert.ok(messages.length > 0, "其余会话照常统计");
});

test("工作区目录名解码成可读路径", () => {
  assert.equal(decodeWorkspace("--E-~732B~732B~8FF7~5BAB--"), "E:\\猫猫迷宫");
  assert.equal(decodeWorkspace("--C-Users-12760-demo--"), "C:\\Users\\12760\\demo");
});

test("--workspace 过滤按目录名原文匹配", () => {
  assert.equal(collectMessages({ sessionsRoot: root, workspaceFilter: "732B" }).messages.length, 3);
  assert.equal(collectMessages({ sessionsRoot: root, workspaceFilter: "dshdesk" }).messages.length, 0);
});

test("「继续」按钮消息压成继续并单独计数，引擎措辞不进词榜", () => {
  const data = analyze({ sessionsRoot: root, top: 10 });
  assert.equal(data.autoContinuations, 1);
  const cont = data.words.find((w) => w.term === "继续");
  assert.ok(cont, "继续 应当进词榜");
  assert.equal(cont.docs, 2, "m1 和 auto1 各算一条消息");
  const flat = data.words.map((w) => w.term).join("");
  assert.ok(!flat.includes("上一步"), "引擎措辞不能漏进词榜");
  assert.ok(!flat.includes("可能未完成"));
});

test("短消息与总数对得上", () => {
  const data = analyze({ sessionsRoot: root, top: 10 });
  assert.equal(data.messages, 4);
  assert.equal(data.matchedSessions, 2, "主会话 + v3 会话");
  assert.equal(data.shortMessages, 2, "两条「继续」不超过 8 字");
  assert.equal(data.pmiApplied, false, "fixture 语料只有几十字，PMI 闸门应关闭");
});

test("--since 过滤消息", () => {
  assert.equal(analyze({ sessionsRoot: root, since: "2100-01-01", top: 5 }).messages, 0);
  assert.equal(analyze({ sessionsRoot: root, since: "2000-01-01", top: 5 }).messages, 4);
});

test("报告里必须交代口径：版本、注入内容分布、跳过说明", () => {
  const md = renderReport(analyze({ sessionsRoot: root, top: 10 }));
  assert.ok(md.includes("v3 × 1"), "版本分布要写进报告");
  assert.ok(md.includes("被过滤掉的注入内容"));
  assert.ok(md.includes("runtime-context"));
  assert.ok(md.includes("子代理会话"));
  assert.ok(md.includes("自动续跑"));
});

test("CLI：正常跑返回 0 并写出 JSON", () => {
  const out = join(root, "out.json");
  const code = main(["--sessions", root, "--json", out, "--top", "5"]);
  assert.equal(code, 0);
  const data = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(data.messages, 4);
});

test("CLI：只有认不出的格式时返回非零并提示版本", () => {
  const code = main(["--sessions", root, "--workspace", "future"]);
  assert.equal(code, 2, "不能假装成功，让用户以为没说过话");
});
