/**
 * 把统计结果渲染成一个自包含的 HTML 仪表盘。
 *
 * 刻意不放任何外部资源：没有 CDN、没有 Google Fonts、没有图片文件。
 * 图表全部用手写 SVG 和内联 CSS 画——报告能离线打开、能发给别人看，
 * 不会因为对方的网络环境变成一堆空白方块。
 */

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const nf = (n) => Number(n ?? 0).toLocaleString("zh-CN");

/** 横向条形榜：宽度用百分比，交给 CSS 过渡动画 */
function barList(rows, { render = (r) => r.term, max, unit = "条" } = {}) {
  if (!rows.length) return `<p class="empty">没有数据</p>`;
  const top = max ?? Math.max(...rows.map((r) => r.docs ?? r.count));
  return rows
    .map((r, i) => {
      const v = r.docs ?? r.count;
      const pct = top ? (v / top) * 100 : 0;
      return `<li class="bar-row">
        <span class="bar-rank">${String(i + 1).padStart(2, "0")}</span>
        <span class="bar-label" title="${esc(render(r))}">${esc(render(r))}</span>
        <span class="bar-track"><span class="bar-fill" style="--w:${pct.toFixed(1)}%"></span></span>
        <span class="bar-value">${nf(v)}<small>${unit}</small></span>
      </li>`;
    })
    .join("");
}

