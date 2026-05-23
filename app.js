const form = document.querySelector("#analyze-form");
const input = document.querySelector("#symbol");
const metricGrid = document.querySelector("#metric-grid");
const warning = document.querySelector("#warning");
const compareForm = document.querySelector("#compare-form");
const compareInput = document.querySelector("#compare-symbols");
const suggestionBox = document.querySelector("#search-suggestions");
let trendZoom = 1;
let latestTrendSeries = null;
let currentData = null;
let currentMemoText = "";
let searchTimer = null;
let searchAbort = null;
const storageKeys = {
  history: "munger.history",
  watchlist: "munger.watchlist",
};

const fmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const moneyFmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const explanations = {
  "营收复合增长": "公司收入在几年里的平均增长速度。可以理解为生意规模有没有持续变大。",
  "ROIC": "投入资本回报率。简单说，就是公司每投入 1 元资本，能赚回多少经营利润。",
  "自由现金流率": "公司收入里有多少最终变成可自由支配的现金。越高，说明赚钱更实在。",
  "护城河评分": "用资本回报、利润率、增长和抗风险能力，估算公司优势是否容易被竞争对手侵蚀。",
  "财报质量": "检查利润有没有变成现金、股本有没有稀释、债务压力是否过大。",
  "现金利润转换": "看账面净利润最终有多少变成了自由现金流。比例越高，说明利润更像真钱，而不是只停留在会计报表上。",
  "自由现金流连续性": "检查过去几年自由现金流是否持续为正。长期投资更偏好现金流稳定产生的公司。",
  "利润率稳定性": "观察经营利润率波动大不大。波动越小，通常说明定价权、成本控制或商业模式更稳。",
  "股本稀释": "看公司有没有持续增发股票。股数增加会摊薄每股价值，回购则可能提高长期股东收益。",
  "净债务压力": "比较净债务和收入或现金流的压力。债务越重，公司穿越周期时越容易被迫做不利决策。",
  "净债务 / FCF": "用自由现金流偿还净债务大约需要几年。越低，财务压力通常越小。",
  "P / FCF": "市值相当于自由现金流的多少倍。它比市盈率更关注真实现金。",
  "保守内在价值": "用较谨慎假设估算的每股价值。它不是精确答案，只是安全边际参考。",
  "乐观价值": "在更乐观增长和折现假设下的估值，用来观察上行情景。",
  "市场修正价值": "在保守价值和乐观价值之间，根据近期价格变化、财报滞后和市场隐含预期做的证据加权情景。它不是目标价，而是提醒你市场变化可能需要重新验证。",
  "安全边际": "估算价值高出现价的空间。空间越大，越能抵御判断错误。",
  "芒格式四象限": "把公司拆成质量、持久性、管理层、估值四个方向，帮助先排除明显不合格的标的。",
  "安全边际模块": "比较当前价格和估算价值。价值投资通常希望用明显低于价值的价格买入。",
  "市场隐含增长": "当前股价大致要求公司未来达到的增长速度。数字越高，市场期待越高。",
  "护城河证据": "看公司高回报是否有可持续原因，而不只是短期景气。",
  "财报质量模块": "寻找利润漂亮但现金、债务、稀释等不够健康的情况。",
  "估值情景与买入区间": "用多种假设估值，并给出带安全边际的参考买入价。",
  "数据可信度": "展示财报覆盖年份、报价时间、缺失字段和估值可信度。它帮助你先判断这份分析能不能直接用于研究。",
  "可调估值模型": "用自己的增长、折现率、永续增长和安全边际假设重算 DCF。固定模型给方向，调参模型用来做压力测试。",
  "市场变化校准": "把最新股价、过去几个月价格带、财报滞后和反向 DCF 放在一起看。它不会把市场情绪直接算成价值，只提示市场正在押注哪些变化。",
};

const mungerQuotes = [
  {
    test: (data) => (data.metrics?.marginOfSafety ?? 0) < 0,
    quote: "The big money is not in the buying or selling, but in the waiting.",
    note: "好公司不等于好价格。价格提前反映太多变化时，等待本身就是纪律。",
  },
  {
    test: (data) => (data.marketContext?.score ?? 0) >= 72,
    quote: "A great business at a fair price is superior to a fair business at a great price.",
    note: "如果市场变化有证据支撑，可以把情景上修，但仍要确认这真是伟大生意。",
  },
  {
    test: (data) => (data.accountingQuality?.score ?? 0) < 65,
    quote: "All I want to know is where I'm going to die, so I'll never go there.",
    note: "财报质量先排雷。现金流、债务和稀释不干净时，估值再漂亮也要慢一点。",
  },
  {
    test: () => true,
    quote: "Invert, always invert.",
    note: "先问什么会让这个判断错，再决定要不要继续研究。",
  },
];

function display(value, suffix = "", fallback = "--") {
  if (!Number.isFinite(value)) return fallback;
  return `${fmt.format(value)}${suffix}`;
}

function money(value, currency = "USD") {
  if (!Number.isFinite(value)) return "--";
  return `${currency} ${moneyFmt.format(value)}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function compactMoney(value, currency = "USD") {
  if (!Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${currency} ${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${currency} ${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${currency} ${(value / 1e6).toFixed(2)}M`;
  return `${currency} ${moneyFmt.format(value)}`;
}

