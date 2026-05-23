import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const secUserAgent = process.env.SEC_USER_AGENT || "munger-value-analyzer dongheng.li@example.local";
let tickerCache = null;
const yahooSearchCache = new Map();
const fxCache = new Map();

function n(value, fallback = null) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function pct(value) {
  return Number.isFinite(value) ? value * 100 : null;
}

function cagr(start, end, years) {
  if (!start || !end || start <= 0 || end <= 0 || years <= 0) return null;
  return Math.pow(end / start, 1 / years) - 1;
}

function avg(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function last(values) {
  return Array.isArray(values) && values.length ? values[values.length - 1] : null;
}

function scoreByBands(value, bands, invert = false) {
  if (!Number.isFinite(value)) return 45;
  for (const [threshold, score] of bands) {
    if (invert ? value <= threshold : value >= threshold) return score;
  }
  return invert ? 20 : 25;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function dcfPerShare(fcf, shares, growth, terminalGrowth, discountRate, years = 10) {
  if (!fcf || !shares || fcf <= 0 || shares <= 0) return null;
  let pv = 0;
  let cash = fcf;
  for (let year = 1; year <= years; year += 1) {
    cash *= 1 + growth;
    pv += cash / Math.pow(1 + discountRate, year);
  }
  const terminal = (cash * (1 + terminalGrowth)) / Math.max(discountRate - terminalGrowth, 0.01);
  pv += terminal / Math.pow(1 + discountRate, years);
  return pv / shares;
}

function reverseDcfGrowth(price, fcf, shares, terminalGrowth, discountRate) {
  if (!price || !fcf || !shares) return null;
  let low = -0.1;
  let high = 0.25;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    const value = dcfPerShare(fcf, shares, mid, terminalGrowth, discountRate);
    if (value === null) return null;
    if (value < price) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

function stdev(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return 0;
  const mean = avg(clean);
  return Math.sqrt(avg(clean.map((value) => Math.pow(value - mean, 2))));
}

function trend(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return null;
  return clean[clean.length - 1] - clean[0];
}

function buildMoatAnalysis({ roic, roe, operatingMargin, fcfMargin, revenueGrowth, fcfGrowth, debtToFcf }) {
  const efficiency = avg([
    scoreByBands(roic, [[0.25, 96], [0.18, 88], [0.12, 74], [0.08, 58]]),
    scoreByBands(roe, [[0.3, 92], [0.2, 82], [0.12, 66], [0.08, 52]]),
  ]);
  const pricingPower = avg([
    scoreByBands(operatingMargin, [[0.32, 94], [0.22, 84], [0.14, 68], [0.08, 52]]),
    scoreByBands(fcfMargin, [[0.24, 94], [0.16, 82], [0.09, 64], [0.04, 48]]),
  ]);
  const reinvestment = avg([
    scoreByBands(revenueGrowth, [[0.12, 90], [0.07, 78], [0.03, 62], [0.0, 45]]),
    scoreByBands(fcfGrowth, [[0.14, 92], [0.08, 78], [0.03, 60], [0.0, 42]]),
  ]);
  const resilience = avg([
    scoreByBands(debtToFcf, [[0.5, 92], [1.5, 80], [3, 62], [5, 44]], true),
    scoreByBands(fcfMargin, [[0.2, 88], [0.12, 74], [0.06, 58], [0.02, 40]]),
  ]);
  const score = Math.round(avg([efficiency * 1.2, pricingPower, reinvestment, resilience]));
  const level = score >= 82 ? "强护城河" : score >= 68 ? "可验证护城河" : score >= 52 ? "护城河不稳" : "缺少明显护城河";
  const sources = [
    {
      name: "资本效率",
      score: Math.round(efficiency),
      evidence: `ROIC ${pct(roic)?.toFixed(1) ?? "--"}%，ROE ${pct(roe)?.toFixed(1) ?? "--"}%。`,
    },
    {
      name: "定价权与利润率",
      score: Math.round(pricingPower),
      evidence: `经营利润率 ${pct(operatingMargin)?.toFixed(1) ?? "--"}%，自由现金流率 ${pct(fcfMargin)?.toFixed(1) ?? "--"}%。`,
    },
    {
      name: "可复投空间",
      score: Math.round(reinvestment),
      evidence: `营收 CAGR ${pct(revenueGrowth)?.toFixed(1) ?? "--"}%，FCF CAGR ${pct(fcfGrowth)?.toFixed(1) ?? "--"}%。`,
    },
    {
      name: "抗脆弱性",
      score: Math.round(resilience),
      evidence: `净债务 / FCF ${Number.isFinite(debtToFcf) ? debtToFcf.toFixed(1) : "--"}x。`,
    },
  ];
  const risks = [
    operatingMargin < 0.12 ? "利润率偏低，可能缺少持续定价权。" : null,
    roic < 0.1 ? "资本回报不足，优秀生意属性仍需证明。" : null,
    revenueGrowth < 0.02 ? "增长放缓，复利空间可能受限。" : null,
    debtToFcf > 3 ? "杠杆较高，周期压力会削弱长期持有体验。" : null,
  ].filter(Boolean);
  return { score, level, sources, risks };
}

function buildAccountingQuality({ revenue, operatingIncome, netIncome, freeCashFlow, shares, debt, cash }) {
  const latestNetIncome = last(netIncome);
  const latestFcf = last(freeCashFlow);
  const latestRevenue = last(revenue);
  const latestDebt = last(debt);
  const latestCash = last(cash);
  const fcfToNetIncome = latestNetIncome ? latestFcf / latestNetIncome : null;
  const fcfMarginSeries = revenue.map((value, index) => value ? freeCashFlow[index] / value : null);
  const operatingMarginSeries = revenue.map((value, index) => value ? operatingIncome[index] / value : null);
  const shareChange = shares[0] && last(shares) ? last(shares) / shares[0] - 1 : null;
  const netDebtToRevenue = latestRevenue ? Math.max(latestDebt - latestCash, 0) / latestRevenue : null;
  const fcfConsistency = freeCashFlow.filter((value) => value > 0).length / Math.max(freeCashFlow.length, 1);
  const marginVolatility = stdev(operatingMarginSeries);
  const score = Math.round(avg([
    scoreByBands(fcfToNetIncome, [[1.1, 92], [0.85, 78], [0.6, 58], [0.35, 38]]),
    clamp(fcfConsistency * 100, 10, 95),
    scoreByBands(marginVolatility, [[0.02, 88], [0.05, 72], [0.09, 52], [0.14, 34]], true),
    scoreByBands(shareChange, [[-0.05, 86], [0, 72], [0.05, 52], [0.12, 30]], true),
    scoreByBands(netDebtToRevenue, [[0.05, 88], [0.2, 72], [0.45, 52], [0.8, 32]], true),
  ]));
  const flags = [
    {
      label: "现金利润转换",
      status: fcfToNetIncome >= 0.85 ? "pass" : fcfToNetIncome >= 0.6 ? "watch" : "fail",
      detail: `FCF / 净利润为 ${Number.isFinite(fcfToNetIncome) ? fcfToNetIncome.toFixed(2) : "--"}x。`,
    },
    {
      label: "自由现金流连续性",
      status: fcfConsistency >= 0.75 ? "pass" : fcfConsistency >= 0.5 ? "watch" : "fail",
      detail: `${freeCashFlow.filter((value) => value > 0).length}/${freeCashFlow.length} 年自由现金流为正。`,
    },
    {
      label: "利润率稳定性",
      status: marginVolatility <= 0.05 ? "pass" : marginVolatility <= 0.09 ? "watch" : "fail",
      detail: `经营利润率波动约 ${(marginVolatility * 100).toFixed(1)} 个百分点。`,
    },
    {
      label: "股本稀释",
      status: shareChange <= 0 ? "pass" : shareChange <= 0.05 ? "watch" : "fail",
      detail: `期间股数变化 ${pct(shareChange)?.toFixed(1) ?? "--"}%。`,
    },
    {
      label: "净债务压力",
      status: netDebtToRevenue <= 0.2 ? "pass" : netDebtToRevenue <= 0.45 ? "watch" : "fail",
      detail: `净债务 / 收入为 ${pct(netDebtToRevenue)?.toFixed(1) ?? "--"}%。`,
    },
  ];
  return {
    score,
    label: score >= 80 ? "质量干净" : score >= 65 ? "基本可信" : score >= 50 ? "需要复核" : "红旗较多",
    flags,
    metrics: {
      fcfToNetIncome,
      fcfConsistency,
      marginVolatility: pct(marginVolatility),
      shareChange: pct(shareChange),
      netDebtToRevenue: pct(netDebtToRevenue),
      fcfMarginTrend: pct(trend(fcfMarginSeries)),
    },
  };
}

function buildValuationScenarios({ latestFcf, latestShares, price, intrinsicValue, optimisticValue, impliedGrowth, normalizedGrowth }) {
  const bear = dcfPerShare(latestFcf, latestShares, clamp(normalizedGrowth * 0.35, -0.02, 0.04), 0.015, 0.11);
  const base = intrinsicValue;
  const bull = optimisticValue;
  const conservativeBuy = base ? base * 0.7 : null;
  const fairBuy = base ? base * 0.85 : null;
  const currentExpectation = Number.isFinite(impliedGrowth)
    ? impliedGrowth > 0.12 ? "市场预期很高" : impliedGrowth > 0.07 ? "市场预期偏乐观" : impliedGrowth > 0.03 ? "市场预期温和" : "市场预期保守"
    : "无法估算市场预期";
  return {
    cases: [
      { name: "熊市情景", value: bear, assumptions: "低增长、更高折现率" },
      { name: "基准情景", value: base, assumptions: "保守增长、10% 折现率" },
      { name: "乐观情景", value: bull, assumptions: "较高增长、较低折现率" },
    ],
    buyZones: [
      { label: "理想买入价", value: conservativeBuy, note: "约 30% 安全边际" },
      { label: "可研究买入价", value: fairBuy, note: "约 15% 安全边际" },
      { label: "当前价格", value: price, note: currentExpectation },
    ],
    currentExpectation,
  };
}

function monthsBetween(dateLike, end = new Date()) {
  if (!dateLike) return null;
  const value = String(dateLike);
  const normalized = value.includes("-")
    ? value
    : `${value.slice(0, 4)}-${value.slice(4, 6) || "12"}-${value.slice(6, 8) || "31"}`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.round((end - date) / (1000 * 60 * 60 * 24 * 30.44)));
}

function inferIndustryLens(company) {
  const symbol = String(company.symbol || "").toUpperCase();
  const name = String(company.shortName || "").toLowerCase();
  const industry = String(company.industry || "").toLowerCase();
  const sector = String(company.sector || "").toLowerCase();
  const text = `${symbol} ${name} ${industry} ${sector}`;
  if (/NVDA|AMD|MU|INTC|AVGO|TSM|QCOM|ASML|semiconductor|chip|memory/.test(text)) {
    return {
      label: "半导体 / 存储周期",
      upside: "AI 算力、HBM / 存储价格、先进制程供给紧张可能让最新财报低估下一轮现金流。",
      evidence: ["订单和 backlog 是否继续上修", "毛利率是否随产品结构改善", "库存天数和资本开支是否支持周期上行"],
      risk: "周期股容易在景气高点看起来便宜，不能只用最近一个季度外推。",
    };
  }
  if (/AAPL|MSFT|GOOGL|META|AMZN|software|internet|cloud|technology/.test(text)) {
    return {
      label: "大型科技 / AI 再定价",
      upside: "市场可能在定价 AI 产品化、云需求恢复、服务收入或生态粘性的增量价值。",
      evidence: ["收入增长是否重新加速", "AI / 云资本开支能否转化为高回报现金流", "利润率是否在投入周期后保持稳定"],
      risk: "高预期会提前透支未来，任何增长放缓都会放大估值回撤。",
    };
  }
  if (/BRK|bank|financial|insurance|asset|capital/.test(text)) {
    return {
      label: "金融 / 资本配置",
      upside: "市场可能在定价利率环境、承保利润、投资组合再配置和回购纪律。",
      evidence: ["净息差或承保利润是否改善", "资本充足率是否支持回购", "账面价值增长是否跟上价格"],
      risk: "金融资产价值对利率和信用周期敏感，账面质量要优先于短期利润。",
    };
  }
  if (/consumer|retail|restaurant|brand|staples/.test(text)) {
    return {
      label: "消费品牌 / 定价权",
      upside: "市场可能在定价需求恢复、提价能力、渠道效率和品牌粘性。",
      evidence: ["同店或销量是否恢复", "毛利率是否能守住", "库存和促销是否回到健康水平"],
      risk: "消费品高估值需要持续复购和定价权，单次涨价不能代表长期护城河。",
    };
  }
  return {
    label: "通用市场再定价",
    upside: "市场可能在定价财报尚未反映的新订单、价格、成本、利率或竞争格局变化。",
    evidence: ["下一季收入指引是否变化", "利润率和现金流是否同步改善", "管理层是否用回购或资本开支验证信心"],
    risk: "缺少行业证据时，股价变化只能说明预期变化，不能直接证明内在价值变化。",
  };
}

function buildMarketContext(company, metrics) {
  const tape = company.marketTape || {};
  const lagMonths = monthsBetween(company.dataQuality?.latestFiled);
  const price = n(company.price);
  const base = metrics.intrinsicValue;
  const bull = metrics.optimisticValue;
  const impliedGrowth = metrics.impliedGrowth;
  const premiumToBase = price && base ? (price - base) / base : null;
  const premiumToBull = price && bull ? (price - bull) / bull : null;
  const oneYearReturn = tape.return1y;
  const quarterReturn = tape.return3m;
  const trendScore = avg([
    scoreByBands(quarterReturn, [[0.25, 88], [0.12, 76], [0.03, 62], [-0.08, 42]]),
    scoreByBands(oneYearReturn, [[0.45, 88], [0.2, 74], [0.05, 60], [-0.15, 38]]),
  ]);
  const expectationScore = avg([
    scoreByBands(impliedGrowth, [[0.03, 82], [0.07, 68], [0.12, 48], [0.18, 30]], true),
    scoreByBands(premiumToBull, [[-0.15, 82], [0, 66], [0.35, 44], [0.8, 24]], true),
  ]);
  const recencyScore = lagMonths === null ? 50 : clamp(100 - lagMonths * 5, 20, 92);
  const marketScore = Math.round(avg([trendScore, expectationScore * 1.15, recencyScore * 0.65]));
  const lens = inferIndustryLens(company);
  const level = marketScore >= 72
    ? "市场变化可纳入上修假设"
    : marketScore >= 55
      ? "市场变化需要证据确认"
      : "市场价格已提前透支较多";
  const marketAwareValue = base && bull
    ? base + (bull - base) * clamp((marketScore - 45) / 45, 0, 1)
    : null;
  const valuationGap = price && marketAwareValue ? (marketAwareValue - price) / price : null;
  const bridge = [
    lagMonths !== null ? `最新年报距今约 ${lagMonths} 个月，财报口径天然滞后。` : "无法精确计算财报滞后时间。",
    Number.isFinite(quarterReturn) ? `近 3 个月价格变化 ${pct(quarterReturn)?.toFixed(1)}%，市场预期已经变化。` : "缺少足够历史价格来判断近期再定价。",
    Number.isFinite(impliedGrowth) ? `当前价格要求约 ${pct(impliedGrowth)?.toFixed(1)}% 的长期 FCF 增长。` : "当前价格无法反推出稳定增长假设。",
    Number.isFinite(premiumToBase) ? `现价相对保守价值溢价 ${pct(premiumToBase)?.toFixed(1)}%。` : "保守价值暂不可比。",
  ];
  return {
    score: marketScore,
    level,
    lens,
    lagMonths,
    marketAwareValue,
    valuationGap: pct(valuationGap),
    premiumToBase: pct(premiumToBase),
    premiumToBull: pct(premiumToBull),
    bridge,
    tape,
  };
}

function analyze(company, source) {
  const f = company.financials;
  const revenue = f.revenue.map(Number);
  const operatingIncome = f.operatingIncome.map(Number);
  const netIncome = f.netIncome.map(Number);
  const freeCashFlow = f.freeCashFlow.map(Number);
  const bookValue = f.bookValue.map(Number);
  const debt = f.debt.map(Number);
  const cash = f.cash.map(Number);
  const shares = f.shares.map(Number);
  const years = Math.max(revenue.length - 1, 1);
  const latestRevenue = last(revenue);
  const latestOperatingIncome = last(operatingIncome);
  const latestNetIncome = last(netIncome);
  const latestFcf = last(freeCashFlow);
  const latestBook = last(bookValue);
  const latestDebt = last(debt);
  const latestCash = last(cash);
  const latestShares = last(shares);
  const price = n(company.price);
  const marketCap = n(company.marketCap) || (price && latestShares ? price * latestShares * 1_000_000 : null);
  const marketCapMillions = marketCap ? marketCap / 1_000_000 : null;
  const revenueGrowth = cagr(revenue[0], latestRevenue, years);
  const fcfGrowth = cagr(freeCashFlow[0], latestFcf, years);
  const operatingMargin = latestOperatingIncome && latestRevenue ? latestOperatingIncome / latestRevenue : null;
  const netMargin = latestNetIncome && latestRevenue ? latestNetIncome / latestRevenue : null;
  const roe = latestNetIncome && latestBook ? latestNetIncome / latestBook : null;
  const roic = latestOperatingIncome && latestBook && latestDebt && latestCash
    ? latestOperatingIncome * 0.79 / Math.max(latestBook + latestDebt - latestCash, 1)
    : null;
  const fcfMargin = latestFcf && latestRevenue ? latestFcf / latestRevenue : null;
  const debtToFcf = latestDebt && latestCash && latestFcf ? Math.max(latestDebt - latestCash, 0) / latestFcf : 0;
  const pe = marketCapMillions && latestNetIncome ? marketCapMillions / latestNetIncome : null;
  const pfcf = marketCapMillions && latestFcf ? marketCapMillions / latestFcf : null;
  const buybackYield = shares[0] && latestShares ? 1 - latestShares / shares[0] : null;
  const normalizedGrowth = clamp(avg([revenueGrowth, fcfGrowth].filter((x) => x !== null)) ?? 0.04, -0.02, 0.12);
  const conservativeGrowth = clamp(normalizedGrowth * 0.75, 0.01, 0.08);
  const intrinsicValue = dcfPerShare(latestFcf, latestShares, conservativeGrowth, 0.025, 0.1);
  const optimisticValue = dcfPerShare(latestFcf, latestShares, clamp(normalizedGrowth, 0.02, 0.12), 0.03, 0.09);
  const marginOfSafety = intrinsicValue && price ? (intrinsicValue - price) / price : null;
  const impliedGrowth = reverseDcfGrowth(price, latestFcf, latestShares, 0.025, 0.1);
  const moat = buildMoatAnalysis({ roic, roe, operatingMargin, fcfMargin, revenueGrowth, fcfGrowth, debtToFcf });
  const accountingQuality = buildAccountingQuality({ revenue, operatingIncome, netIncome, freeCashFlow, shares, debt, cash });
  const valuationScenarios = buildValuationScenarios({
    latestFcf,
    latestShares,
    price,
    intrinsicValue,
    optimisticValue,
    impliedGrowth,
    normalizedGrowth,
  });
  const marketContext = buildMarketContext(company, {
    intrinsicValue,
    optimisticValue,
    impliedGrowth,
  });

  const qualityScore = avg([
    scoreByBands(roic, [[0.25, 96], [0.18, 88], [0.12, 76], [0.08, 60]]),
    scoreByBands(roe, [[0.3, 94], [0.2, 84], [0.12, 70], [0.08, 56]]),
    scoreByBands(operatingMargin, [[0.32, 94], [0.22, 84], [0.14, 70], [0.08, 56]]),
    scoreByBands(fcfMargin, [[0.25, 95], [0.16, 84], [0.09, 68], [0.04, 52]]),
  ]);
  const durabilityScore = avg([
    scoreByBands(revenueGrowth, [[0.12, 92], [0.08, 82], [0.04, 68], [0.01, 54]]),
    scoreByBands(fcfGrowth, [[0.14, 94], [0.08, 82], [0.04, 66], [0.01, 52]]),
    scoreByBands(debtToFcf, [[0.5, 92], [1.5, 82], [3, 66], [5, 50]], true),
    scoreByBands(n(company.beta), [[0.8, 82], [1.1, 72], [1.4, 56], [1.8, 42]], true),
  ]);
  const managementScore = avg([
    scoreByBands(buybackYield, [[0.08, 88], [0.03, 76], [0.0, 62], [-0.03, 46]]),
    scoreByBands(debtToFcf, [[0.5, 90], [2, 76], [4, 58], [7, 40]], true),
    scoreByBands(fcfMargin, [[0.2, 88], [0.12, 76], [0.06, 58], [0.02, 42]]),
  ]);
  const valuationScore = avg([
    marginOfSafety === null ? 45 : clamp(50 + marginOfSafety * 140, 10, 98),
    scoreByBands(pfcf, [[16, 86], [24, 72], [34, 54], [45, 38]], true),
    scoreByBands(pe, [[18, 84], [26, 68], [38, 50], [55, 34]], true),
  ]);
  const overall = Math.round(avg([qualityScore * 1.25, durabilityScore, managementScore, valuationScore * 1.1]));

  const verdict = overall >= 82
    ? "高质量候选，值得进入深度尽调"
    : overall >= 68
      ? "质量可观，但价格或确定性需要继续验证"
      : overall >= 52
        ? "存在短板，只适合更高安全边际"
        : "暂不符合芒格式长期持有标准";

  const checklist = [
    ["能力圈清晰", qualityScore >= 65 && durabilityScore >= 58],
    ["长期经济特征优秀", qualityScore >= 78],
    ["资产负债表能扛周期", debtToFcf <= 3],
    ["自由现金流真实且可复投", fcfMargin >= 0.08 && fcfGrowth !== null && fcfGrowth > 0],
    ["管理层资本配置友好", managementScore >= 65],
    ["当前价格有安全边际", marginOfSafety !== null && marginOfSafety >= 0.15],
  ];

  return {
    source,
    generatedAt: new Date().toISOString(),
    company: {
      symbol: company.symbol,
      shortName: company.shortName,
      currency: company.currency,
      price,
      marketCap,
      beta: n(company.beta),
      sector: company.sector,
      industry: company.industry,
      profile: company.profile,
    },
    metrics: {
      revenueGrowth: pct(revenueGrowth),
      fcfGrowth: pct(fcfGrowth),
      operatingMargin: pct(operatingMargin),
      netMargin: pct(netMargin),
      fcfMargin: pct(fcfMargin),
      roe: pct(roe),
      roic: pct(roic),
      debtToFcf,
      pe,
      pfcf,
      buybackYield: pct(buybackYield),
      intrinsicValue,
      optimisticValue,
      marginOfSafety: pct(marginOfSafety),
      impliedGrowth: pct(impliedGrowth),
    },
    moat,
    accountingQuality,
    valuationScenarios,
    marketContext,
    scores: {
      overall,
      quality: Math.round(qualityScore),
      durability: Math.round(durabilityScore),
      management: Math.round(managementScore),
      valuation: Math.round(valuationScore),
    },
    verdict,
    checklist,
    series: {
      revenue,
      operatingIncome,
      netIncome,
      freeCashFlow,
      bookValue,
      years: revenue.map((_, i) => String(new Date().getFullYear() - revenue.length + 1 + i)),
    },
  };
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 MungerValueAnalyzer/1.0",
      "accept": "application/json,text/plain,*/*",
      ...headers,
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function yahooHeaders(extra = {}) {
  return {
    "user-agent": "Mozilla/5.0 MungerValueAnalyzer/1.0",
    "accept": "application/json,text/plain,*/*",
    ...extra,
  };
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 MungerValueAnalyzer/1.0",
      "accept": "text/plain,text/csv,*/*",
      ...headers,
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function csvCells(line) {
  return line.split(",").map((cell) => cell.trim());
}

function dateKey(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function returnSince(rows, days) {
  const clean = rows.filter((row) => Number.isFinite(row.close));
  if (clean.length < 2) return null;
  const latest = clean.at(-1);
  const targetTime = latest.date.getTime() - days * 24 * 60 * 60 * 1000;
  const start = [...clean].reverse().find((row) => row.date.getTime() <= targetTime) || clean[0];
  return start.close ? latest.close / start.close - 1 : null;
}

function annualizedVolatility(rows) {
  const clean = rows.filter((row) => Number.isFinite(row.close));
  if (clean.length < 30) return null;
  const returns = [];
  for (let i = 1; i < clean.length; i += 1) {
    returns.push(clean[i].close / clean[i - 1].close - 1);
  }
  return stdev(returns) * Math.sqrt(252);
}

function maxDrawdown(rows) {
  let peak = 0;
  let drawdown = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.close)) continue;
    peak = Math.max(peak, row.close);
    if (peak > 0) drawdown = Math.min(drawdown, row.close / peak - 1);
  }
  return drawdown;
}

async function fetchStooqQuote(symbol) {
  const stooqSymbol = `${symbol.toLowerCase().replace(/\./g, "-")}.us`;
  const csv = await fetchText(`https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&f=sd2t2ohlcv&h&e=csv`);
  const [headerLine, valueLine] = csv.trim().split(/\r?\n/);
  if (!headerLine || !valueLine) throw new Error("Stooq returned no quote");
  const headers = csvCells(headerLine);
  const values = csvCells(valueLine);
  const row = Object.fromEntries(headers.map((key, index) => [key, values[index]]));
  const close = n(row.Close);
  if (!close) throw new Error(`Stooq has no latest quote for ${symbol}`);
  return {
    price: close,
    currency: "USD",
    quoteTime: `${row.Date || ""} ${row.Time || ""}`.trim(),
    volume: n(row.Volume),
  };
}

async function fetchYahooChart(symbol, range = "1y", interval = "1d") {
  const normalized = symbol.toUpperCase();
  return fetchJson(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}?range=${range}&interval=${interval}`, yahooHeaders());
}

async function fetchYahooQuote(symbol) {
  const data = await fetchYahooChart(symbol, "5d", "1d");
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta?.regularMarketPrice) throw new Error(`Yahoo has no quote for ${symbol}`);
  return {
    symbol: meta.symbol || symbol,
    price: n(meta.regularMarketPrice),
    currency: meta.currency || "USD",
    quoteTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 19).replace("T", " ") : null,
    shortName: meta.shortName || meta.longName || symbol,
    longName: meta.longName || meta.shortName || symbol,
    exchangeName: meta.fullExchangeName || meta.exchangeName || "Yahoo Finance",
  };
}

async function fetchStooqHistory(symbol) {
  const stooqSymbol = `${symbol.toLowerCase().replace(/\./g, "-")}.us`;
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 420);
  const csv = await fetchText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&d1=${dateKey(start)}&d2=${dateKey(end)}&i=d`);
  const rows = csv.trim().split(/\r?\n/).slice(1)
    .map((line) => {
      const [date, open, high, low, close, volume] = csvCells(line);
      return {
        date: new Date(date),
        open: n(open),
        high: n(high),
        low: n(low),
        close: n(close),
        volume: n(volume),
      };
    })
    .filter((row) => !Number.isNaN(row.date.getTime()) && Number.isFinite(row.close));
  if (rows.length < 2) throw new Error("Stooq historical data unavailable");
  return {
    return3m: returnSince(rows, 91),
    return6m: returnSince(rows, 182),
    return1y: returnSince(rows, 365),
    volatility: annualizedVolatility(rows),
    maxDrawdown: maxDrawdown(rows),
    latestClose: rows.at(-1)?.close ?? null,
    observations: rows.length,
  };
}

async function fetchYahooHistory(symbol) {
  const normalized = symbol.toUpperCase();
  const data = await fetchYahooChart(normalized, "1y", "1d");
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const rows = timestamps.map((time, index) => ({
    date: new Date(time * 1000),
    close: n(closes[index]),
  })).filter((row) => !Number.isNaN(row.date.getTime()) && Number.isFinite(row.close));
  if (rows.length < 2) throw new Error("Yahoo chart returned insufficient data");
  return {
    return3m: returnSince(rows, 91),
    return6m: returnSince(rows, 182),
    return1y: returnSince(rows, 365),
    volatility: annualizedVolatility(rows),
    maxDrawdown: maxDrawdown(rows),
    latestClose: rows.at(-1)?.close ?? null,
    observations: rows.length,
    source: "Yahoo chart",
  };
}

async function fetchMarketTape(symbol) {
  try {
    const tape = await fetchStooqHistory(symbol);
    return { ...tape, source: "Stooq history" };
  } catch {
    return fetchYahooHistory(symbol).catch(() => null);
  }
}

async function searchYahooSymbols(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const cacheKey = q.toLowerCase();
  if (yahooSearchCache.has(cacheKey)) return yahooSearchCache.get(cacheKey);
  const data = await fetchJson(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&enableFuzzyQuery=true`, yahooHeaders());
  const quotes = (data.quotes || [])
    .filter((item) => item.quoteType === "EQUITY" && item.symbol)
    .map((item) => ({
      symbol: item.symbol,
      name: item.longname || item.shortname || item.symbol,
      exchange: item.exchDisp || item.exchange || "",
      sector: item.sectorDisp || item.sector || "",
      industry: item.industryDisp || item.industry || "",
      source: "Yahoo Finance",
    }));
  yahooSearchCache.set(cacheKey, quotes);
  return quotes;
}

function symbolCandidates(raw) {
  const value = String(raw || "").trim().toUpperCase();
  if (!value) return [];
  const clean = value.replace(/\s+/g, "");
  const candidates = [clean];
  if (/^\d{1,5}$/.test(clean)) {
    candidates.push(`${clean.padStart(4, "0")}.HK`);
  }
  if (/^\d{6}$/.test(clean)) {
    if (clean.startsWith("6") || clean.startsWith("9")) candidates.push(`${clean}.SS`);
    if (/^[023]/.test(clean)) candidates.push(`${clean}.SZ`);
    candidates.push(`${clean}.KS`, `${clean}.KQ`);
  }
  if (/^[A-Z]{1,5}$/.test(clean)) candidates.push(`${clean}.HK`, `${clean}.KS`);
  return [...new Set(candidates)];
}

async function resolveGlobalSymbol(input) {
  const candidates = symbolCandidates(input);
  for (const candidate of candidates) {
    try {
      await fetchYahooQuote(candidate);
      return candidate;
    } catch {
      // Try next normalized symbol.
    }
  }
  const results = await searchYahooSymbols(input);
  if (results[0]?.symbol) return results[0].symbol;
  throw new Error(`Cannot resolve symbol ${input}`);
}

function annualType(result, type) {
  return result.find((item) => item.meta?.type?.includes(type))?.[type] || [];
}

function yearlyMap(result, type) {
  const map = new Map();
  for (const item of annualType(result, type)) {
    const year = Number(String(item.asOfDate || "").slice(0, 4));
    const raw = n(item.reportedValue?.raw);
    const currency = item.currencyCode || null;
    if (year && Number.isFinite(raw)) map.set(year, { value: raw, currency, filed: item.asOfDate });
  }
  return map;
}

async function fetchFxRate(fromCurrency, toCurrency) {
  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) return 1;
  const pair = `${fromCurrency}${toCurrency}=X`;
  if (fxCache.has(pair)) return fxCache.get(pair);
  const quote = await fetchYahooQuote(pair);
  const rate = quote.price || 1;
  fxCache.set(pair, rate);
  return rate;
}

async function fetchYahooFundamentals(symbol, quote) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 10 * 366 * 24 * 60 * 60;
  const types = [
    "annualTotalRevenue",
    "annualOperatingIncome",
    "annualNetIncome",
    "annualFreeCashFlow",
    "annualStockholdersEquity",
    "annualTotalDebt",
    "annualCashCashEquivalentsAndShortTermInvestments",
    "annualDilutedAverageShares",
  ];
  const data = await fetchJson(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?type=${types.join(",")}&period1=${start}&period2=${end}`, yahooHeaders());
  const result = data?.timeseries?.result || [];
  const revenue = yearlyMap(result, "annualTotalRevenue");
  const operatingIncome = yearlyMap(result, "annualOperatingIncome");
  const netIncome = yearlyMap(result, "annualNetIncome");
  const freeCashFlow = yearlyMap(result, "annualFreeCashFlow");
  const equity = yearlyMap(result, "annualStockholdersEquity");
  const debt = yearlyMap(result, "annualTotalDebt");
  const cash = yearlyMap(result, "annualCashCashEquivalentsAndShortTermInvestments");
  const shares = yearlyMap(result, "annualDilutedAverageShares");
  const candidateYears = [...revenue.keys()]
    .filter((year) => netIncome.has(year) && freeCashFlow.has(year) && equity.has(year))
    .sort((a, b) => a - b)
    .slice(-4);
  if (candidateYears.length < 2) throw new Error(`${symbol} has insufficient Yahoo annual fundamentals`);
  const latestShares = valueForYear(shares, candidateYears.at(-1));
  const financialCurrency = revenue.get(candidateYears.at(-1))?.currency || quote.currency;
  const fx = await fetchFxRate(financialCurrency, quote.currency);
  const moneyToQuoteMillions = (value, fallback = null) => Number.isFinite(value) ? (value * fx) / 1_000_000 : fallback;
  const financials = {
    revenue: candidateYears.map((year) => moneyToQuoteMillions(valueForYear(revenue, year))),
    operatingIncome: candidateYears.map((year) => moneyToQuoteMillions(valueForYear(operatingIncome, year, valueForYear(netIncome, year)))),
    netIncome: candidateYears.map((year) => moneyToQuoteMillions(valueForYear(netIncome, year))),
    freeCashFlow: candidateYears.map((year) => moneyToQuoteMillions(valueForYear(freeCashFlow, year))),
    bookValue: candidateYears.map((year) => moneyToQuoteMillions(valueForYear(equity, year))),
    debt: candidateYears.map((year) => moneyToQuoteMillions(valueForYear(debt, year, 0), 0)),
    cash: candidateYears.map((year) => moneyToQuoteMillions(valueForYear(cash, year, 0), 0)),
    shares: candidateYears.map((year) => million(valueForYear(shares, year, latestShares))),
  };
  return {
    symbol: quote.symbol || symbol,
    shortName: quote.longName || quote.shortName || symbol,
    sector: "Global equity",
    industry: quote.exchangeName || "Yahoo Finance",
    profile: "Financial statements sourced from Yahoo Finance global fundamentals.",
    years: candidateYears.map(String),
    dataQuality: {
      fiscalYears: candidateYears.map(String),
      latestFiled: `${candidateYears.at(-1)}-12-31`,
      missingFields: [
        operatingIncome.size ? null : "经营利润",
        debt.size ? null : "债务",
        cash.size ? null : "现金",
        shares.size ? null : "稀释股数",
      ].filter(Boolean),
      fallbackFields: financialCurrency !== quote.currency
        ? [`财务报表币种 ${financialCurrency} 已按 Yahoo 汇率换算为交易币种 ${quote.currency}`]
        : [],
      sourceCoverage: `${candidateYears.length} 年 Yahoo 全球财务数据`,
      financialCurrency,
    },
    financials,
  };
}

async function fetchSecTickerMap() {
  if (tickerCache) return tickerCache;
  const json = await fetchJson("https://www.sec.gov/files/company_tickers.json", {
    "user-agent": secUserAgent,
  });
  tickerCache = Object.values(json).map((row) => ({
    cik: String(row.cik_str).padStart(10, "0"),
    ticker: String(row.ticker).toUpperCase(),
    title: row.title,
  }));
  return tickerCache;
}

function factItems(facts, concept, units = ["USD"]) {
  const fact = facts?.["us-gaap"]?.[concept] || facts?.dei?.[concept];
  if (!fact?.units) return [];
  for (const unit of units) {
    if (Array.isArray(fact.units[unit])) return fact.units[unit];
  }
  return Object.values(fact.units).find(Array.isArray) || [];
}

function chooseAnnualByFiscalYear(facts, concepts, units = ["USD"]) {
  const byYear = new Map();
  for (const concept of concepts) {
    for (const item of factItems(facts, concept, units)) {
      const form = String(item.form || "");
      const frame = String(item.frame || "");
      const frameYear = frame.match(/^CY(\d{4})(?:Q4I?)?$/)?.[1];
      const fy = n(frameYear || item.fy);
      const value = n(item.val);
      if (!fy || !Number.isFinite(value)) continue;
      if (!["10-K", "20-F", "40-F"].includes(form)) continue;
      if (item.fp && item.fp !== "FY") continue;
      const previous = byYear.get(fy);
      if (!previous || String(item.filed || "") > String(previous.filed || "")) {
        byYear.set(fy, { value, filed: item.filed, concept });
      }
    }
  }
  return byYear;
}

function valueForYear(map, year, fallback = null) {
  return map.get(year)?.value ?? fallback;
}

function million(value, fallback = null) {
  return Number.isFinite(value) ? value / 1_000_000 : fallback;
}

async function fetchSecFundamentals(symbol) {
  const normalized = symbol.toUpperCase().replace(/\./g, "-");
  const tickers = await fetchSecTickerMap();
  const match = tickers.find((row) => row.ticker === normalized);
  if (!match) throw new Error(`${symbol} is not in SEC ticker database`);
  const facts = await fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${match.cik}.json`, {
    "user-agent": secUserAgent,
  });
  const usgaap = facts.facts;
  const revenue = chooseAnnualByFiscalYear(usgaap, [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
  ]);
  const operatingIncome = chooseAnnualByFiscalYear(usgaap, ["OperatingIncomeLoss"]);
  const netIncome = chooseAnnualByFiscalYear(usgaap, ["NetIncomeLoss", "ProfitLoss"]);
  const operatingCash = chooseAnnualByFiscalYear(usgaap, ["NetCashProvidedByUsedInOperatingActivities"]);
  const capex = chooseAnnualByFiscalYear(usgaap, ["PaymentsToAcquirePropertyPlantAndEquipment"]);
  const equity = chooseAnnualByFiscalYear(usgaap, [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ]);
  const cash = chooseAnnualByFiscalYear(usgaap, [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ]);
  const debtCurrent = chooseAnnualByFiscalYear(usgaap, [
    "LongTermDebtCurrent",
    "LongTermDebtAndFinanceLeaseObligationsCurrent",
    "ShortTermBorrowings",
  ]);
  const debtLong = chooseAnnualByFiscalYear(usgaap, [
    "LongTermDebtNoncurrent",
    "LongTermDebtAndFinanceLeaseObligationsNoncurrent",
    "LongTermDebt",
  ]);
  const shares = chooseAnnualByFiscalYear(usgaap, [
    "WeightedAverageNumberOfDilutedSharesOutstanding",
    "WeightedAverageNumberOfSharesOutstandingDiluted",
    "WeightedAverageNumberOfSharesOutstandingBasic",
    "EntityCommonStockSharesOutstanding",
  ], ["shares"]);

  const candidateYears = [...revenue.keys()]
    .filter((year) => netIncome.has(year) && operatingCash.has(year) && equity.has(year))
    .sort((a, b) => a - b)
    .slice(-4);
  if (candidateYears.length < 2) throw new Error(`${symbol} has insufficient SEC annual fundamentals`);

  const latestShares = valueForYear(shares, candidateYears.at(-1));
  const fallbackSharesYears = candidateYears.filter((year) => !shares.has(year));
  const missingFields = [
    operatingIncome.size ? null : "经营利润",
    capex.size ? null : "资本开支",
    cash.size ? null : "现金",
    debtCurrent.size || debtLong.size ? null : "债务",
    shares.size ? null : "稀释股数",
  ].filter(Boolean);
  const financials = {
    revenue: candidateYears.map((year) => million(valueForYear(revenue, year))),
    operatingIncome: candidateYears.map((year) => million(valueForYear(operatingIncome, year, valueForYear(netIncome, year)))),
    netIncome: candidateYears.map((year) => million(valueForYear(netIncome, year))),
    freeCashFlow: candidateYears.map((year) => million(valueForYear(operatingCash, year) - Math.abs(valueForYear(capex, year, 0)))),
    bookValue: candidateYears.map((year) => million(valueForYear(equity, year))),
    debt: candidateYears.map((year) => million(Math.max(0, valueForYear(debtCurrent, year, 0)) + Math.max(0, valueForYear(debtLong, year, 0)), 0)),
    cash: candidateYears.map((year) => million(valueForYear(cash, year, 0), 0)),
    shares: candidateYears.map((year) => million(valueForYear(shares, year, latestShares))),
  };

  return {
    symbol: match.ticker.replace(/-/g, "."),
    shortName: facts.entityName || match.title,
    sector: "SEC filer",
    industry: "Public company",
    profile: "Financial statements sourced from SEC EDGAR company facts.",
    years: candidateYears.map(String),
    dataQuality: {
      fiscalYears: candidateYears.map(String),
      latestFiled: Math.max(
        ...[...revenue, ...netIncome, ...operatingCash, ...equity]
          .map(([, item]) => Number(String(item.filed || "").replaceAll("-", "")) || 0)
      ),
      missingFields,
      fallbackFields: fallbackSharesYears.length ? [`股数缺失年份沿用最近可得股数：${fallbackSharesYears.join(", ")}`] : [],
      sourceCoverage: `${candidateYears.length} 年 SEC 年报数据`,
    },
    financials,
  };
}

async function fetchRealCompany(symbol) {
  const [fundamentals, quote, marketTape] = await Promise.all([
    fetchSecFundamentals(symbol),
    fetchStooqQuote(symbol),
    fetchMarketTape(symbol),
  ]);
  const latestShares = last(fundamentals.financials.shares);
  const marketCap = quote.price && latestShares ? quote.price * latestShares * 1_000_000 : null;
  return {
    ...fundamentals,
    currency: quote.currency,
    price: quote.price,
    marketCap,
    beta: null,
    quoteTime: quote.quoteTime,
    marketTape,
  };
}

async function fetchGlobalCompany(symbol) {
  const resolved = await resolveGlobalSymbol(symbol);
  const [quote, marketTape] = await Promise.all([
    fetchYahooQuote(resolved),
    fetchMarketTape(resolved),
  ]);
  const fundamentals = await fetchYahooFundamentals(resolved, quote);
  const latestShares = last(fundamentals.financials.shares);
  const marketCap = quote.price && latestShares ? quote.price * latestShares * 1_000_000 : null;
  return {
    ...fundamentals,
    symbol: quote.symbol || fundamentals.symbol,
    shortName: quote.longName || quote.shortName || fundamentals.shortName,
    currency: quote.currency,
    price: quote.price,
    marketCap,
    beta: null,
    quoteTime: quote.quoteTime,
    marketTape,
  };
}

async function handleAnalyze(req, res, url) {
  const raw = (url.searchParams.get("symbol") || "AAPL").trim().toUpperCase();
  const symbol = raw.replace(/[^A-Z0-9.^\-\s\u4e00-\u9fa5]/g, "").slice(0, 32);

  try {
    let company;
    let sourceLabel;
    try {
      company = await fetchRealCompany(symbol);
      sourceLabel = `SEC EDGAR 年报财务数据 + Stooq 最新行情${company.quoteTime ? ` (${company.quoteTime})` : ""}`;
    } catch (secError) {
      company = await fetchGlobalCompany(symbol);
      sourceLabel = `Yahoo Finance 全球财务数据 + Yahoo 最新行情${company.quoteTime ? ` (${company.quoteTime})` : ""}`;
      company.dataQuality = {
        ...(company.dataQuality || {}),
        fallbackFields: [
          ...(company.dataQuality?.fallbackFields || []),
          `SEC 不支持或未匹配该标的，已切换全球数据源：${secError.message}`,
        ],
      };
    }
    const data = analyze(company, sourceLabel);
    data.series.years = company.years || data.series.years;
    data.dataQuality = {
      ...(company.dataQuality || {}),
      quoteTime: company.quoteTime || null,
      quoteSource: sourceLabel.includes("Yahoo") ? "Yahoo Finance" : "Stooq",
      filingSource: sourceLabel.includes("Yahoo") ? "Yahoo Finance Fundamentals" : "SEC EDGAR Company Facts",
      confidence: (company.dataQuality?.missingFields?.length || 0) === 0 ? "高" : "中",
    };
    data.notice = sourceLabel.includes("Yahoo")
      ? "全球股票使用 Yahoo Finance 行情和年度财务时间序列；不同市场披露口径、币种和延迟可能不同，请用原始公告复核。"
      : "当前版本使用真实公开数据源；Stooq 报价可能有交易所延迟，SEC 财务数据来自最新已披露年报。";
    sendJson(res, data);
  } catch (error) {
    sendJson(res, {
      error: "REAL_DATA_UNAVAILABLE",
      message: `无法取得 ${symbol} 的真实行情或财务数据：${error.message}`,
      hint: "目前免 key 模式支持 SEC 可识别的美国上市公司，行情使用 Stooq。若要覆盖更多市场或交易所直连实时数据，请配置专业行情 API。",
    }, 502);
  }
}

async function handleSearch(req, res, url) {
  const raw = (url.searchParams.get("q") || "").trim();
  if (!raw) {
    sendJson(res, { results: [] });
    return;
  }
  try {
    const compact = raw.trim().toUpperCase().replace(/\s+/g, "");
    const looksLikeCode = /[\d.-]/.test(compact) || /^[A-Z]{1,5}$/.test(compact);
    const normalized = (looksLikeCode ? symbolCandidates(raw) : []).map((symbol) => ({
      symbol,
      name: `尝试代码 ${symbol}`,
      exchange: symbol.includes(".HK") ? "Hong Kong" : symbol.includes(".SS") ? "Shanghai" : symbol.includes(".SZ") ? "Shenzhen" : symbol.includes(".KS") ? "Korea" : "",
      sector: "",
      industry: "",
      source: "Symbol matcher",
    }));
    const yahoo = await searchYahooSymbols(raw).catch(() => []);
    const seen = new Set();
    const results = [...normalized, ...yahoo]
      .filter((item) => {
        if (seen.has(item.symbol)) return false;
        seen.add(item.symbol);
        return true;
      })
      .slice(0, 10);
    sendJson(res, { results });
  } catch (error) {
    sendJson(res, { error: "SEARCH_UNAVAILABLE", message: error.message, results: [] }, 502);
  }
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const target = normalize(join(root, pathname));
  if (!target.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const content = await readFile(target);
    res.writeHead(200, { "content-type": mime[extname(target)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/analyze") {
    await handleAnalyze(req, res, url);
    return;
  }
  if (url.pathname === "/api/search") {
    await handleSearch(req, res, url);
    return;
  }
  await serveStatic(req, res, url);
});

server.listen(port, host, () => {
  console.log(`Munger value analyzer running at http://${host}:${port}`);
});
