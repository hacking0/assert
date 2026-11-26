// A small OOXML writer for the fixed backtest report schema.
const encoder = new TextEncoder();
const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const sheetNS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const officeRel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRel = "http://schemas.openxmlformats.org/package/2006/relationships";
const escape = value => String(value).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);

function worksheet(rows, formats = {}) {
  const cells = rows.map((row, index) => {
    const values = row.map((value, col) => {
      if (value == null) return "";
      const ref = String.fromCharCode(65 + col) + (index + 1);
      const style = index === 0 ? 3 : formats[col] || 0;
      if (typeof value === "number") return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
    }).join("");
    return `<row r="${index+1}">${values}</row>`;
  }).join("");
  const count = rows[0].length;
  return xmlHeader + `<worksheet xmlns="${sheetNS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${count}" width="21" customWidth="1"/></cols><sheetData>${cells}</sheetData><autoFilter ref="A1:${String.fromCharCode(64+count)}${rows.length}"/></worksheet>`;
}

const crcTable = Uint32Array.from({length:256}, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ (byte & 1 ? 0xedb88320 : 0);
  return byte;
});

function zip(files) {
  const parts = [], directory = [];
  let offset = 0, directorySize = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = encoder.encode(path), bytes = encoder.encode(content);
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, 33, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, bytes);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(14, 33, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, bytes.length, true);
    entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    directory.push(entry.buffer, name);
    directorySize += 46 + name.length;
    offset += 30 + name.length + bytes.length;
  }
  const count = Object.keys(files).length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end.buffer], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}

export function exportWorkbook(report) {
  const s = report.summary;
  const sheets = [
    ["回测摘要", worksheet([
      ["指标","数值","比例"],
      ["实际开始日期",s.start_date],["实际截止日期",s.end_date],["币种",s.currency],
      ["初始投入",s.initial_amount],["期末市值",s.final_value],["累计盈亏",s.profit_loss],
      ["累计收益率",null,s.total_return],["最大回撤",null,s.max_drawdown],
      ["调仓次数",s.rebalance_count],["累计单边换手率",null,s.total_turnover],
      ["计价口径",s.price_column === "close" ? "收盘价" : "复权收盘价"],
      ["再平衡周期",s.rebalance_every],["偏离阈值",null,s.rebalance_threshold],
      ["现金固定年化收益",null,s.cash_annual_return],
      ...Object.entries(s.initial_weights).map(([symbol,weight])=>["初始权重",symbol,weight])
    ], {2:1})],
    ["每日估值", worksheet([
      ["日期","组合市值","累计盈亏","单日收益率","累计收益率","回撤"],
      ...report.daily.map(r=>[r.date,r.value,r.profit_loss,r.daily_return,r.cumulative_return,r.drawdown])
    ], {1:2,2:2,3:1,4:1,5:1})],
    ["每日持仓", worksheet([
      ["估值日","标的","报价日","估值价格","持仓市值","实际权重","标的累计收益率"],
      ...report.daily.flatMap(r=>Object.entries(r.positions).map(([symbol,p])=>
        [r.date,symbol,p.quote_date,p.price,p.value,p.weight,p.cumulative_return]))
    ], {4:2,5:1,6:1})],
    ["调仓记录", worksheet([
      ["执行日","计划日","信号日","标的","调仓前权重","调仓后权重","交易金额","单边换手率"],
      ...report.rebalances.flatMap(r=>Object.entries(r.positions).map(([symbol,p],i)=>
        [r.date,r.scheduled_date,r.signal?.date,symbol,p.weight_before,p.weight_after,p.trade_value,i===0?r.turnover:null]))
    ], {4:1,5:1,6:2,7:1})]
  ];
  const fileEntries = sheets.map(([,body],i)=>[`xl/worksheets/sheet${i+1}.xml`,body]);
  const rel = (id,type,target) => `<Relationship Id="${id}" Type="${officeRel}/${type}" Target="${target}"/>`;
  const rels = body => xmlHeader + `<Relationships xmlns="${packageRel}">${body}</Relationships>`;
  const override = (path,type) => `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${type}+xml"/>`;
  return zip({
    "[Content_Types].xml":xmlHeader + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      override("xl/workbook.xml","sheet.main") + override("xl/styles.xml","styles") +
      fileEntries.map(([path])=>override(path,"worksheet")).join("") + "</Types>",
    "_rels/.rels":rels(rel("rId1","officeDocument","xl/workbook.xml")),
    "xl/workbook.xml":xmlHeader + `<workbook xmlns="${sheetNS}" xmlns:r="${officeRel}"><sheets>` +
      sheets.map(([name],i)=>`<sheet name="${name}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join("") + "</sheets></workbook>",
    "xl/_rels/workbook.xml.rels":rels(fileEntries.map((_,i)=>rel("rId"+(i+1),"worksheet",`worksheets/sheet${i+1}.xml`)).join("") + rel("rId"+(sheets.length+1),"styles","styles.xml")),
    "xl/styles.xml":xmlHeader + `<styleSheet xmlns="${sheetNS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF126659"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf xfId="0"/><xf xfId="0" numFmtId="10" applyNumberFormat="1"/><xf xfId="0" numFmtId="4" applyNumberFormat="1"/><xf xfId="0" fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ...Object.fromEntries(fileEntries)
  });
}