function setText(id, text) {
  document.querySelector(id).textContent = text;
}

function infoButton(label) {
  const text = explanations[label];
  return text ? `<button type="button" class="info-button" data-info="${label}" aria-label="解释 ${label}">i</button>` : "";
}

function labelWithInfo(label) {
  return `<span class="label-with-info">${label}${infoButton(label)}</span>`;
}

function metricCard(label, value, note) {
  const div = document.createElement("article");
  div.className = "metric";
  div.innerHTML = `${labelWithInfo(label)}<strong>${value}</strong><small>${note}</small>`;
  return div;
}

function readStoredList(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeStoredList(key, value) {
  localStorage.setItem(key, JSON.stringify(value.slice(0, 18)));
}

function upsertStoredItem(key, item) {
  const list = readStoredList(key).filter((entry) => entry.symbol !== item.symbol);
  list.unshift(item);
  writeStoredList(key, list);
  renderStoredLists();
}

function removeStoredItem(key, symbol) {
  writeStoredList(key, readStoredList(key).filter((entry) => entry.symbol !== symbol));
  renderStoredLists();
}

function renderStoredLists() {
  const renderList = (selector, key, emptyText) => {
    const list = readStoredList(key);
    document.querySelector(selector).innerHTML = list.length
      ? list.map((item) => `<button type="button" data-load-symbol="${escapeHtml(item.symbol)}">
          <strong>${escapeHtml(item.symbol)}</strong>
          <span>${escapeHtml(item.name || item.verdict || "")}</span>
        </button>`).join("")
      : `<p>${emptyText}</p>`;
  };
  renderList("#watchlist", storageKeys.watchlist, "还没有收藏的公司。");
  renderList("#history-list", storageKeys.history, "分析后会自动记录。");
}

function hideSuggestions() {
  suggestionBox.hidden = true;
  suggestionBox.innerHTML = "";
}

function renderSuggestions(results) {
  if (!results.length || document.activeElement !== input) {
    hideSuggestions();
    return;
  }
  suggestionBox.innerHTML = results.map((item) => `
    <button type="button" data-suggest-symbol="${escapeHtml(item.symbol)}">
      <strong>${escapeHtml(item.symbol)}</strong>
      <span>${escapeHtml(item.name || item.symbol)}</span>
      <small>${escapeHtml([item.exchange, item.sector].filter(Boolean).join(" · ") || item.source || "")}</small>
    </button>
  `).join("");
  suggestionBox.hidden = false;
}

async function searchSymbols(query) {
  const value = query.trim();
  if (value.length < 2) {
    hideSuggestions();
    return;
  }
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(value)}`, { signal: searchAbort.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "搜索不可用");
    renderSuggestions(data.results || []);
  } catch (error) {
    if (error.name !== "AbortError") hideSuggestions();
  }
}

function renderMetrics(data) {
  const m = data.metrics;
  const c = data.company;
  const mc = data.marketContext || {};
  const cards = [
    ["营收复合增长", display(m.revenueGrowth, "%"), "近年经营规模扩张速度"],
    ["ROIC", display(m.roic, "%"), "芒格偏爱的资本效率指标"],
    ["自由现金流率", display(m.fcfMargin, "%"), "利润转化为现金的质量"],
    ["护城河评分", display(data.moat?.score), data.moat?.level || "基于资本效率与利润质量"],
    ["财报质量", display(data.accountingQuality?.score), data.accountingQuality?.label || "现金利润与红旗检查"],
    ["净债务 / FCF", display(m.debtToFcf, "x"), "偿债压力，越低越好"],
    ["P / FCF", display(m.pfcf, "x"), "现金流估值倍数"],
    ["保守内在价值", money(m.intrinsicValue, c.currency), "10 年 DCF，含安全折扣"],
    ["乐观价值", money(m.optimisticValue, c.currency), "较高增长、较低折现率情景"],
    ["市场修正价值", money(mc.marketAwareValue, c.currency), "财报滞后后的证据加权情景"],
    ["安全边际", display(m.marginOfSafety, "%"), "保守价值相对现价的折让"],
  ];
  metricGrid.replaceChildren(...cards.map(([label, value, note]) => metricCard(label, value, note)));
}

function dcfPerShare(fcfMillions, sharesMillions, growth, terminalGrowth, discountRate, years = 10) {
  if (!fcfMillions || !sharesMillions || fcfMillions <= 0 || sharesMillions <= 0) return null;
  let pv = 0;
  let cash = fcfMillions;
  for (let year = 1; year <= years; year += 1) {
    cash *= 1 + growth;
    pv += cash / Math.pow(1 + discountRate, year);
  }
  const terminal = (cash * (1 + terminalGrowth)) / Math.max(discountRate - terminalGrowth, 0.01);
  pv += terminal / Math.pow(1 + discountRate, years);
  return pv / sharesMillions;
}

function latestFinite(values) {
  return [...(values || [])].reverse().find(Number.isFinite) ?? null;
}

function getSharesMillions(data) {
  const price = data?.company?.price;
  const marketCap = data?.company?.marketCap;
  if (!price || !marketCap) return null;
  return marketCap / price / 1_000_000;
}

function decisionAction(data) {
  const score = data.scores?.overall ?? 0;
  const mos = data.metrics?.marginOfSafety;
  if (score >= 78 && mos >= 15) return "继续深度尽调";
  if (score >= 68 && mos < 0) return "好公司，等价格";
  if (score >= 58) return "只放入观察";
  return "暂时排除";
}

function renderDecisionStrip(data) {
  const risks = [
    data.metrics?.marginOfSafety < 0 ? "价格高于保守价值" : null,
    data.metrics?.impliedGrowth > 12 ? "市场隐含增长偏高" : null,
    data.marketContext?.premiumToBull > 20 ? "现价高于乐观情景较多" : null,
    data.moat?.risks?.[0] || null,
    data.accountingQuality?.flags?.find((flag) => flag.status === "fail")?.detail || null,
  ].filter(Boolean);
  setText("#action-label", decisionAction(data));
  setText("#risk-label", risks[0] || "暂未出现单一主风险");
  setText("#discipline-label", `先验证 ${data.marketContext?.lens?.label || "市场变化"}`);
}

function buildMungerConclusion(data) {
  const m = data.metrics || {};
  const c = data.company || {};
  const action = decisionAction(data);
  const moat = data.moat?.level || "护城河待验证";
  const accounting = data.accountingQuality?.label || "财报质量待复核";
  const implied = Number.isFinite(m.impliedGrowth) ? `市场大约要求 ${display(m.impliedGrowth, "%")} 的隐含增长` : "市场隐含增长暂时算不清";
  const priceLine = Number.isFinite(m.marginOfSafety) && m.marginOfSafety >= 15
    ? `价格给了 ${display(m.marginOfSafety, "%")} 的安全边际`
    : `价格没有给出足够安全边际，当前安全边际为 ${display(m.marginOfSafety, "%")}`;
  const inversion = data.accountingQuality?.score < 65
    ? "先反过来问：这些利润到底是不是现金，债务和库存会不会在坏年份伤人。"
    : data.moat?.score < 68
      ? "先反过来问：如果竞争者拿走定价权，这些漂亮数字还能不能留下。"
      : "先反过来问：如果增长放慢、估值回到平常年份，这笔买入还会不会舒服。";
  const temperament = action === "好公司，等价格"
    ? "这类公司最容易让人因为喜欢生意而忘记价格，正确动作通常是把它放在桌上，等市场犯错。"
    : action === "继续深度尽调"
      ? "它值得继续研究，但研究的目的不是寻找兴奋点，而是寻找会推翻判断的事实。"
      : action === "只放入观察"
        ? "它还没到可以下注的程度，观察比行动更便宜，也更符合纪律。"
        : "这不是需要急着证明自己聪明的地方，排除平庸机会本身就是投资收益的一部分。";
  return `${c.shortName || c.symbol} 的结论是：${action}。${moat}，${accounting}；${priceLine}，${implied}。${inversion}${temperament}`;
}

function renderMungerConclusion(data) {
  setText("#munger-conclusion", buildMungerConclusion(data));
}

function renderDataQuality(data) {
  const quality = data.dataQuality || {};
  const years = quality.fiscalYears || data.series?.years || [];
  const missing = quality.missingFields?.length ? quality.missingFields.join("、") : "未发现核心字段缺失";
  const fallbacks = quality.fallbackFields?.length ? quality.fallbackFields.join("；") : "未使用明显替代口径";
  setText("#quality-confidence", `可信度 ${quality.confidence || "中"}`);
  document.querySelector("#data-quality-panel").innerHTML = [
    ["财报覆盖", years.length ? `${years[0]}-${years.at(-1)}，${years.length} 年` : "--"],
    ["报价时间", quality.quoteTime || "未返回"],
    ["缺失字段", missing],
    ["替代口径", fallbacks],
    ["来源", `${quality.filingSource || "SEC EDGAR"} / ${quality.quoteSource || "Stooq"}`],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
}

function marketToneClass(score) {
  if (score >= 72) return "strong";
  if (score >= 55) return "watch";
  return "stretched";
}

function renderMarketContext(data) {
  const context = data.marketContext || {};
  const tape = context.tape || {};
  const currency = data.company.currency;
  const tone = marketToneClass(context.score || 0);
  document.querySelector(".market-brief").className = `market-brief panel ${tone}`;
  setText("#market-summary", `${context.level || "市场变化待确认"}。${context.lens?.upside || "用价格带和反向 DCF 判断市场正在押注什么。"}`);
  setText("#market-aware-value", money(context.marketAwareValue, currency));
  setText("#market-return-3m", display(Number.isFinite(tape.return3m) ? tape.return3m * 100 : null, "%"));
  setText("#market-score", Number.isFinite(context.score) ? `${context.score}/100` : "--");
  setText("#market-lens-label", context.lens?.label || "--");

  const bridge = (context.bridge || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const evidence = (context.lens?.evidence || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  document.querySelector("#market-context-panel").innerHTML = `
    <div class="market-bridge">
      <article>
        <span>财报滞后</span>
        <strong>${Number.isFinite(context.lagMonths) ? `${context.lagMonths} 个月` : "--"}</strong>
        <p>年报负责事实，市场价格负责预期；两者之间要用证据桥接。</p>
      </article>
      <article>
        <span>市场修正空间</span>
        <strong>${display(context.valuationGap, "%")}</strong>
        <p>市场修正价值相对现价的空间，不等同于买入建议。</p>
      </article>
      <article>
        <span>1 年价格变化</span>
        <strong>${display(Number.isFinite(tape.return1y) ? tape.return1y * 100 : null, "%")}</strong>
        <p>价格带帮助识别财报之后的预期迁移。</p>
      </article>
    </div>
    <div class="market-evidence">
      <div>
        <strong>市场正在定价</strong>
        <ul>${bridge}</ul>
      </div>
      <div>
        <strong>把价值上修前要验证</strong>
        <ul>${evidence}</ul>
        <p>${escapeHtml(context.lens?.risk || "")}</p>
      </div>
    </div>`;
}

function renderMungerQuote(data) {
  const match = mungerQuotes.find((item) => item.test(data));
  setText("#munger-quote", match.quote);
  setText("#quote-note", match.note);
}

function updateCustomValuation() {
  if (!currentData) return;
  const growth = Number(document.querySelector("#growth-input").value) / 100;
  const discount = Number(document.querySelector("#discount-input").value) / 100;
  const terminal = Number(document.querySelector("#terminal-input").value) / 100;
  const safety = Number(document.querySelector("#safety-input").value) / 100;
  setText("#growth-value", display(growth * 100, "%"));
  setText("#discount-value", display(discount * 100, "%"));
  setText("#terminal-value", display(terminal * 100, "%"));
  setText("#safety-value", `${Math.round(safety * 100)}%`);

  const fcf = latestFinite(currentData.series?.freeCashFlow);
  const shares = getSharesMillions(currentData);
  const value = dcfPerShare(fcf, shares, growth, terminal, discount);
  const buyPrice = value ? value * (1 - safety) : null;
  const margin = value && currentData.company.price ? (value - currentData.company.price) / currentData.company.price : null;
  document.querySelector("#custom-valuation").innerHTML = [
    ["自定义内在价值", money(value, currentData.company.currency)],
    ["纪律买入价", money(buyPrice, currentData.company.currency)],
    ["相对现价空间", display(margin ? margin * 100 : null, "%")],
  ].map(([label, valueText]) => `<article><span>${label}</span><strong>${valueText}</strong></article>`).join("");
}

function seedCustomModel(data) {
  const normalizedGrowth = Math.max(-2, Math.min(15, ((data.metrics?.revenueGrowth || 0) + (data.metrics?.fcfGrowth || 0)) / 2));
  document.querySelector("#growth-input").value = Number.isFinite(normalizedGrowth) ? normalizedGrowth.toFixed(1) : 4;
  document.querySelector("#discount-input").value = 10;
  document.querySelector("#terminal-input").value = 2.5;
  document.querySelector("#safety-input").value = 30;
  updateCustomValuation();
}

function closeInfoPopover() {
  document.querySelector("#info-popover").hidden = true;
  document.querySelectorAll(".info-button.active").forEach((button) => button.classList.remove("active"));
}

function openInfoPopover(button) {
  const key = button.dataset.info;
  const text = explanations[key];
  if (!text) return;
  const popover = document.querySelector("#info-popover");
  setText("#info-title", key.replace("模块", ""));
  setText("#info-body", text);
  document.querySelectorAll(".info-button.active").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  popover.hidden = false;
  const rect = button.getBoundingClientRect();
  const gap = 8;
  const left = Math.min(rect.left, window.innerWidth - popover.offsetWidth - 14);
  const top = rect.bottom + popover.offsetHeight + gap > window.innerHeight
    ? Math.max(14, rect.top - popover.offsetHeight - gap)
    : rect.bottom + gap;
  popover.style.left = `${Math.max(14, left)}px`;
  popover.style.top = `${top}px`;
}

function radarPoint(cx, cy, r, angle, value) {
  const rad = (Math.PI / 180) * angle;
  return [cx + Math.cos(rad) * r * value, cy + Math.sin(rad) * r * value];
}

function renderRadar(scores) {
  const svg = document.querySelector("#radar");
  const axes = [
    ["质量", scores.quality, -90],
    ["持久性", scores.durability, 0],
    ["管理层", scores.management, 90],
    ["估值", scores.valuation, 180],
  ];
  const cx = 140;
  const cy = 130;
  const maxR = 76;
  const rings = [0.25, 0.5, 0.75, 1]
    .map((level) => {
      const pts = axes.map(([, , angle]) => radarPoint(cx, cy, maxR, angle, level).join(",")).join(" ");
      return `<polygon points="${pts}" fill="none" stroke="#d9dfda" />`;
    })
    .join("");
  const lines = axes
    .map(([label, score, angle]) => {
      const [x, y] = radarPoint(cx, cy, maxR, angle, 1);
      const [tx, ty] = radarPoint(cx, cy, maxR + 25, angle, 1);
      return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#d9dfda" />
        <text x="${tx}" y="${ty}" text-anchor="middle" dominant-baseline="middle" font-size="11">${label} ${score}</text>`;
    })
    .join("");
  const area = axes.map(([, score, angle]) => radarPoint(cx, cy, maxR, angle, score / 100).join(",")).join(" ");
  svg.innerHTML = `${rings}${lines}<polygon points="${area}" fill="rgba(12,107,88,.24)" stroke="#0c6b58" stroke-width="3" /><circle cx="${cx}" cy="${cy}" r="3" fill="#0c6b58" />`;
}

