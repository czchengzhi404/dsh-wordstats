/**
 * 造脱敏 fixture：结构、字段名、帧格式都照抄真实 DSH 会话，
 * 内容全是假的，绝不包含任何真实对话。
 *
 * 每个会话文件 = 若干帧 zstd 首尾相接（真实会话是 append-only 写的，
 * 一条记录一帧）。这正是"只解第一帧"那个 bug 的复现条件。
 */
import { zstdCompressSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const frame = (obj) => zstdCompressSync(Buffer.from(JSON.stringify(obj) + "\n", "utf8"));

const header = (id, extra = {}) => ({
  type: "session",
  version: 4,
  id,
  createdAt: 1793000000000,
  cwd: "E:\\demo",
  origin: "user",
  delegationDepth: 0,
  ...extra,
});

/** 用户消息记录；kind 决定它是真人输入还是引擎注入 */
const userMsg = (id, text, kind = "user", time = 1793000001000) => ({
  type: "user/message",
  seq: 1,
  time,
  data: {
    content: [{ type: "text", text }],
    source: { kind },
    role: "user",
    id,
  },
  surfaceOp: "append",
});

const assistantMsg = () => ({
  type: "assistant/message",
  seq: 9,
  time: 1793000009000,
  data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
});

function writeSession(root, workspaceDir, sessionId, records) {
  const dir = join(root, workspaceDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.v4.jsonl.zstd"), Buffer.concat(records.map(frame)));
}

/** 主会话：手打消息 + 引擎注入 + 重复 id + 「继续」按钮消息 */
export const MAIN_SESSION = "session-main";
export const SUBAGENT_SESSION = "session-sub";
/** v3：结构同 v4，必须照常统计（丢掉它就等于丢用户的真实输入） */
export const OLD_SESSION = "session-old-v3";
/** v5：认不出来的将来格式，必须明确报警而不是算成 0 条 */
export const FUTURE_SESSION = "session-future-v5";

export function buildFixture(root) {
  // 主会话（origin=user）：只有 m1 / auto / m2 算用户输入
  writeSession(root, "--E-~732B~732B~8FF7~5BAB--", MAIN_SESSION, [
    header(MAIN_SESSION),
    // 手打，但带引擎附言 → 剥成「继续」
    userMsg("m1", "继续 (上一步工具「read」可能未完成, 先确认状态再继续, 不要重复执行)"),
    // 界面「继续」按钮 → 压成「继续」并计入 autoContinuations
    userMsg(
      "auto1",
      "继续。宿主在你上一轮运行期间重启了; 重启时未完成的工具调用已按「结果未知」收尾。从中断处继续, 重试可能有副作用的操作前先核实外部状态。 (上一步工具「pwsh」可能未完成, 先确认状态再继续, 不要重复执行)"
    ),
    // 引擎注入，不该计入
    userMsg("i1", "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.", "runtime-context"),
    // 真手打
    userMsg("m2", "帮我生成一个 Godot 项目", "user", 1793000002000),
    // 同一个 id 在 inbox/spliced 里重复出现 → 去重
    userMsg("m2", "帮我生成一个 Godot 项目", "user", 1793000002000),
    assistantMsg(),
  ]);

  // 子代理会话：Lead 派下去的任务也记成 kind="user"，默认必须整条排除
  writeSession(root, "--E-dshdesk--", SUBAGENT_SESSION, [
    header(SUBAGENT_SESSION, { origin: "subagent", parentSession: MAIN_SESSION, delegationDepth: 1 }),
    userMsg("s1", "你是质检团队的测试工程师，请独立复核导出功能，不要采信其它代理的结论。"),
  ]);

  // v3 会话：只有头部版本号不同，记录结构照旧 → 必须照常统计
  writeSession(root, "--E-old--", OLD_SESSION, [
    { type: "session", version: 3, id: OLD_SESSION, createdAt: 1792000000000, cwd: "E:\\demo", origin: "user", delegationDepth: 0 },
    userMsg("o1", "帮我安装官方桌面版"),
  ]);

  // v5 会话：将来的格式，认不出来就要明确报错
  writeSession(root, "--E-future--", FUTURE_SESSION, [
    { type: "session", version: 5, id: FUTURE_SESSION, createdAt: 1794000000000, cwd: "E:\\demo" },
    userMsg("f1", "这条记录来自将来版本的会话"),
  ]);
}
