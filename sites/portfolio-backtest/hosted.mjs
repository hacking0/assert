import {backtest} from "./engine.mjs";

let snapshot;
window.portfolioRequest = async (url, options) => {
  if (!snapshot) {
    const response = await fetch("/quotes.json");
    if (!response.ok) throw Error("无法加载历史行情快照");
    snapshot = await response.json();
  }
  if (url === "/api/assets") {
    return Object.entries(snapshot).map(([symbol,rows])=>({
      symbol,start:rows[0][0],end:rows.at(-1)[0]
    }));
  }
  return backtest(snapshot,JSON.parse(options.body));
};
await import("./app.js");
