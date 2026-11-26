"""Download and store daily OHLC prices."""

import argparse
from contextlib import closing
from datetime import date, datetime, time as clock_time, timedelta
import json
import math
from pathlib import Path
import re
import sqlite3
import sys
import time
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

DATABASE_PATH = Path(__file__).resolve().parents[1] / "data" / "prices.sqlite3"
OHLC_FIELDS = ("open", "high", "low", "close")
EASTMONEY_MARKETS = {"SS": "1", "SZ": "0", "BJ": "0"}
EASTMONEY_LISTING_DATES = {"1.511260": "20170824"}


def normalize_symbol(symbol):
    symbol = symbol.strip().upper()
    if not re.fullmatch(r"(?:\^?[A-Z0-9][A-Z0-9.=_-]{0,39})", symbol):
        raise ValueError(f"股票代码格式无效：{symbol!r}")
    if re.fullmatch(r"\d{6}", symbol):
        if symbol.startswith("920"):
            return f"{symbol}.BJ"
        if symbol.startswith(("5", "6", "9")):
            return f"{symbol}.SS"
        if symbol.startswith(("0", "1", "2", "3")):
            return f"{symbol}.SZ"
        if symbol.startswith(("4", "8")):
            return f"{symbol}.BJ"
        raise ValueError(f"请为 {symbol} 指定交易所后缀，例如 .SS、.SZ 或 .BJ")
    return symbol


def fetch_eastmoney_series(secid, adjustment, last_date):
    params = urlencode({
        "secid": secid, "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55", "klt": 101, "fqt": adjustment,
        "beg": EASTMONEY_LISTING_DATES.get(secid, "19900101"),
        "end": "20500101", "lmt": 10000,
        "ut": "fa5fd1943c7b386f172d6893dbfba10b",
    }, safe=",")
    url = f"https://push2his.eastmoney.com/api/qt/stock/kline/get?{params}"
    with urlopen(url, timeout=30) as response:
        data = json.load(response).get("data")
    if not data or not data.get("klines"):
        raise ValueError("东方财富没有返回日线")
    if len(data["klines"]) >= 10000:
        raise ValueError("东方财富日线达到单次请求上限，历史数据可能被截断")

    series = {}
    for line in data["klines"]:
        day, opening, close, high, low = line.split(",")
        trading_date = date.fromisoformat(day)
        if trading_date > last_date:
            continue
        values = (opening, high, low, close)
        if not all(math.isfinite(float(value)) for value in values):
            raise ValueError(f"东方财富返回了无效价格：{trading_date}")
        if trading_date in series:
            raise ValueError(f"东方财富返回了重复日期：{trading_date}")
        series[trading_date] = values
    return series


def fetch_eastmoney_prices(symbol, market):
    now = datetime.now(ZoneInfo("Asia/Shanghai"))
    last_date = now.date()
    if now.time() < clock_time(15):
        last_date -= timedelta(days=1)
    secid = f"{market}.{symbol.split('.')[0]}"
    quotes = fetch_eastmoney_series(secid, 0, last_date)
    adjusted = fetch_eastmoney_series(secid, 1, last_date)
    if not quotes or quotes.keys() != adjusted.keys():
        raise ValueError("东方财富不复权与前复权日线的日期不一致")
    return [(day, *quotes[day], adjusted[day][3], "CNY") for day in sorted(quotes)]


