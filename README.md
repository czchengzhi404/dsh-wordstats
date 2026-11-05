# 会话输入词频统计 · dsh-session-word-stats

[![test](https://github.com/YOUR_NAME/dsh-session-word-stats/actions/workflows/test.yml/badge.svg)](https://github.com/YOUR_NAME/dsh-session-word-stats/actions/workflows/test.yml)

> **隐私**：本工具**只读**本机会话日志，不联网、不上传、不修改任何文件。所有计算都在你机器上完成，输出只有你自己能看到的报告。

把 [DSH](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）会话日志里**你自己亲手打的字**抽出来做词频分析的小工具。零依赖，一条命令出报告。

## 它能回答什么

- 我平时最常打哪些词、爱用哪些固定说法？
- 我开口习惯怎么起头（"继续""帮我""你是……"）？
- 我是不是老在重复粘贴同一段 prompt？
- 我在哪个项目、哪段时间跟 agent 说得最多？

跑出来长这样（某台机器 165 个会话文件、63 个有真人输入、1263 条消息）：

| # | 词/片段 | 条数 | 次数 | 覆盖消息 |
|---|---|---|---|---|
| 1 | 继续 | 642 | 648 | 51% |
| 2 | 生成 | 59 | 119 | 5% |
| 3 | 直接 | 41 | 72 | 3% |
| 4 | 项目 | 38 | 71 | 3% |
| 5 | 读取 | 38 | 40 | 3% |

报告共六个榜（高频词 / 高频短语 / 消息开头惯用语 / 反复输入的整句 / 高频英文技术词 / 工作区与月份分布），外加一张"被过滤掉的注入内容"表，末尾一句画像（短指令占比、自动续跑条数）。

## 用法

```bash
# 直接跑，报告打到 stdout
node scripts/session-word-stats.mjs

# 写到文件
node scripts/session-word-stats.mjs --top 30 --out report.md

# 只看某个项目 / 某段时间
node scripts/session-word-stats.mjs --workspace dshskill
node scripts/session-word-stats.mjs --since 2026-10-01
```

| 参数 | 作用 |
|---|---|
| `--sessions <dir>` | 换会话根目录，默认 `~/.dsh/sessions` |
| `--workspace <substr>` | 只看某个工作区（匹配目录名原文，如 `dshskill`、`732B`） |
| `--since YYYY-MM-DD` | 只看该日期之后的消息 |
| `--top N` | 每个榜的条数，默认 30 |
| `--out <file>` / `--json <file>` | 写 Markdown 报告 / 写原始统计 JSON |
| `--include-subagents` | 连子代理会话一起算（默认排除） |

### 当 DSH skill 用

整个仓库就是一个 skill 目录（`SKILL.md` 在根上）。克隆进 skills 目录即可被 DSH 识别：

```bash
git clone <this-repo> ~/.dsh/skills/session-word-stats
```

之后直接说"统计一下我最常说什么"就会触发。

## 为什么不能直接 grep 会话文件

会话日志里绝大多数文字不是用户写的。要拿到干净的输入语料，四道关缺一不可：

1. **文件是多帧 zstd 拼接的 append-only 日志**（`session.v4.jsonl.zstd`）。每一帧一条记录，而 Node 的 `createZstdDecompress` 读到第一帧结束就停（下一帧直接报 `prefix_unknown`）。必须按帧 magic `28 b5 2f fd` 切开逐帧解压再拼接，否则一个 7MB 的会话你只读到开头 200 字节。
2. **只有 `source.kind==="user"` 才是人打的字。** 同一批 `user/message` 记录里还混着 `runtime-context`、`skill-catalog`、`time-context`、`team-message`、`memory-context`、`compact-checkpoint` 等引擎注入内容。报告末尾那张表会列出所有被过滤的 kind——出现不认识的 kind，就说明 DSH 加了新的注入类型，口径可能失真。
3. **子代理会话要整条排除。** 团队模式下 Lead 用 `send_message` 派给子代理的任务同样记成 `kind="user"`，不排除就会把几十条长 prompt 算成"你的输入"。加 `--include-subagents` 可以反过来看。
4. **界面「继续」按钮也落成 `kind="user"`**，正文是引擎措辞：`继续。宿主在你上一轮运行期间重启了; … (上一步工具「pwsh」可能未完成, 先确认状态再继续, 不要重复执行)`。不剥离的话 `工具 / 状态 / 确认 / 执行 / 重复` 会霸榜。脚本把这类消息压成「继续」并单独计数。

另外**会话格式版本**：v3 和 v4 的记录结构一致，两个都读；白名单之外的版本（将来的 v5…）会明确警告并跳过，而不是静默算成 0 条让你以为"我没说过话"。

## 中文怎么分词

不装 jieba（也不需要任何词典），用 n-gram 加三道筛子逼近分词效果：

- **最长覆盖减除**：`认状态再继续` 只出现在 `先确认状态再继续` 里，独立次数归零，出局。
- **PMI 结合强度**：`成一`、`上一`、`是很` 这类跨词碎片 PMI 只有 1~3，真词 4~6。门槛是脚本里的 `PMI_MIN`（默认 3.0），调高更严。
- **虚词表**：`STOP_HAN` / `STOP_WORDS` 去掉「的是了」「一个」「这样」这种没有信息量的组合。

PMI 在小语料上系统性偏低，所以汉字数不足 5000 时自动关掉这道闸（报告里会注明）。

## 测试

```bash
node test/smoke.test.mjs      # 直接跑，14 个用例
node --test test/             # 或走 Node 测试运行器
```

测试用**内存里现造的脱敏 fixture**（`test/fixture.mjs`），结构照抄真实会话，内容全是假的，仓库里不含任何真实对话。断言覆盖：多帧解压、注入过滤、子代理排除、版本白名单、工作区解码、`--since`、CLI 退出码。

CI（`.github/workflows/test.yml`）在每次 push 和 PR 时把同一套测试跑在 **Linux + Windows × Node 22 / 24** 四组环境上，并额外验证一次空会话目录不许崩。之所以要跨平台跑：工作区路径解码是按 Windows 目录形态写的，Linux 上跑一遍才能确认统计逻辑没被平台假设绑住。

## 兼容性

- **Node ≥ 22.15**（内置 zstd 需要）。更低版本会直接提示升级，不需要 `npm install` 任何东西。
- **会话格式随 DSH 演进**：`source.kind`、`origin`、目录编码都是内部实现，升级后可能失效。会尽力跟进但不做保证——跑出异常结果时，先看报告里的 kind 表和版本号。
- 工作区路径解码（`--E-~732B~732B~--` → `E:\猫猫迷宫`）只按 Windows 目录形态验证过；Linux/macOS 上只影响路径显示，不影响统计数字。

## License

MIT，见 [LICENSE](LICENSE)。版权行现在写的是 "The dsh-session-word-stats authors"，可以换成你自己的名字。

> **push 前两处待替换**：顶部徽章地址里的 `YOUR_NAME` 换成你的 GitHub 用户名或组织名（换成真实地址后徽章才会亮，否则是破图）；以及上面提到的版权行。
