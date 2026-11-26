"""Serve the local portfolio backtesting dashboard."""

import argparse
from contextlib import closing
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
from urllib.parse import urlsplit

from backtest import parse_weights, run_backtest
from prices import DATABASE_PATH

WEB = Path(__file__).resolve().parents[1] / "web"
STATIC = {
    "/": ("index.html", "text/html"),
    "/style.css": ("style.css", "text/css"),
    "/app.js": ("app.js", "text/javascript"),
    "/excel.mjs": ("excel.mjs", "text/javascript"),
}


class Dashboard(BaseHTTPRequestHandler):
    def respond(self, status, data, content_type="application/json"):
        if content_type == "application/json":
            data = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in STATIC:
            filename, content_type = STATIC[path]
            self.respond(200, (WEB / filename).read_bytes(), content_type)
        elif path == "/api/assets":
            try:
                uri = self.server.database.resolve().as_uri() + "?mode=ro"
                with closing(sqlite3.connect(uri, uri=True)) as connection:
                    rows = connection.execute("""
                        SELECT symbol, MIN(date), MAX(date) FROM daily_prices GROUP BY symbol
                    """).fetchall()
                self.respond(200, [
                    {"symbol": symbol, "start": start, "end": end}
                    for symbol, start, end in rows
                ])
            except sqlite3.Error:
                self.respond(503, {"error": "无法读取行情库，请检查 SQLite 文件及行情表。"})
        else:
            self.respond(404, {"error": "页面不存在"})

    def do_POST(self):
        if urlsplit(self.path).path != "/api/backtest":
            self.respond(404, {"error": "接口不存在"})
            return
        if self.headers.get_content_type() != "application/json":
            self.respond(415, {"error": "请求必须是 JSON"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                raise ValueError("请求大小无效")
            config = json.loads(self.rfile.read(length))
            if not isinstance(config, dict):
                raise ValueError("请求须为 JSON 对象")
            allocation = config["allocation"]
            if not isinstance(allocation, list) or not allocation:
                raise ValueError("至少选择一个标的")
            weights = parse_weights([f"{row['symbol']}={row['weight']}%" for row in allocation])
            report = run_backtest(
                self.server.database, date.fromisoformat(config["start"]),
                date.fromisoformat(config["end"]) if config.get("end") else None,
                float(config["amount"]), weights, config.get("price", "adjusted_close"),
                config.get("period"),
                float(config["threshold"]) / 100 if config.get("threshold") is not None else None,
                float(config.get("cashAnnualReturn", 0)) / 100,
            )
            self.respond(200, report)
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            self.respond(400, {"error": str(error)})
        except sqlite3.Error:
            self.respond(503, {"error": "无法读取行情库，请检查 SQLite 文件及行情表。"})


def main():
    parser = argparse.ArgumentParser(description="启动本地资产配置回测网站")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", type=Path, default=DATABASE_PATH)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), Dashboard) as server:
        server.database = args.db
        print(f"http://127.0.0.1:{server.server_port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
