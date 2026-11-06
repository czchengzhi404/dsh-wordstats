# 更新日志

本项目的所有重要变更都记录在这里。

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- README 增加 test / release / license 三个徽章

## [0.1.0] - 2026-11-06

首个可用版本。

### 新增

- **会话输入词频统计**：从 `~/.dsh/sessions` 抽取用户本人输入，产出六类榜单——高频词、高频短语、消息开头惯用语、反复输入的整句、高频英文技术词、工作区与月份分布
- **多帧 zstd 逐帧解压**：append-only 会话日志每帧一条记录，Node 的流式解压只吐第一帧；按帧 magic `28 b5 2f fd` 切开逐帧解压，否则 7 MB 的会话只解析到开头 200 字节
- **四道口径过滤**：`source.kind` 白名单（排除 19 种引擎注入）、子代理会话整条排除、界面按钮消息排除、引擎附言剥离
- **中文近似分词**：n-gram + 最长覆盖减除（杀滑窗错位碎片）+ PMI 结合强度（杀跨词碎片）+ 虚词表，不依赖任何词典
- **CLI 参数**：`--sessions` / `--workspace` / `--since` / `--top` / `--out` / `--json` / `--include-subagents`
- **版本白名单**：认 v3 / v4 会话格式；未知版本显式警告并跳过，全都不认识时以退出码 2 收场，避免静默算成 0 条让人以为「我没说过话」
- **DSH 升级自查**：报告内附版本分布表、`source.kind` 分布表，以及 `source.form` 哨兵（引擎若改用 form 标注注入，会报警提示口径失效）
- **19 个测试**：17 个钉住统计口径，2 个钉住性能优化不改变结果；全部使用内存现造的脱敏 fixture，仓库不含任何真实对话
- **CI**：Linux + Windows × Node 22 / 24 四组环境，外加空会话目录不许崩的冒烟检查

### 变更

- **界面「继续」按钮消息不再计入词榜**。这类消息占重度使用会话的三到四成，正文由引擎写入；原先计入会把「继续」放大近 4 倍（648 条 → 真实 162 条）并稳居第一，而报告看起来完全正常。现在单独计数、在报告开头说明，词频只反映真人敲下的字
- **性能 7.5 秒 → 2.1 秒**：先只解首帧判 origin（子代理会话整篇跳过，省 24% 压缩字节）、其余帧在 Buffer 层过滤 `"user/message"`、行级预筛把 JSON.parse 从 2.7 秒降到 18 毫秒。未采用多线程——实测 8 个 worker 反而慢 2.8 倍
- **项目更名** `dsh-session-word-stats` → `dsh-wordstats`：`wordstats` 比 `wordfreq` 准确（产出不止频次）
- 报告新增图片消息披露：图文混排保留文字，纯图片计数后排除并写明

### 修复

- **对齐 DSH 0.2.2 的会话结构变化**：`content` 新增 `image` 块时，纯图片消息原会被静默丢弃；`source.form` 作为新哨兵字段检测 kind 过滤是否失效
- **CI 全部失败**：`node --test test/` 在 Node 22.23 上会把目录当成名为 `test` 的模块去 require，直接 `MODULE_NOT_FOUND`；改为显式列出测试文件

[未发布]: https://github.com/czchengzhi404/dsh-wordstats/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/czchengzhi404/dsh-wordstats/releases/tag/v0.1.0
