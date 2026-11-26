"""Backtest an initial allocation with optional rebalancing."""

import argparse
from calendar import monthrange
from contextlib import closing
from datetime import date, timedelta
import json
import math
from pathlib import Path
import re
import sqlite3
import sys

from prices import DATABASE_PATH, normalize_symbol


def parse_weights(entries):
    weights = {}
    for entry in entries:
        symbol, separator, weight = entry.partition("=")
        if not separator:
            raise ValueError("配置格式为 代码=比例，例如 511260=40%")
        symbol = normalize_symbol(symbol)
        if symbol in weights:
            raise ValueError(f"重复配置标的：{symbol}")
        weight = weight.strip()
        fraction = float(weight[:-1]) / 100 if weight.endswith("%") else float(weight)
        if not math.isfinite(fraction) or not 0 < fraction <= 1:
            raise ValueError(f"{symbol} 的权重须大于 0 且不超过 100%")
        weights[symbol] = fraction
    total = math.fsum(weights.values())
    if not math.isclose(total, 1, rel_tol=0, abs_tol=1e-9):
        raise ValueError(f"配置权重合计须为 100%，当前为 {total:.6%}")
    return {symbol: weight / total for symbol, weight in weights.items()}


def scheduled_date(anchor, interval, occurrence):
    count, unit = interval
    offset = count * occurrence
    if unit in ("d", "w"):
        days = offset * (7 if unit == "w" else 1)
        return anchor + timedelta(days=days) if days <= (date.max - anchor).days else None

    months = offset * {"m": 1, "q": 3, "y": 12}[unit]
    year, month_index = divmod(anchor.year * 12 + anchor.month - 1 + months, 12)
    if year > date.max.year:
        return None
    month = month_index + 1
    return date(year, month, min(anchor.day, monthrange(year, month)[1]))


def parse_threshold(text):
    text = text.strip()
    return float(text[:-1]) / 100 if text.endswith("%") else float(text)


