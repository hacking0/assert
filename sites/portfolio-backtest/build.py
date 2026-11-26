"""Build a private Sites artifact from the latest local quote snapshot."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=HERE / "dist")
    parser.add_argument("--db", type=Path, default=ROOT / "data" / "prices.sqlite3")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    prices = {}
    uri = args.db.resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        for symbol, *quote in connection.execute("""
            SELECT symbol, date, close, adjusted_close, currency FROM daily_prices
            ORDER BY symbol, date
        """):
            prices.setdefault(symbol, []).append(quote)
    if not prices:
        raise ValueError("行情库没有可发布的日线")
    (args.output / "quotes.json").write_text(json.dumps(prices, separators=(",", ":")))
    index = (ROOT / "web" / "index.html").read_text()
    index = index.replace('<script defer src="/app.js"></script>',
                          '<script type="module" src="/hosted.mjs"></script>')
    index = index.replace("本地行情库", "历史行情快照")
    (args.output / "index.html").write_text(index)
    for name in ("app.js", "style.css"):
        (args.output / name).write_bytes((ROOT / "web" / name).read_bytes())
    for name in ("engine.mjs", "hosted.mjs"):
        (args.output / name).write_bytes((HERE / name).read_bytes())


if __name__ == "__main__":
    main()