function renderValuation(data) {
  const { company, metrics } = data;
  const values = [
    ["当前价格", company.price, "price"],
    ["保守内在价值", metrics.intrinsicValue, ""],
    ["市场修正价值", data.marketContext?.marketAwareValue, "market"],
    ["乐观价值", metrics.optimisticValue, ""],
  ];
  const max = Math.max(...values.map(([, v]) => Number.isFinite(v) ? v : 0), 1);
  document.querySelector("#valuation-bars").innerHTML = values
    .map(([label, value, cls]) => {
      const width = Number.isFinite(value) ? Math.max(3, (value / max) * 100) : 0;
      return `<div class="bar-row">
        <label><span>${label}</span><strong>${money(value, company.currency)}</strong></label>
        <div class="bar-track"><div class="bar-fill ${cls}" style="width:${width}%"></div></div>
      </div>`;
    })
    .join("");
  setText("#implied-growth", display(metrics.impliedGrowth, "%"));
}

function polyline(values, x0, y0, w, h, min, max) {
  return values.map((v, i) => {
    const x = x0 + (w * i) / Math.max(values.length - 1, 1);
    const y = y0 + h - ((v - min) / Math.max(max - min, 1)) * h;
    return `${x},${y}`;
  }).join(" ");
}

function renderTrend(series) {
  latestTrendSeries = series;
  const svg = document.querySelector("#trend-chart");
  const tooltip = document.querySelector("#trend-tooltip");
  const zoomLabel = document.querySelector("#trend-zoom-label");
  const rows = [
    ["收入", series.revenue, "#285f8f"],
    ["经营利润", series.operatingIncome, "#0c6b58"],
    ["自由现金流", series.freeCashFlow, "#ba5b2f"],
  ];
  const all = rows.flatMap(([, arr]) => arr).filter(Number.isFinite);
  const min = Math.min(0, ...all);
  const max = Math.max(...all, 1);
  const x0 = 62;
  const y0 = 26;
  const w = 675;
  const h = 230;
  const viewWidth = 780 / trendZoom;
  const viewHeight = 320 / trendZoom;
  const viewX = (780 - viewWidth) / 2;
  const viewY = (320 - viewHeight) / 2;
  svg.setAttribute("viewBox", `${viewX} ${viewY} ${viewWidth} ${viewHeight}`);
  zoomLabel.textContent = `${Math.round(trendZoom * 100)}%`;

  const xForIndex = (i) => x0 + (w * i) / Math.max(series.years.length - 1, 1);
  const yForValue = (v) => y0 + h - ((v - min) / Math.max(max - min, 1)) * h;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((p) => {
    const y = y0 + h * p;
    const value = max - (max - min) * p;
    return `<line x1="${x0}" y1="${y}" x2="${x0 + w}" y2="${y}" stroke="#e3e7e3" />
      <text x="12" y="${y + 4}" font-size="12">${fmt.format(value)}</text>`;
  }).join("");
  const lines = rows.map(([label, values, color]) =>
    `<polyline points="${polyline(values, x0, y0, w, h, min, max)}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />
     ${values.map((v, i) => {
       const x = xForIndex(i);
       const y = yForValue(v);
       return `<circle cx="${x}" cy="${y}" r="4" fill="${color}" />`;
     }).join("")}`
  ).join("");
  const labels = series.years.map((year, i) => {
    const x = xForIndex(i);
    return `<text x="${x}" y="${y0 + h + 32}" text-anchor="middle" font-size="12">${year}</text>`;
  }).join("");
  const legend = rows.map(([label, , color], i) =>
    `<circle cx="${x0 + i * 118}" cy="304" r="5" fill="${color}" /><text x="${x0 + 11 + i * 118}" y="308" font-size="13">${label}</text>`
  ).join("");
  const hoverDots = rows.map(([label, , color], i) =>
    `<circle class="hover-dot" data-label="${label}" cx="0" cy="0" r="5.5" fill="${color}" stroke="#fff" stroke-width="2" opacity="0" />`
  ).join("");
  svg.innerHTML = `${grid}${lines}<g id="trend-hover" opacity="0">
    <line id="trend-hover-line" x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + h}" stroke="#18201d" stroke-dasharray="4 5" />
    ${hoverDots}
  </g><rect id="trend-hit-area" x="${x0}" y="${y0}" width="${w}" height="${h}" fill="transparent" />${labels}${legend}`;

  const hoverGroup = svg.querySelector("#trend-hover");
  const hoverLine = svg.querySelector("#trend-hover-line");
  const hoverPoints = [...svg.querySelectorAll(".hover-dot")];
  const hitArea = svg.querySelector("#trend-hit-area");

  function moveTooltip(event) {
    const rect = svg.getBoundingClientRect();
    const svgX = viewX + (event.clientX - rect.left) * (viewWidth / rect.width);
    const nearest = Math.max(0, Math.min(series.years.length - 1, Math.round(((svgX - x0) / w) * (series.years.length - 1))));
    const x = xForIndex(nearest);
    hoverGroup.setAttribute("opacity", "1");
    hoverLine.setAttribute("x1", x);
    hoverLine.setAttribute("x2", x);
    rows.forEach(([, values], rowIndex) => {
      hoverPoints[rowIndex].setAttribute("cx", x);
      hoverPoints[rowIndex].setAttribute("cy", yForValue(values[nearest]));
      hoverPoints[rowIndex].setAttribute("opacity", "1");
    });

    tooltip.hidden = false;
    tooltip.innerHTML = `<strong>${series.years[nearest]}</strong>${rows.map(([label, values, color]) =>
      `<div><span><i style="background:${color}"></i>${label}</span><b>${fmt.format(values[nearest])} 百万</b></div>`
    ).join("")}`;
    const wrapRect = svg.parentElement.getBoundingClientRect();
    const left = Math.min(event.clientX - wrapRect.left + 14, wrapRect.width - tooltip.offsetWidth - 10);
    const top = Math.max(8, event.clientY - wrapRect.top - tooltip.offsetHeight - 12);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  hitArea.addEventListener("pointermove", moveTooltip);
  hitArea.addEventListener("pointerleave", () => {
    hoverGroup.setAttribute("opacity", "0");
    tooltip.hidden = true;
  });
}

function updateTrendZoom(nextZoom) {
  trendZoom = Math.max(1, Math.min(2.5, nextZoom));
  if (latestTrendSeries) renderTrend(latestTrendSeries);
}

function renderChecklist(data) {
  document.querySelector("#checklist").innerHTML = data.checklist.map(([label, pass]) =>
    `<div class="check-item ${pass ? "" : "fail"}">
      <span class="check-icon">${pass ? "✓" : "!"}</span>
      <strong>${label}</strong>
    </div>`
  ).join("");
}

function renderMoat(data) {
  const moat = data.moat;
  if (!moat) return;
  setText("#moat-level", `${moat.level} · ${moat.score}`);
  const sources = moat.sources.map((item) =>
    `<article class="evidence-item">
      <header><strong>${item.name}</strong><span>${item.score}</span></header>
      <p>${item.evidence}</p>
    </article>`
  );
  const risks = (moat.risks || []).map((risk) =>
    `<article class="evidence-item risk">
      <header><strong>反证风险</strong><span>核查</span></header>
      <p>${risk}</p>
    </article>`
  );
  document.querySelector("#moat-panel").innerHTML = [...sources, ...risks].join("");
}

function renderAccountingQuality(data) {
  const quality = data.accountingQuality;
  if (!quality) return;
  setText("#accounting-label", `${quality.label} · ${quality.score}`);
  const statusText = { pass: "通过", watch: "观察", fail: "红旗" };
  document.querySelector("#accounting-panel").innerHTML = quality.flags.map((item) =>
    `<article class="quality-item ${item.status}">
      <header><strong>${labelWithInfo(item.label)}</strong><span>${statusText[item.status] || ""}</span></header>
      <p>${item.detail}</p>
    </article>`
  ).join("");
}

function renderScenarios(data) {
  const scenarios = data.valuationScenarios;
  if (!scenarios) return;
  setText("#expectation-label", scenarios.currentExpectation);
  const allCases = [
    ...scenarios.cases,
    {
      name: "市场修正情景",
      value: data.marketContext?.marketAwareValue,
      assumptions: `${data.marketContext?.lens?.label || "市场变化"}：证据加权，不直接追价`,
    },
  ];
  const cases = allCases.map((item) =>
    `<article class="scenario-item">
      <header><strong>${item.name}</strong><span>DCF</span></header>
      <b class="scenario-value">${money(item.value, data.company.currency)}</b>
      <p>${item.assumptions}</p>
    </article>`
  );
  const buyZones = scenarios.buyZones.map((item) =>
    `<article class="scenario-item">
      <header><strong>${item.label}</strong><span>${item.note}</span></header>
      <b class="scenario-value">${money(item.value, data.company.currency)}</b>
      <p>${item.label === "当前价格" ? "对照内在价值和隐含增长，判断是否值得继续等待。" : "用安全边际抵消估值错误和商业判断错误。"}</p>
    </article>`
  );
  document.querySelector("#scenario-panel").innerHTML = [...cases, ...buyZones].join("");
}

function buildMemoText(data) {
  const m = data.metrics;
  const c = data.company;
  const ideal = data.valuationScenarios?.buyZones?.[0]?.value;
  const questions = [
    m.impliedGrowth > 12 ? "市场隐含增长是否真的能被未来现金流兑现？" : "长期增长来自价格、销量还是回购？",
    data.moat?.risks?.[0] || "高 ROIC 能否被竞争格局和客户黏性解释？",
    data.accountingQuality?.flags?.find((flag) => flag.status !== "pass")?.detail || "现金流质量在周期压力下是否仍然稳定？",
  ];
  return [
    `# ${c.shortName} (${c.symbol}) 投资备忘录`,
    "",
    `结论：${decisionAction(data)}。${data.verdict}`,
    `价格：现价 ${money(c.price, c.currency)}；理想买入价约 ${money(ideal, c.currency)}；安全边际 ${display(m.marginOfSafety, "%")}。`,
    `市场再定价：${data.marketContext?.level || "--"}；市场修正价值 ${money(data.marketContext?.marketAwareValue, c.currency)}；近 3 个月 ${display(Number.isFinite(data.marketContext?.tape?.return3m) ? data.marketContext.tape.return3m * 100 : null, "%")}。`,
    `质量：ROIC ${display(m.roic, "%")}，自由现金流率 ${display(m.fcfMargin, "%")}，护城河 ${data.moat?.level || "--"}。`,
    `财报：${data.accountingQuality?.label || "--"}，数据可信度 ${data.dataQuality?.confidence || "中"}。`,
    "",
    "买入前必须验证：",
    ...questions.map((item, index) => `${index + 1}. ${item}`),
    "",
    `数据源：${data.source}`,
  ].join("\n");
}

function renderMemo(data) {
  const m = data.metrics;
  const c = data.company;
  const moat = data.moat?.score >= 78
    ? `公司呈现${data.moat.level}特征，资本效率、利润率和现金流质量支持长期复利假设。`
    : `公司护城河判断为“${data.moat?.level || "待验证"}”，仍需用年报和行业竞争格局解释这些数字为什么能持续。`;
  const accounting = data.accountingQuality?.score >= 70
    ? `财报质量为“${data.accountingQuality.label}”，现金利润转换和红旗检查暂未构成主要阻碍。`
    : `财报质量为“${data.accountingQuality?.label || "待复核"}”，买入前需要逐项核查现金流、稀释和债务。`;
  const price = Number.isFinite(m.marginOfSafety) && m.marginOfSafety > 15
    ? "当前价格相对保守估值留出一定空间，可以继续做业务和竞争格局尽调。"
    : "当前价格没有明显安全边际，除非你对长期增长有高确定性，否则需要更谨慎的买入价。";
  const market = data.marketContext?.score >= 72
    ? `市场变化评分 ${data.marketContext.score}/100，可以把“${data.marketContext.lens?.label || "市场变化"}”纳入上修假设，但必须等待后续财报验证。`
    : `市场变化评分 ${data.marketContext?.score ?? "--"}/100，更像预期迁移而非已经确认的内在价值提升。`;
  const questions = [
    m.impliedGrowth > 12 ? "市场隐含增长偏高，先证明未来现金流能跟上。" : "拆分长期增长来源：销量、价格、回购和利润率。",
    data.moat?.risks?.[0] || "用年报、竞争对手和客户结构验证护城河来源。",
    data.accountingQuality?.flags?.find((flag) => flag.status !== "pass")?.detail || "继续跟踪现金流是否保持干净。",
  ];
  currentMemoText = buildMemoText(data);
  document.querySelector("#memo").innerHTML = [
    ["动作", `${decisionAction(data)}。${data.verdict}`],
    ["生意质量", moat],
    ["财报可信度", accounting],
    ["市场变化", market],
    ["价格判断", `${price} 现价为 ${money(c.price, c.currency)}，理想买入价约 ${money(data.valuationScenarios?.buyZones?.[0]?.value, c.currency)}。`],
    ["买入前验证", `<ol>${questions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`],
  ].map(([title, body]) => `<div class="memo-block"><strong>${title}</strong>${body}</div>`).join("");
}

async function compareSymbols(symbols) {
  if (!currentData) return;
  const unique = [...new Set([currentData.company.symbol, ...symbols].map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 5);
  const table = document.querySelector("#compare-table");
  table.innerHTML = `<p>对比中...</p>`;
  const results = await Promise.all(unique.map(async (symbol) => {
    try {
      const res = await fetch(`/api/analyze?symbol=${encodeURIComponent(symbol)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "数据不可用");
      return { symbol, data };
    } catch (error) {
      return { symbol, error };
    }
  }));
  table.innerHTML = `<div class="compare-row compare-head">
      <span>公司</span><span>总分</span><span>ROIC</span><span>FCF率</span><span>P/FCF</span><span>动作</span>
    </div>${results.map(({ symbol, data, error }) => {
      if (error) return `<div class="compare-row error"><strong>${escapeHtml(symbol)}</strong><span>${escapeHtml(error.message)}</span></div>`;
      return `<div class="compare-row">
        <strong>${escapeHtml(data.company.symbol)}</strong>
        <span>${data.scores.overall}</span>
        <span>${display(data.metrics.roic, "%")}</span>
        <span>${display(data.metrics.fcfMargin, "%")}</span>
        <span>${display(data.metrics.pfcf, "x")}</span>
        <span>${decisionAction(data)}</span>
      </div>`;
    }).join("")}`;
}

function render(data) {
  currentData = data;
  const c = data.company;
  setText("#company-name", `${c.shortName} (${c.symbol})`);
  setText("#sector", `${c.sector || "--"} · ${c.industry || "--"}`);
  setText("#currency", c.currency || "USD");
  setText("#price", moneyFmt.format(c.price));
  setText("#source", data.source);
  setText("#verdict", data.verdict);
  setText("#overall-score", data.scores.overall);
  document.querySelector("#overall-ring").style.setProperty("--score", data.scores.overall);
  warning.hidden = !(data.warning || data.notice);
  warning.textContent = data.warning || data.notice || "";
  renderMungerConclusion(data);
  renderDecisionStrip(data);
  renderDataQuality(data);
  renderMarketContext(data);
  renderMungerQuote(data);
  renderMetrics(data);
  renderRadar(data.scores);
  renderValuation(data);
  renderTrend(data.series);
  renderChecklist(data);
  renderMoat(data);
  renderAccountingQuality(data);
  renderScenarios(data);
  seedCustomModel(data);
  renderMemo(data);
  upsertStoredItem(storageKeys.history, {
    symbol: c.symbol,
    name: c.shortName,
    verdict: decisionAction(data),
    analyzedAt: new Date().toISOString(),
  });
}

async function analyze(symbol) {
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  button.textContent = "分析中";
  warning.hidden = true;
  setText("#munger-conclusion", "正在用反向思考、护城河和安全边际重读这家公司。");
  try {
    const res = await fetch(`/api/analyze?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();
    if (!res.ok) {
      warning.hidden = false;
      warning.textContent = `${data.message || "真实数据暂不可用"} ${data.hint || ""}`.trim();
      setText("#source", "真实数据查询失败");
      document.querySelector("#compare-table").innerHTML = "";
      return;
    }
    render(data);
    compareSymbols(compareInput.value.split(","));
  } catch (error) {
    warning.hidden = false;
    warning.textContent = `网络或本地服务暂时不可用：${error.message}。请确认 node server.js 仍在运行后重试。`;
  } finally {
    button.disabled = false;
    button.textContent = "分析";
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  hideSuggestions();
  analyze(input.value.trim() || "AAPL");
});

input.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchSymbols(input.value), 220);
});

input.addEventListener("focus", () => {
  if (suggestionBox.innerHTML.trim()) suggestionBox.hidden = false;
});

document.querySelectorAll("[data-symbol]").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.symbol;
    hideSuggestions();
    analyze(input.value);
  });
});