def run_backtest(
    database_path, start, end, amount, weights, price_column="adjusted_close",
    rebalance_every=None, rebalance_threshold=None, cash_annual_return=0.0,
):
    if not math.isfinite(amount) or amount <= 0:
        raise ValueError("初始金额须为有限正数")
    if end and end < start:
        raise ValueError("结束日期须不早于开始日期")
    if price_column not in ("adjusted_close", "close"):
        raise ValueError("价格字段须为 adjusted_close 或 close")
    if "CASH" in weights and (
        not math.isfinite(cash_annual_return) or cash_annual_return <= -1
    ):
        raise ValueError("现金年化收益率须为有限数值且大于 -100%")
    if rebalance_threshold is not None and (
        not math.isfinite(rebalance_threshold) or not 0 < rebalance_threshold < 1
    ):
        raise ValueError("再平衡阈值须大于 0 且小于 100 个百分点")
    interval = None
    if rebalance_every is not None:
        match = re.fullmatch(r"([1-9][0-9]*)([dwmqy])", rebalance_every)
        if not match:
            raise ValueError("再平衡周期须为正整数加 d、w、m、q 或 y，例如 3m")
        interval = (int(match[1]), match[2])

    quotes = {}
    currencies = set()
    market_symbols = [symbol for symbol in weights if symbol != "CASH"]
    if market_symbols:
        uri = database_path.resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as connection:
            connection.execute("BEGIN")
            for symbol in market_symbols:
                rows = connection.execute(f"""
                    SELECT date, {price_column}, currency FROM daily_prices
                    WHERE symbol = ? AND date >= ? AND date <= ?
                    ORDER BY date
                """, (symbol, start.isoformat(), (end or date.max).isoformat())).fetchall()
                if not rows:
                    raise ValueError(f"{symbol} 在指定区间内没有已入库的行情")
                quotes[symbol] = {day: price for day, price, _ in rows}
                currencies.update(currency for _, _, currency in rows)
    if len(currencies) > 1:
        raise ValueError("当前回测要求所有标的使用同一报价币种")

    if quotes:
        shared_days = set.intersection(*(set(series) for series in quotes.values()))
        if not shared_days:
            raise ValueError("指定区间内没有所有标的同时有行情的日期")
        first_day = min(shared_days)
        last_day = min(max(series) for series in quotes.values())
        calendar = sorted(
            day for day in set.union(*(set(series) for series in quotes.values()))
            if first_day <= day <= last_day
        )
    else:
        cash_end = end or date.today()
        if cash_end < start:
            raise ValueError("现金回测开始日期晚于截止日期")
        calendar = [
            (start + timedelta(days=offset)).isoformat()
            for offset in range((cash_end - start).days + 1)
        ]
        first_day, last_day = calendar[0], calendar[-1]
        shared_days = set(calendar)

    anchor = date.fromisoformat(first_day)
    if "CASH" in weights:
        annual_growth = math.log1p(cash_annual_return)
        quotes["CASH"] = {
            day: math.exp(annual_growth * (date.fromisoformat(day) - anchor).days / 365)
            for day in calendar
        }

    price_by_symbol = {}
    quote_day_by_symbol = {}
    allocation_values = {symbol: amount * weight for symbol, weight in weights.items()}
    allocation_prices = {symbol: quotes[symbol][first_day] for symbol in weights}
    occurrence = 1
    due = scheduled_date(anchor, interval, occurrence) if interval and market_symbols else None
    pending_signal = None
    rebalances = []
    daily = []
    peak = amount
    max_drawdown = 0.0
    for day in calendar:
        positions = {}
        for symbol in weights:
            series = quotes[symbol]
            if day in series:
                price = series[day]
                if price is None or not math.isfinite(price) or price <= 0:
                    raise ValueError(f"{symbol} 在 {day} 的 {price_column} 缺失或无效")
                price_by_symbol[symbol] = price
                quote_day_by_symbol[symbol] = day
            price = price_by_symbol[symbol]
            growth = price / series[first_day]
            positions[symbol] = {
                "price": price,
                "quote_date": quote_day_by_symbol[symbol],
                "value": allocation_values[symbol] * (price / allocation_prices[symbol]),
                "cumulative_return": growth - 1,
            }

        value = math.fsum(position["value"] for position in positions.values())
        value = amount if day == first_day else value
        for position in positions.values():
            position["weight"] = position["value"] / value
        trading_day = date.fromisoformat(day)
        common_quote_day = day in shared_days
        planned_date = due if common_quote_day and due is not None and trading_day >= due else None
        if planned_date is not None:
            while due is not None and due <= trading_day:
                occurrence += 1
                due = scheduled_date(anchor, interval, occurrence)

        periodic_trade = rebalance_threshold is None and planned_date is not None
        if periodic_trade or (pending_signal is not None and common_quote_day):
            changes = {}
            for symbol, position in positions.items():
                before_value = position["value"]
                after_value = value * weights[symbol]
                changes[symbol] = {
                    "weight_before": position["weight"],
                    "weight_after": weights[symbol],
                    "trade_value": after_value - before_value,
                }
                allocation_values[symbol] = after_value
                allocation_prices[symbol] = position["price"]
                position["value"] = after_value
                position["weight"] = weights[symbol]
            turnover = math.fsum(abs(change["trade_value"]) for change in changes.values())
            event = {
                "scheduled_date": planned_date.isoformat() if periodic_trade else None,
                "date": day,
                "turnover": turnover / (2 * value),
                "positions": changes,
            }
            if pending_signal is not None:
                event["scheduled_date"] = pending_signal["scheduled_date"]
                event["signal"] = pending_signal
                pending_signal = None
            rebalances.append(event)

        if (
            rebalance_threshold is not None and common_quote_day and day != first_day
            and (interval is None or planned_date is not None)
        ):
            deviations = {
                symbol: position["weight"] - weights[symbol]
                for symbol, position in positions.items()
            }
            triggered = {
                symbol: deviation for symbol, deviation in deviations.items()
                if abs(deviation) >= rebalance_threshold
                or math.isclose(abs(deviation), rebalance_threshold, rel_tol=1e-12)
            }
            if triggered:
                pending_signal = {
                    "date": day,
                    "scheduled_date": planned_date.isoformat() if planned_date else None,
                    "triggering_deviations": triggered,
                }
        peak = max(peak, value)
        drawdown = 1 - value / peak
        max_drawdown = max(max_drawdown, drawdown)
        daily.append({
            "date": day,
            "value": value,
            "profit_loss": value - amount,
            "daily_return": value / daily[-1]["value"] - 1 if daily else None,
            "cumulative_return": value / amount - 1,
            "drawdown": drawdown,
            "positions": positions,
        })

    final = daily[-1]
    return {
        "summary": {
            "requested_start": start.isoformat(),
            "requested_end": end.isoformat() if end else None,
            "start_date": first_day,
            "end_date": last_day,
            "valuation_days": len(daily),
            "currency": next(iter(currencies), "CNY"),
            "price_column": price_column,
            "initial_weights": weights,
            "initial_amount": amount,
            "final_value": final["value"],
            "profit_loss": final["profit_loss"],
            "total_return": final["cumulative_return"],
            "max_drawdown": max_drawdown,
            "rebalance_every": rebalance_every,
            "rebalance_threshold": rebalance_threshold,
            "cash_annual_return": cash_annual_return if "CASH" in weights else None,
            "rebalance_count": len(rebalances),
            "total_turnover": math.fsum(event["turnover"] for event in rebalances),
        },
        "daily": daily,
        "rebalances": rebalances,
        "pending_rebalance_signal": pending_signal,
    }


def main():
    parser = argparse.ArgumentParser(description="按初始资产配置回测一次性投入")
    parser.add_argument("--start", required=True, type=date.fromisoformat, help="YYYY-MM-DD")
    parser.add_argument("--end", type=date.fromisoformat, help="YYYY-MM-DD，默认用到共同覆盖的最后日期")
    parser.add_argument("--amount", required=True, type=float, help="初始金额")
    parser.add_argument("--weight", required=True, action="append", help="代码=比例，可重复指定")
    parser.add_argument("--price", choices=("adjusted_close", "close"), default="adjusted_close")
    parser.add_argument(
        "--cash-annual-return", type=parse_threshold, default=0.0,
        help="现金年化收益率，例如 2%% 或 0.02，配合 --weight CASH=比例",
    )
    parser.add_argument("--rebalance-every", help="再平衡间隔，例如 7d、2w、3m、1q、1y")
    parser.add_argument(
        "--rebalance-threshold", type=parse_threshold,
        help="相对目标权重的绝对偏离，例如 5%% 或 0.05；可与周期合用",
    )
    parser.add_argument("--db", type=Path, default=DATABASE_PATH, help="SQLite 数据库路径")
    parser.add_argument("--output", type=Path, help="JSON 报告路径，默认输出到终端")
    args = parser.parse_args()
    try:
        report = run_backtest(
            args.db, args.start, args.end, args.amount, parse_weights(args.weight),
            args.price, args.rebalance_every, args.rebalance_threshold, args.cash_annual_return,
        )
        payload = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)
        if args.output:
            with args.output.open("x", encoding="utf-8") as output:
                output.write(payload + "\n")
        else:
            print(payload)
    except (OSError, ValueError, OverflowError, sqlite3.Error) as error:
        print(f"回测失败：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
