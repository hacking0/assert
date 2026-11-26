"use strict";

const byId = id => document.getElementById(id);
const names = {"511260.SS":"国债 ETF", "513500.SS":"标普 500 ETF", "518880.SS":"黄金 ETF", CASH:"现金"};
const defaults = {"511260.SS":50, "513500.SS":25, "518880.SS":25};
const number = new Intl.NumberFormat("zh-CN", {maximumFractionDigits:2, minimumFractionDigits:2});
const pct = n => n == null ? "—" : number.format(n * 100) + "%";
const rows = byId("allocation");
const form = byId("config");
const chart = byId("chart");
const pageSize = 15;
let assets = [];
let report;
let tab = "positions";
let metric = "value";
let page = 0;

function selectedSymbols() {
  return new Set([...rows.querySelectorAll("select")].map(select => select.value));
}

function refreshAllocation() {
  const selections = [...rows.querySelectorAll("select")];
  const selected = selectedSymbols();
  for (const select of selections) {
    for (const option of select.options) {
      option.disabled = option.value !== select.value && selected.has(option.value);
    }
    select.closest(".asset-row").querySelector("button").disabled = selections.length === 1;
  }
  const total = [...rows.querySelectorAll("input")].reduce((sum, input) => sum + Number(input.value), 0);
  const badge = byId("weight-total");
  badge.textContent = "合计 " + number.format(total) + "%";
  badge.classList.toggle("invalid", Math.abs(total - 100) > 1e-7);
  byId("add").disabled = selected.size >= assets.length;
  byId("cash-wrap").hidden = byId("cash-return").disabled = !selected.has("CASH");
}

function assetQuoteHint(symbol) {
  return symbol === "CASH" ? "按固定年化收益率计息" :
    assets.find(asset => asset.symbol === symbol).start + " 起有行情";
}

function addAsset(symbol, weight) {
  const row = document.createElement("div");
  row.className = "asset-row";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "标的代码");
  for (const asset of assets) {
    const name = names[asset.symbol];
    const label = name && asset.symbol !== "CASH" ? name + " · " + asset.symbol.split(".")[0] : name || asset.symbol;
    select.add(new Option(label, asset.symbol));
  }
  select.value = symbol;
  select.title = assetQuoteHint(symbol);
  select.addEventListener("change", () => {
    select.title = assetQuoteHint(select.value);
    refreshAllocation();
  });
  const input = document.createElement("input");
  Object.assign(input, {type:"number", min:"0.01", max:"100", step:"0.01", value:weight, required:true});
  input.setAttribute("aria-label", "权重百分比");
  input.addEventListener("input", refreshAllocation);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "移除标的");
  remove.addEventListener("click", () => { row.remove(); refreshAllocation(); });
  row.append(select, input, remove);
  rows.append(row);
  refreshAllocation();
}

function toggleStrategy() {
  const strategy = byId("strategy").value;
  const threshold = strategy === "threshold";
  const period = strategy === "periodic" || (threshold && byId("check").value === "scheduled");
  byId("threshold-wrap").hidden = byId("check-wrap").hidden = !threshold;
  byId("period-wrap").hidden = !period;
  byId("interval").disabled = byId("unit").disabled = !period;
  byId("threshold").disabled = !threshold;
}

function error(message) {
  byId("error").hidden = !message;
  byId("error").textContent = message;
}

async function request(url, options) {
  if (window.portfolioRequest) return window.portfolioRequest(url, options);
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  return payload;
}

function drawChart() {
  if (!report) return;
  const bounds = chart.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = bounds.width;
  const height = bounds.height;
  if (width < 110 || height < 80) return;
  chart.width = Math.round(width * scale);
  chart.height = Math.round(height * scale);
  const ctx = chart.getContext("2d");
  ctx.scale(scale, scale);
  const left = 66, right = width - 12, top = 13, bottom = height - 32;
  const daily = report.daily;
  const values = daily.map(row => row[metric]);
  const low = metric === "drawdown" ? 0 : Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || Math.max(high * .1, .01);
  const x = i => left + (right - left) * i / Math.max(1, daily.length - 1);
  const y = value => bottom - (bottom - top) * (value - low) / span;
  ctx.font = "12px system-ui";
  ctx.fillStyle = "#526b65";
  for (let i = 0; i <= 4; i++) {
    const value = low + span * i / 4;
    const line = y(value);
    ctx.strokeStyle = "#e4eeeb";
    ctx.beginPath(); ctx.moveTo(left, line); ctx.lineTo(right, line); ctx.stroke();
    const label = metric === "drawdown" ? pct(value) : Math.round(value).toLocaleString("zh-CN");
    ctx.textAlign = "right";
    ctx.fillText(label, left - 8, line + 4);
  }
  const ticks = Math.min(daily.length, width < 460 ? 2 : 4);
  for (let i = 0; i < ticks; i++) {
    const index = Math.round(i * (daily.length - 1) / Math.max(1, ticks - 1));
    ctx.textAlign = i === 0 ? "left" : i === ticks - 1 ? "right" : "center";
    ctx.fillText(daily[index].date, x(index), height - 7);
  }
  ctx.beginPath();
  values.forEach((value, i) => i === 0 ? ctx.moveTo(x(i), y(value)) : ctx.lineTo(x(i), y(value)));
  if (values.length === 1) ctx.lineTo(Math.min(right, x(0) + 4), y(values[0]));
  ctx.lineWidth = 2;
  ctx.strokeStyle = metric === "drawdown" ? "#9a532c" : "#126659";
  ctx.stroke();
  chart.setAttribute("aria-label", metric === "drawdown" ? "每日组合回撤" : "每日组合市值");
}