def fetch_yahoo_prices(symbol):
    params = urlencode({"period1": -2208988800, "period2": int(time.time()), "interval": "1d"})
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{quote(symbol, safe='')}?{params}"
    )
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=30) as response:
        chart = json.load(response)["chart"]
    if chart.get("error"):
        raise ValueError(chart["error"]["description"])
    if not chart.get("result"):
        raise ValueError("数据源没有返回行情")

    result = chart["result"][0]
    metadata = result["meta"]
    granularity = metadata.get("dataGranularity")
    if granularity != "1d":
        raise ValueError(f"数据源返回的粒度为 {granularity!r}，需要日频 1d")
    exchange_zone = ZoneInfo(metadata["exchangeTimezoneName"])
    currency = metadata["currency"]
    timestamps = result["timestamp"]
    indicators = result["indicators"]
    daily_quotes = indicators["quote"][0]
    price_series = [daily_quotes[field] for field in OHLC_FIELDS]
    adjusted_series = indicators.get("adjclose")
    adjusted = adjusted_series[0]["adjclose"] if adjusted_series else [None] * len(timestamps)
    if any(len(series) != len(timestamps) for series in (*price_series, adjusted)):
        raise ValueError("数据源返回的日期与价格数量不一致")

    regular_session = metadata.get("currentTradingPeriod", {}).get("regular", {})
    session_date = None
    if regular_session and time.time() < regular_session["end"]:
        session_date = datetime.fromtimestamp(regular_session["start"], exchange_zone).date()

    rows = {}
    for timestamp, opening, high, low, close, adjusted_close in zip(
        timestamps, *price_series, adjusted
    ):
        trading_date = datetime.fromtimestamp(timestamp, exchange_zone).date()
        if trading_date == session_date or close is None:
            continue
        for field, value in zip(OHLC_FIELDS, (opening, high, low, close)):
            if value is not None and not math.isfinite(value):
                raise ValueError(f"{trading_date} 的 {field} 价格无效")
        if adjusted_close is not None and not math.isfinite(adjusted_close):
            raise ValueError(f"{trading_date} 的复权收盘价无效")
        rows[trading_date] = (trading_date, opening, high, low, close, adjusted_close, currency)

    if not rows:
        raise ValueError("没有可保存的日收盘价")
    return [rows[date] for date in sorted(rows)]


def fetch_prices(symbol):
    code, _, exchange = symbol.rpartition(".")
    if exchange in EASTMONEY_MARKETS and re.fullmatch(r"\d{6}", code):
        return fetch_eastmoney_prices(symbol, EASTMONEY_MARKETS[exchange])
    return fetch_yahoo_prices(symbol)


def save_prices(symbol, rows, database_path):
    if not rows:
        raise ValueError("没有可保存的日线")
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(database_path, timeout=30)) as connection, connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS daily_prices (
                symbol TEXT NOT NULL,
                date TEXT NOT NULL,
                open REAL,
                high REAL,
                low REAL,
                close REAL NOT NULL,
                adjusted_close REAL,
                currency TEXT NOT NULL,
                PRIMARY KEY (symbol, date)
            ) WITHOUT ROWID
        """)
        connection.execute("DELETE FROM daily_prices WHERE symbol = ?", (symbol,))
        connection.executemany("""
            INSERT INTO daily_prices
                (symbol, date, open, high, low, close, adjusted_close, currency)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, ((symbol, day.isoformat(), *values) for day, *values in rows))


def main():
    parser = argparse.ArgumentParser(description="下载并保存股票和 ETF 的历史日线行情")
    parser.add_argument("symbols", nargs="+", metavar="SYMBOL")
    parser.add_argument("--db", type=Path, default=DATABASE_PATH, help="SQLite 数据库路径")
    args = parser.parse_args()
    failed = False
    processed = set()
    for raw_symbol in args.symbols:
        try:
            symbol = normalize_symbol(raw_symbol)
            if symbol in processed:
                continue
            processed.add(symbol)
            rows = fetch_prices(symbol)
            save_prices(symbol, rows, args.db)
        except (OSError, ValueError, KeyError, IndexError, TypeError, sqlite3.Error) as error:
            print(f"{raw_symbol} 下载或保存失败：{error}", file=sys.stderr)
            failed = True
            continue
        print(f"{symbol}：{len(rows)} 条，{rows[0][0]} 至 {rows[-1][0]}，{args.db}")
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