document.addEventListener("click", (event) => {
  const suggestButton = event.target.closest("[data-suggest-symbol]");
  if (suggestButton) {
    input.value = suggestButton.dataset.suggestSymbol;
    hideSuggestions();
    analyze(input.value);
    return;
  }
  const loadButton = event.target.closest("[data-load-symbol]");
  if (loadButton) {
    input.value = loadButton.dataset.loadSymbol;
    hideSuggestions();
    analyze(input.value);
    return;
  }
  if (!event.target.closest(".search-box")) hideSuggestions();
});

document.querySelector("#save-current").addEventListener("click", () => {
  if (!currentData) return;
  upsertStoredItem(storageKeys.watchlist, {
    symbol: currentData.company.symbol,
    name: currentData.company.shortName,
    verdict: decisionAction(currentData),
    savedAt: new Date().toISOString(),
  });
});

document.querySelector("#clear-history").addEventListener("click", () => {
  writeStoredList(storageKeys.history, []);
  renderStoredLists();
});

document.querySelector("#watchlist").addEventListener("contextmenu", (event) => {
  const button = event.target.closest("[data-load-symbol]");
  if (!button) return;
  event.preventDefault();
  removeStoredItem(storageKeys.watchlist, button.dataset.loadSymbol);
});

compareForm.addEventListener("submit", (event) => {
  event.preventDefault();
  compareSymbols(compareInput.value.split(","));
});

