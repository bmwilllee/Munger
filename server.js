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
  const [fundamentals, quote] = await Promise.all([
    fetchSecFundamentals(symbol),
    fetchStooqQuote(symbol),
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
  };
}

async function handleAnalyze(req, res, url) {
  const raw = (url.searchParams.get("symbol") || "AAPL").trim().toUpperCase();
  const symbol = raw.replace(/[^A-Z0-9.^-]/g, "").slice(0, 16);

  try {
    const company = await fetchRealCompany(symbol);
    const data = analyze(company, `SEC EDGAR 年报财务数据 + Stooq 最新行情${company.quoteTime ? ` (${company.quoteTime})` : ""}`);
    data.series.years = company.years || data.series.years;
    data.dataQuality = {
      ...(company.dataQuality || {}),
      quoteTime: company.quoteTime || null,
      quoteSource: "Stooq",
      filingSource: "SEC EDGAR Company Facts",
      confidence: (company.dataQuality?.missingFields?.length || 0) === 0 ? "高" : "中",
    };
    data.notice = "当前版本使用真实公开数据源；Stooq 报价可能有交易所延迟，SEC 财务数据来自最新已披露年报。";
    sendJson(res, data);
  } catch (error) {
    sendJson(res, {
      error: "REAL_DATA_UNAVAILABLE",
      message: `无法取得 ${symbol} 的真实行情或财务数据：${error.message}`,
      hint: "目前免 key 模式支持 SEC 可识别的美国上市公司，行情使用 Stooq。若要覆盖更多市场或交易所直连实时数据，请配置专业行情 API。",
    }, 502);
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
  await serveStatic(req, res, url);
});

server.listen(port, host, () => {
  console.log(`Munger value analyzer running at http://${host}:${port}`);
});
