const DAY = 86400000;
const iso = time => new Date(time).toISOString().slice(0, 10);
const timeOf = day => Date.parse(day + "T00:00:00Z");
const records = entries => Object.fromEntries(entries);
const sum = values => values.reduce((total, value) => total + value, 0);

function plannedDay(anchor, period, occurrence) {
  const unit = period.at(-1);
  const count = Number(period.slice(0, -1)) * occurrence;
  if (unit === "d" || unit === "w") {
    const time = anchor + DAY * count * (unit === "w" ? 7 : 1);
    return time <= timeOf("9999-12-31") ? iso(time) : null;
  }
  const original = new Date(anchor);
  const months = count * {m:1,q:3,y:12}[unit];
  const target = new Date(anchor);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months + 1, 0);
  if (!Number.isFinite(+target) || target.getUTCFullYear() > 9999) return null;
  target.setUTCDate(Math.min(original.getUTCDate(), target.getUTCDate()));
  return iso(+target);
}

export function backtest(data, config) {
  const {start, end, price, period} = config;
  const amount = Number(config.amount);
  const threshold = config.threshold == null ? null : Number(config.threshold) / 100;
  const cashRate = Number(config.cashAnnualReturn ?? 0) / 100;
  const allocations = config.allocation.map(({symbol, weight}) => [symbol, Number(weight) / 100]);
  const weights = records(allocations);
  const symbols = Object.keys(weights);
  const total = sum(Object.values(weights));
  if (!Number.isFinite(amount) || amount <= 0) throw Error("初始金额须为有限正数");
  if (!Number.isFinite(timeOf(start)) || (end && (!Number.isFinite(timeOf(end)) || end < start))) throw Error("请检查起止日期");
  if (symbols.length !== allocations.length || Math.abs(total - 1) > 1e-9 ||
      !Object.values(weights).every(weight => Number.isFinite(weight) && weight > 0 && weight <= 1)) {
    throw Error("各标的权重必须为正且合计为 100%");
  }
  for (const symbol of symbols) weights[symbol] /= total;
  if (period != null && !/^[1-9][0-9]*[dwmqy]$/.test(period)) throw Error("再平衡周期无效");
  if (threshold != null && !(threshold > 0 && threshold < 1)) throw Error("再平衡阈值须大于 0 且小于 100 个百分点");
  if ("CASH" in weights && (!Number.isFinite(cashRate) || cashRate <= -1)) throw Error("现金年化收益率须大于 -100%");
  if (!["adjusted_close","close"].includes(price)) throw Error("价格字段无效");

  const market = symbols.filter(symbol => symbol !== "CASH");
  const currencies = new Set();
  const quotes = new Map();
  let last = end || "9999-12-31";
  for (const symbol of market) {
    const rows = data[symbol]?.filter(([day]) => day >= start && (!end || day <= end));
    if (!rows?.length) throw Error(symbol + " 在指定区间内没有已入库的行情");
    for (const row of rows) currencies.add(row[3]);
    last = last < rows.at(-1)[0] ? last : rows.at(-1)[0];
    quotes.set(symbol, new Map(rows.map(row => [row[0], row[price === "close" ? 1 : 2]])));
  }
  if (currencies.size > 1) throw Error("当前回测要求所有标的使用同一报价币种");

  let days, common;
  if (market.length) {
    days = [...new Set([...quotes.values()].flatMap(series => [...series.keys()]))].sort();
    common = new Set(days.filter(day => market.every(symbol => quotes.get(symbol).has(day))));
    if (!common.size) throw Error("指定区间内没有所有标的同时有行情的日期");
    const first = common.values().next().value;
    days = days.filter(day => day >= first && day <= last);
  } else {
    last = end || new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"}).format(new Date());
    if (last < start) throw Error("现金回测开始日期晚于截止日期");
    days = Array.from({length:(timeOf(last)-timeOf(start))/DAY+1},(_,i)=>iso(timeOf(start)+i*DAY));
    common = new Set(days);
  }

  const first = days[0];
  const anchor = timeOf(first);
  const latest = new Map();
  const initial = new Map();
  const bases = new Map();
  const daily = [], trades = [];
  let pending = null, occurrence = 1, peak = amount, maxDrawdown = 0;
  let due = period && market.length ? plannedDay(anchor,period,occurrence) : null;

  for (const day of days) {
    const positions = records(symbols.map(symbol => {
      const series = quotes.get(symbol);
      if (symbol === "CASH" || series.has(day)) {
        const quote = symbol === "CASH" ? Math.exp(Math.log1p(cashRate) * (timeOf(day)-anchor)/DAY/365) : series.get(day);
        if (!Number.isFinite(quote) || quote <= 0) throw Error(symbol + " 在 " + day + " 的价格缺失或无效");
        latest.set(symbol, {price:quote,quote_date:day});
      }
      const quote = latest.get(symbol);
      if (day === first) {
        initial.set(symbol,quote.price);
        bases.set(symbol,{price:quote.price,value:amount*weights[symbol]});
      }
      const base = bases.get(symbol);
      return [symbol,{...quote,value:base.value*(quote.price/base.price),cumulative_return:quote.price/initial.get(symbol)-1}];
    }));
    const value = day === first ? amount : sum(Object.values(positions).map(p=>p.value));
    if (!Number.isFinite(value) || value <= 0) throw Error("估值超出可计算范围");
    for (const p of Object.values(positions)) p.weight = p.value/value;
    const commonDay = common.has(day);
    const planned = commonDay && due && day >= due ? due : null;
    if (planned) {
      do { due = plannedDay(anchor, period, ++occurrence); } while (due && due <= day);
    }
    if ((threshold === null && planned) || (pending && commonDay)) {
      const changes = records(symbols.map(symbol => {
        const p = positions[symbol];
        const target = value * weights[symbol];
        const trade = {weight_before:p.weight,weight_after:weights[symbol],trade_value:target-p.value};
        bases.set(symbol,{price:p.price,value:target});
        p.value=target; p.weight=weights[symbol];
        return [symbol,trade];
      }));
      const event = {
        scheduled_date:pending ? pending.scheduled_date : planned,date:day,positions:changes,
        turnover:sum(Object.values(changes).map(p=>Math.abs(p.trade_value)))/(2*value)
      };
      if (pending) event.signal = pending;
      trades.push(event);
      pending = null;
    }
    if (threshold !== null && commonDay && day !== first && (!period || planned)) {
      const deviations = symbols.map(symbol=>[symbol,positions[symbol].weight-weights[symbol]]);
      const triggered = deviations.filter(([,delta])=>Math.abs(delta) >= threshold || Math.abs(Math.abs(delta)-threshold) <= threshold*1e-12);
      if (triggered.length) pending = {date:day,scheduled_date:planned,triggering_deviations:records(triggered)};
    }
    peak = Math.max(peak,value);
    const drawdown = 1-value/peak;
    maxDrawdown = Math.max(maxDrawdown,drawdown);
    daily.push({
      date:day,value,profit_loss:value-amount,drawdown,positions,
      daily_return:daily.length ? value/daily.at(-1).value-1 : null,cumulative_return:value/amount-1
    });
  }
  const final = daily.at(-1);
  return {summary:{
    requested_start:start,requested_end:end||null,start_date:first,end_date:last,
    valuation_days:daily.length,currency:[...currencies][0]||"CNY",price_column:price,
    initial_weights:weights,initial_amount:amount,final_value:final.value,profit_loss:final.profit_loss,
    total_return:final.cumulative_return,max_drawdown:maxDrawdown,rebalance_every:period,
    rebalance_threshold:threshold,cash_annual_return:"CASH" in weights ? cashRate:null,
    rebalance_count:trades.length,total_turnover:sum(trades.map(event=>event.turnover))
  },daily,rebalances:trades,pending_rebalance_signal:pending};
}