function cell(tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}

function showDetail() {
  const table = byId("details");
  const empty = byId("empty");
  table.replaceChildren();
  byId("pager").hidden = true;
  empty.hidden = true;
  if (!report) return;
  let headers, data;
  if (tab === "positions") {
    headers = ["标的", "期末市值", "期末权重", "标的累计收益"];
    const positions = report.daily[report.daily.length - 1].positions;
    data = Object.entries(positions).map(([symbol,p]) => [
      names[symbol] || symbol, number.format(p.value), pct(p.weight), pct(p.cumulative_return)
    ]);
  } else if (tab === "daily") {
    headers = ["日期", "组合市值", "单日收益", "累计收益", "回撤"];
    data = report.daily.map(row => [row.date, number.format(row.value), pct(row.daily_return), pct(row.cumulative_return), pct(row.drawdown)]);
  } else {
    headers = ["执行日", "信号或计划日", "标的", "调仓前权重", "调仓后权重", "交易金额", "单边换手率"];
    data = report.rebalances.flatMap(event => Object.entries(event.positions).map(([symbol,p], index) => [
      event.date, event.signal?.date || event.scheduled_date || "—", names[symbol] || symbol,
      pct(p.weight_before), pct(p.weight_after), number.format(p.trade_value), index === 0 ? pct(event.turnover) : "—"
    ]));
  }
  if (!data.length) {
    empty.textContent = "本次回测没有已执行的调仓。";
    empty.hidden = false;
    return;
  }
  const pages = Math.ceil(data.length / pageSize);
  const head = table.createTHead().insertRow();
  for (const title of headers) {
    const th = cell("th", title);
    th.scope = "col";
    head.append(th);
  }
  const body = table.createTBody();
  for (const values of data.slice(page * pageSize, (page + 1) * pageSize)) {
    const row = body.insertRow();
    values.forEach(value => row.append(cell("td", value)));
  }
  byId("pager").hidden = pages <= 1;
  byId("page").textContent = `${page + 1} / ${pages}`;
  byId("prev").disabled = page === 0;
  byId("next").disabled = page + 1 === pages;
}

async function run(event) {
  event?.preventDefault();
  error("");
  byId("run").disabled = true;
  byId("run").textContent = "计算中…";
  const strategy = byId("strategy");
  const strategyLabel = strategy.selectedOptions[0].textContent;
  const payload = {
    start:byId("start").value, end:byId("end").value, amount:byId("amount").value,
    price:byId("price").value,
    allocation:[...rows.children].map(row => ({
      symbol:row.querySelector("select").value, weight:row.querySelector("input").value
    })),
    period:byId("interval").disabled ? null : byId("interval").value + byId("unit").value,
    threshold:byId("threshold").disabled ? null : byId("threshold").value,
    cashAnnualReturn:byId("cash-return").disabled ? 0 : byId("cash-return").value
  };
  try {
    report = await request("/api/backtest", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)
    });
    const s = report.summary;
    const cashLabel = s.cash_annual_return == null ? "" : " · 现金年化 " + pct(s.cash_annual_return);
    byId("result-period").textContent = `${strategyLabel} · ${s.start_date} 至 ${s.end_date} · ${s.valuation_days.toLocaleString("zh-CN")} 个估值日${cashLabel}`;
    byId("value").textContent = (s.currency === "CNY" ? "¥" : s.currency + " ") + number.format(s.final_value);
    byId("return").textContent = pct(s.total_return);
    byId("drawdown").textContent = pct(s.max_drawdown);
    byId("count").textContent = s.rebalance_count;
    byId("export").disabled = false;
    page = 0;
    drawChart();
    showDetail();
  } catch (failure) {
    error(failure.message);
  } finally {
    byId("run").disabled = false;
    byId("run").textContent = "运行回测";
  }
}

function bindTabs(id, key, select) {
  const buttons = [...byId(id).querySelectorAll("button")];
  for (const button of buttons) {
    button.addEventListener("click", () => {
      buttons.forEach(item => item.setAttribute("aria-pressed", String(item === button)));
      select(button.dataset[key]);
    });
  }
}

byId("strategy").addEventListener("change", toggleStrategy);
byId("check").addEventListener("change", toggleStrategy);
byId("add").addEventListener("click", () => {
  const selected = selectedSymbols();
  const next = assets.find(asset => !selected.has(asset.symbol));
  if (next) addAsset(next.symbol, "");
});
byId("prev").addEventListener("click", () => { page--; showDetail(); });
byId("next").addEventListener("click", () => { page++; showDetail(); });
byId("export").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type:"application/json"}));
  const link = document.createElement("a");
  link.href = url;
  link.download = `backtest-${report.summary.start_date}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
bindTabs("chart-tabs", "chart", choice => { metric = choice; drawChart(); });
bindTabs("detail-tabs", "detail", choice => { tab = choice; page = 0; showDetail(); });
new ResizeObserver(drawChart).observe(chart);
form.addEventListener("submit", run);

async function initialize() {
  toggleStrategy();
  byId("run").disabled = byId("add").disabled = true;
  try {
    assets = await request("/api/assets");
    assets.push({symbol:"CASH"});
    if (Object.keys(defaults).every(symbol => assets.some(asset => asset.symbol === symbol))) {
      for (const [symbol,weight] of Object.entries(defaults)) addAsset(symbol, weight);
    } else {
      const asset = assets[0];
      addAsset(asset.symbol, 100);
      if (asset.start) byId("start").value = asset.start;
    }
    await run();
  } catch (failure) {
    byId("result-period").textContent = "行情库未就绪";
    error(failure.message);
  }
}
initialize();