document.querySelectorAll(".model-grid input").forEach((control) => {
  control.addEventListener("input", updateCustomValuation);
});

document.querySelector("#copy-memo").addEventListener("click", async () => {
  if (!currentMemoText) return;
  await navigator.clipboard.writeText(currentMemoText);
  document.querySelector("#copy-memo").textContent = "已复制";
  setTimeout(() => {
    document.querySelector("#copy-memo").textContent = "复制";
  }, 1200);
});

document.querySelector("#download-memo").addEventListener("click", () => {
  if (!currentData || !currentMemoText) return;
  const blob = new Blob([currentMemoText], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${currentData.company.symbol}-memo.md`;
  link.click();
  URL.revokeObjectURL(url);
});

document.addEventListener("click", (event) => {
  const button = event.target.closest(".info-button");
  const popover = document.querySelector("#info-popover");
  if (button) {
    event.stopPropagation();
    if (!popover.hidden && button.classList.contains("active")) {
      closeInfoPopover();
    } else {
      openInfoPopover(button);
    }
    return;
  }
  if (!event.target.closest("#info-popover")) closeInfoPopover();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeInfoPopover();
});

document.querySelector("#trend-zoom-in").addEventListener("click", () => updateTrendZoom(trendZoom + 0.25));
document.querySelector("#trend-zoom-out").addEventListener("click", () => updateTrendZoom(trendZoom - 0.25));
document.querySelector("#trend-zoom-reset").addEventListener("click", () => updateTrendZoom(1));

renderStoredLists();
analyze(input.value);