/** 月度趋势：SVG 面积 + 折线 + 数据点 */
function trendChart(byMonth) {
  if (!byMonth.length) return `<p class="empty">没有数据</p>`;
  const W = 720;
  // 高度按卡片的实际可用空间给足，否则 grid 拉高卡片后会留下大片空白
  const H = 470;
  const padL = 48;
  const padR = 16;
  const padT = 24;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const max = Math.max(...byMonth.map((m) => m.count)) || 1;
  // 上沿只留 12% 余量；再对齐到一个整十/整百的数，避免刻度出现 1,237 这种
  const raw = max * 1.12;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const top = Math.ceil(raw / mag) * mag;

  const x = (i) =>
    padL + (byMonth.length === 1 ? innerW / 2 : (i / (byMonth.length - 1)) * innerW);
  const y = (v) => padT + innerH - (v / top) * innerH;

  const pts = byMonth.map((m, i) => [x(i), y(m.count)]);
  const line = pts.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)},${b.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${padT + innerH} L${pts[0][0].toFixed(1)},${padT + innerH} Z`;

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const gy = padT + innerH * f;
      const val = Math.round(top * (1 - f));
      return `<line class="grid" x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}"/>
              <text class="axis" x="${padL - 10}" y="${(gy + 4).toFixed(1)}" text-anchor="end">${nf(val)}</text>`;
    })
    .join("");

  const lastIdx = byMonth.length - 1;
  const dots = byMonth
    .map((m, i) => {
      const [cx, cy] = pts[i];
      const label = `${Number(m.month.slice(5))}月`;
      const partial = i === lastIdx ? `<tspan class="xnote">*</tspan>` : "";
      return `<circle class="dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4">
                <title>${esc(m.month)}：${nf(m.count)} 条</title>
              </circle>
              <text class="xlabel" x="${cx.toFixed(1)}" y="${H - 12}" text-anchor="middle">${esc(label)}${partial}</text>`;
    })
    .join("");

  return `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img"
              aria-label="按月消息数趋势：${byMonth.map((m) => `${m.month} ${m.count} 条`).join("，")}">
    ${grid}
    <path class="area" d="${area}"/>
    <path class="line" d="${line}"/>
    ${dots}
  </svg>
  <p class="hint" style="margin:8px 0 0"><span class="xnote">*</span> 当月尚未结束</p>`;
}

/** 占比条：把真人 / 按钮 / 注入三类拆开看 */
function compositionBar(data) {
  const human = data.humanMessages ?? data.messages;
  const auto = data.autoContinuations ?? 0;
  const injected = Object.entries(data.sourceKinds ?? {})
    .filter(([k]) => k !== "user")
    .reduce((a, [, v]) => a + v, 0);
  const total = human + auto + injected || 1;
  const seg = [
    { key: "human", label: "真人输入", v: human, cls: "seg-human" },
    { key: "auto", label: "按钮「继续」", v: auto, cls: "seg-auto" },
    { key: "inj", label: "引擎注入", v: injected, cls: "seg-inj" },
  ];
  const bars = seg
    .filter((s) => s.v > 0)
    .map(
      (s) =>
        `<span class="seg ${s.cls}" style="--w:${((s.v / total) * 100).toFixed(2)}%"
               title="${s.label}：${nf(s.v)} 条"></span>`
    )
    .join("");
  const legend = seg
    .map(
      (s) => `<li><span class="swatch ${s.cls}"></span>${s.label}
        <b>${nf(s.v)}</b><small>${((s.v / total) * 100).toFixed(1)}%</small></li>`
    )
    .join("");

  // 注入内容 Top3：解释"引擎往会话里塞了多少东西"
  const topInjected = Object.entries(data.sourceKinds ?? {})
    .filter(([k]) => k !== "user")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const injList = topInjected.length
    ? `<ul class="inject-list">${topInjected
        .map(([k, v]) => `<li><code>${esc(k)}</code><b>${nf(v)}</b></li>`)
        .join("")}</ul>
       <p class="hint" style="margin:8px 0 0">注入最多的三类，全都不是你说的话</p>`
    : "";

  // 提取漏斗：从文件一路筛到真人消息，把"数据怎么来的"讲清楚
  const funnel = [
    { label: "会话文件", v: data.scannedFiles },
    { label: "有输入", v: data.matchedSessions },
    { label: "消息", v: data.messages },
    { label: "真人", v: human },
  ]
    .map(
      (s) => `<li><b>${nf(s.v)}</b><span>${s.label}</span></li>`
    )
    .join("");

  return `<div class="compose"><div class="compose-bar">${bars}</div><ul class="legend">${legend}</ul>
    <ul class="funnel">${funnel}</ul>${injList}</div>`;
}

/** 短指令占比：一条双色进度 */
function shortRatio(data) {
  const human = data.humanMessages ?? data.messages;
  const short = data.shortMessages ?? 0;
  const pct = human ? (short / human) * 100 : 0;
  return `<div class="ratio">
    <div class="ratio-bar"><span style="--w:${pct.toFixed(1)}%"></span></div>
    <div class="ratio-legend">
      <span><b>${nf(short)}</b> 条 ≤8 字 <small>${pct.toFixed(0)}%</small></span>
      <span><b>${nf(human - short)}</b> 条 &gt;8 字 <small>${(100 - pct).toFixed(0)}%</small></span>
    </div>
  </div>`;
}

function kpi(label, value, sub) {
  return `<div class="kpi">
    <span class="kpi-label">${esc(label)}</span>
    <span class="kpi-value">${value}</span>
    ${sub ? `<span class="kpi-sub">${sub}</span>` : ""}
  </div>`;
}

export function renderHtml(data) {
  const verDesc = Object.entries(data.versions ?? {})
    .map(([v, n]) => `v${v} × ${n}`)
    .join(" · ");
  const generated = new Date(data.generatedAt ?? Date.now()).toLocaleString("zh-CN");
  const human = data.humanMessages ?? data.messages;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>会话输入词频统计 · dsh-wordstats</title>
<style>
:root{
  --bg:#0b1120; --bg-soft:#111a2e; --card:#131e33; --card-hi:#182741;
  --line:#24344f; --fg:#e6edf7; --fg-dim:#93a4bd; --fg-mute:#64748b;
  --brand:#3b82f6; --brand-soft:#1d4ed8; --accent:#f59e0b;
  --human:#38bdf8; --auto:#f59e0b; --inj:#475569;
  --radius:14px; --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.24);
}
@media (prefers-color-scheme: light){
  :root{
    --bg:#f6f8fc; --bg-soft:#eef2f9; --card:#ffffff; --card-hi:#f8fafc;
    --line:#dde5f0; --fg:#0f172a; --fg-dim:#475569; --fg-mute:#64748b;
    --brand:#1e40af; --brand-soft:#3b82f6; --accent:#b45309;
    --human:#0284c7; --auto:#d97706; --inj:#94a3b8;
    --shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.06);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--fg);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
  font-size:15px; line-height:1.6;
  padding:32px 20px 64px;
}
.wrap{max-width:1080px;margin:0 auto}
header.hero{margin-bottom:28px}
.eyebrow{color:var(--brand);font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600}
h1{font-size:clamp(24px,4vw,34px);line-height:1.25;margin:6px 0 10px;letter-spacing:-.02em}
.meta{color:var(--fg-dim);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 16px}
.meta b{color:var(--fg);font-weight:600}

.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0 28px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow)}
.kpi-label{display:block;font-size:12px;color:var(--fg-dim);margin-bottom:6px}
.kpi-value{display:block;font-size:26px;font-weight:650;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;font-family:ui-monospace,"SF Mono",Consolas,monospace}
.kpi-sub{display:block;font-size:12px;color:var(--fg-mute);margin-top:2px}

.grid{display:grid;gap:16px}
@media(min-width:900px){.grid.two{grid-template-columns:1fr 1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow)}
.card h2{font-size:15px;margin:0 0 4px;font-weight:650;letter-spacing:-.01em}
.card .hint{font-size:12px;color:var(--fg-mute);margin:0 0 16px}

ul.bars{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.bar-row{display:grid;grid-template-columns:26px minmax(64px,148px) 1fr 56px;align-items:center;gap:10px;padding:5px 0;border-radius:6px}
.bar-row:hover{background:var(--card-hi)}
.bar-rank{font-size:11px;color:var(--fg-mute);font-variant-numeric:tabular-nums}
.bar-label{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{height:8px;background:var(--bg-soft);border-radius:99px;overflow:hidden}
.bar-fill{display:block;height:100%;width:var(--w);border-radius:99px;
  background:linear-gradient(90deg,var(--brand-soft),var(--brand));
  transition:width .7s cubic-bezier(.2,.8,.2,1)}
.bar-value{text-align:right;font-size:13px;font-variant-numeric:tabular-nums}
.bar-value small{color:var(--fg-mute);font-size:11px;margin-left:2px}

svg.trend{width:100%;height:auto;display:block;overflow:visible}
svg.trend .grid{stroke:var(--line);stroke-width:1;stroke-dasharray:3 4}
svg.trend .axis,svg.trend .xlabel{fill:var(--fg-mute);font-size:11px;font-family:ui-monospace,Consolas,monospace}
svg.trend .xnote{fill:var(--accent);font-weight:600}
.hint .xnote{color:var(--accent)}
ul.inject-list{list-style:none;margin:18px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
ul.inject-list li{display:flex;justify-content:space-between;font-size:12.5px;color:var(--fg-dim);padding-bottom:6px;border-bottom:1px solid var(--line)}
ul.funnel{list-style:none;margin:18px 0 0;padding:14px 0 0;display:flex;align-items:center;gap:4px;border-top:1px solid var(--line)}
ul.funnel li{flex:1;text-align:center;position:relative}
ul.funnel li+li::before{content:"";position:absolute;left:-2px;top:50%;width:4px;height:4px;border-right:1px solid var(--fg-mute);border-top:1px solid var(--fg-mute);transform:translateY(-50%) rotate(45deg)}
ul.funnel b{display:block;font-family:ui-monospace,Consolas,monospace;font-size:15px;color:var(--fg);font-variant-numeric:tabular-nums}
ul.funnel span{display:block;font-size:11px;color:var(--fg-mute);margin-top:2px}
ul.inject-list li:last-child{border-bottom:none}
ul.inject-list code{background:var(--bg-soft);padding:1px 6px;border-radius:4px;font-size:11.5px}
ul.inject-list b{color:var(--fg);font-variant-numeric:tabular-nums}
svg.trend .line{fill:none;stroke:var(--brand);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
svg.trend .area{fill:var(--brand);opacity:.14}
svg.trend .dot{fill:var(--bg);stroke:var(--brand);stroke-width:2.5;transition:r .15s}
svg.trend .dot:hover{r:6}

.compose-bar{display:flex;height:14px;border-radius:99px;overflow:hidden;background:var(--bg-soft)}
.seg{display:block;width:var(--w);height:100%}
.seg-human{background:var(--human)}
.seg-auto{background:var(--auto)}
.seg-inj{background:var(--inj)}
ul.legend{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:8px 20px;font-size:12px;color:var(--fg-dim)}
ul.legend li{display:flex;align-items:center;gap:7px}
ul.legend b{color:var(--fg);font-variant-numeric:tabular-nums}
ul.legend small{color:var(--fg-mute)}
.swatch{width:9px;height:9px;border-radius:2px;display:inline-block}

.ratio-bar{height:10px;border-radius:99px;background:var(--bg-soft);overflow:hidden}
.ratio-bar span{display:block;height:100%;width:var(--w);background:linear-gradient(90deg,var(--accent),#fbbf24);border-radius:99px}
.ratio-legend{display:flex;justify-content:space-between;margin-top:10px;font-size:12px;color:var(--fg-dim)}
.ratio-legend b{color:var(--fg);font-variant-numeric:tabular-nums}

.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{background:var(--bg-soft);border:1px solid var(--line);border-radius:99px;padding:5px 12px;font-size:12.5px;color:var(--fg-dim)}
.chip b{color:var(--fg);font-variant-numeric:tabular-nums;margin-left:5px}

details.quotes summary{cursor:pointer;font-size:13px;color:var(--fg-dim);padding:6px 0}
details.quotes summary:hover{color:var(--fg)}
details.quotes ol{margin:8px 0 0;padding-left:20px;font-size:13px;color:var(--fg-dim);line-height:1.75}
details.quotes li{margin-bottom:4px}

table.kind{width:100%;border-collapse:collapse;font-size:12.5px}
table.kind td{padding:5px 0;border-bottom:1px solid var(--line);color:var(--fg-dim)}
table.kind td:last-child{text-align:right;font-variant-numeric:tabular-nums;color:var(--fg)}
table.kind tr:last-child td{border-bottom:none}

footer{margin-top:36px;padding-top:20px;border-top:1px solid var(--line);color:var(--fg-mute);font-size:12px;line-height:1.8}
footer code{background:var(--bg-soft);padding:1px 5px;border-radius:4px;font-size:11.5px}
.empty{color:var(--fg-mute);font-size:13px;margin:0}
@media (prefers-reduced-motion: reduce){
  .bar-fill{transition:none}
  svg.trend .dot{transition:none}
}
</style>
</head>
<body>
<div class="wrap">

  <header class="hero">
    <div class="eyebrow">dsh-wordstats</div>
    <h1>你都跟 agent 说了些什么</h1>
    <div class="meta">
      <span>扫描 <b>${nf(data.scannedFiles)}</b> 个会话文件${verDesc ? `（${esc(verDesc)}）` : ""}</span>
      <span>有输入的会话 <b>${nf(data.matchedSessions)}</b> 个</span>
      <span>生成于 ${esc(generated)}</span>
    </div>
  </header>

  <div class="kpis">
    ${kpi("真人消息", nf(human), "你亲手打下的字")}
    ${kpi("总消息", nf(data.messages), `含 ${nf(data.autoContinuations)} 条按钮触发`)}
    ${kpi("汉字", nf(data.hanChars), "仅中文，不含英文")}
    ${kpi("短指令", (human ? ((data.shortMessages / human) * 100).toFixed(0) : 0) + "%", "≤8 字的消息占比")}
    ${kpi("会话文件", nf(data.scannedFiles), "含子代理会话")}
  </div>

  <div class="grid two">
    <section class="card">
      <h2>高频词</h2>
      <p class="hint">2–3 字，只统计真人的输入</p>
      <ul class="bars">${barList(data.words?.slice(0, 12) ?? [])}</ul>
    </section>

    <section class="card">
      <h2>月度趋势</h2>
      <p class="hint">按月消息条数</p>
      ${trendChart(data.byMonth ?? [])}
    </section>
  </div>

  <div class="grid two" style="margin-top:16px">
    <section class="card">
      <h2>消息构成</h2>
      <p class="hint">会话里所有 <code>user/message</code> 记录的去向</p>
      ${compositionBar(data)}
    </section>

    <section class="card">
      <h2>短指令 vs 长描述</h2>
      <p class="hint">≤8 字视作短指令</p>
      ${shortRatio(data)}
      <div style="margin-top:20px">
        <h2>工作区分布</h2>
        <p class="hint">按项目看你在哪说得最多</p>
        <ul class="bars">${barList((data.byWorkspace ?? []).slice(0, 8), {
          render: (r) => r.workspace,
          unit: "条",
        })}</ul>
      </div>
    </section>
  </div>

  <div class="grid two" style="margin-top:16px">
    <section class="card">
      <h2>高频短语</h2>
      <p class="hint">4 字以上，能看出你的固定说法</p>
      <ul class="bars">${barList(data.phrases?.slice(0, 12) ?? [])}</ul>
    </section>

    <section class="card">
      <h2>开口习惯</h2>
      <p class="hint">每条消息的前两个字</p>
      <ul class="bars">${barList(data.openers?.slice(0, 12) ?? [])}</ul>
    </section>
  </div>

  <div class="grid two" style="margin-top:16px">
    <section class="card">
      <h2>英文 / 技术词</h2>
      <p class="hint">常提的工具、模型、库</p>
      <div class="chips">
        ${(data.enTerms ?? [])
          .slice(0, 20)
          .map((t) => `<span class="chip">${esc(t.term)}<b>${nf(t.docs ?? t.count)}</b></span>`)
          .join("") || `<p class="empty">没有数据</p>`}
      </div>
    </section>

    <section class="card">
      <h2>被挡在统计外的东西</h2>
      <p class="hint">这些都不是你打的字</p>
      <table class="kind">
        ${Object.entries(data.sourceKinds ?? {})
          .slice(0, 10)
          .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${nf(v)}</td></tr>`)
          .join("")}
      </table>
    </section>
  </div>

  ${
    (data.repeated ?? []).length
      ? `<section class="card" style="margin-top:16px">
      <h2>反复输入的整句</h2>
      <p class="hint">复用的 prompt 模板，最能说明你在反复让 agent 干什么</p>
      <details class="quotes">
        <summary>展开 ${data.repeated.length} 条</summary>
        <ol>${data.repeated
          .slice(0, 15)
          .map((r) => `<li>${esc(r.text)} <b style="color:var(--fg)">×${nf(r.count)}</b></li>`)
          .join("")}</ol>
      </details>
    </section>`
      : ""
  }

  <footer>
    <p><b>口径</b>：只统计 <code>source.kind="user"</code> 的消息；界面「继续」按钮产生的正文由引擎写入，不计入任何词榜，只单独计数；<code>origin="subagent"</code> 的子代理会话整条排除。</p>
    <p>纯本地生成，不联网、不上传。数据来自 <code>~/.dsh/sessions</code>。</p>
  </footer>

</div>
</body>
</html>`;
}
