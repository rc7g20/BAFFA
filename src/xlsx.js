// xlsx 讀取（取自 獸骨測量值解析工具.html 的 Reader；使用瀏覽器內建 DecompressionStream，不需外部函式庫）
const Xlsx = (function () {
  "use strict";

  async function inflateRaw(u8) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是有效的 xlsx 檔（找不到 zip 目錄）");
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    const td = new TextDecoder("utf-8");
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip 目錄格式錯誤");
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), cmtLen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
      files[name] = { method, csize, lho };
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return {
      names: Object.keys(files),
      async read(name) {
        const f = files[name];
        if (!f) return null;
        const ln = dv.getUint16(f.lho + 26, true), le = dv.getUint16(f.lho + 28, true);
        const start = f.lho + 30 + ln + le;
        const data = u8.subarray(start, start + f.csize);
        const out = f.method === 0 ? data : await inflateRaw(data);
        return td.decode(out);
      },
    };
  }

  function decodeXml(s) {
    return s.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|amp|lt|gt|quot|apos);/g, (m, hx, dc) =>
      hx ? String.fromCodePoint(parseInt(hx, 16)) : dc ? String.fromCodePoint(parseInt(dc, 10)) :
      { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" }[m])
      .replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  function textOf(xml) {
    // 串接 <t> 內容（忽略 <rPh> 注音/拼音）
    const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    let out = "";
    const rx = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
    let m;
    while ((m = rx.exec(clean))) out += m[1] ? decodeXml(m[1]) : "";
    return out;
  }
  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref);
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  async function readXlsx(buf) {
    const z = await unzip(buf);
    const wb = await z.read("xl/workbook.xml");
    const rels = (await z.read("xl/_rels/workbook.xml.rels")) || "";
    const relMap = {};
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /Id="([^"]+)"/.exec(m[0]), tg = /Target="([^"]+)"/.exec(m[0]);
      if (id && tg) relMap[id[1]] = tg[1];
    }
    const sheets = [];
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const name = decodeXml(/name="([^"]*)"/.exec(m[0])[1]);
      const rid = /r:id="([^"]+)"/.exec(m[0]);
      let target = rid ? relMap[rid[1]] : null;
      if (!target) continue;
      target = target.replace(/^\/?xl\//, "").replace(/^\//, "");
      sheets.push({ name, path: "xl/" + target });
    }
    const styles = parseStyles((await z.read("xl/styles.xml")) || "");
    const ssXml = await z.read("xl/sharedStrings.xml");
    const shared = [];
    if (ssXml) for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? textOf(m[1]) : "");
    return {
      sheetNames: sheets.map((s) => s.name),
      async readSheet(name) {
        const sh = sheets.find((s) => s.name === name);
        const xml = await z.read(sh.path);
        const rows = [];
        const rowRx = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
        let rm;
        while ((rm = rowRx.exec(xml))) {
          if (!rm[2]) continue;
          const rnum = /\br="(\d+)"/.exec(rm[1]);
          const arr = [];
          const cellRx = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
          let cm, ci = 0;
          while ((cm = cellRx.exec(rm[2]))) {
            const attrs = cm[1], inner = cm[2] || "";
            const r = /\br="([A-Z]+\d+)"/.exec(attrs);
            if (r) ci = colIndex(r[1]);
            const t = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
            const si = (/\bs="(\d+)"/.exec(attrs) || [])[1];
            let v = null;
            if (t === "inlineStr") v = textOf(inner);
            else {
              const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
              if (vm) {
                const raw = decodeXml(vm[1]);
                if (t === "s") v = shared[parseInt(raw, 10)];
                else if (t === "b") v = raw === "1" ? "TRUE" : "FALSE";
                else if (t === "str" || t === "e") v = raw;
                else v = formatNumber(raw, si === undefined ? null : styles[+si]);
              }
            }
            if (typeof v === "string") v = v.replace(/\r\n?/g, "\n");
            if (v !== null && v !== "") arr[ci] = v;
            ci++;
          }
          rows.push({ r: rnum ? parseInt(rnum[1], 10) : rows.length + 1, cells: arr });
        }
        return rows;
      },
    };
  }
  // ---- 數值格式（讓輸出與 Excel 畫面上看到的一致，例如原代號 00087）
  const BUILTIN = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
    12: "# ?/?", 13: "# ??/??", 14: "yyyy/m/d", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM",
    20: "h:mm", 21: "h:mm:ss", 22: "yyyy/m/d h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)",
    40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@" };
  function parseStyles(xml) {
    const custom = {};
    for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
      const id = /numFmtId="(\d+)"/.exec(m[0]), code = /formatCode="([^"]*)"/.exec(m[0]);
      if (id && code) custom[+id[1]] = decodeXml(code[1]);
    }
    const out = [];
    const cx = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
    if (cx) for (const m of cx[1].matchAll(/<xf\b[^>]*>/g)) {
      const id = +((/numFmtId="(\d+)"/.exec(m[0]) || [])[1] || 0);
      out.push(custom[id] ?? BUILTIN[id] ?? "General");
    }
    return out;
  }
  function formatNumber(raw, fmt) {
    const x = Number(raw);
    if (!fmt || fmt === "General" || fmt === "@" || !isFinite(x)) return numStr(raw);
    let f = fmt.split(";")[x < 0 && fmt.includes(";") ? 1 : 0] || fmt.split(";")[0];
    f = f.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/_./g, "").replace(/\\(.)/g, "$1").replace(/[*].?/g, "").trim();
    const ax = Math.abs(x), neg = x < 0 && !fmt.includes(";");
    // 日期／時間
    if (/[ymdhs]/i.test(f) && !/^[#0.,%]+$/.test(f)) {
      const ms = Math.round((x - 25569) * 86400000);
      const d = new Date(ms), p2 = (n) => String(n).padStart(2, "0");
      let out = `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}`;
      if (/h/i.test(f)) out += ` ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` + (/s/i.test(f) ? `:${p2(d.getUTCSeconds())}` : "");
      if (!/[yd]/i.test(f) && /h/i.test(f)) out = out.slice(11);
      return out;
    }
    const m = /^([#,0]*)(?:\.([0#]+))?(%?)$/.exec(f);
    if (!m || !/0|#/.test(f)) return numStr(raw);
    let val = m[3] ? ax * 100 : ax;
    const minInt = (m[1].match(/0/g) || []).length;
    const fixed = m[2] ? (m[2].match(/0/g) || []).length : 0, maxDec = m[2] ? m[2].length : 0;
    let s = val.toFixed(maxDec);
    if (maxDec > fixed) s = s.replace(new RegExp("0{1," + (maxDec - fixed) + "}$"), "").replace(/\.$/, "");
    let [ip, dp] = s.split(".");
    if (ip === "0" && minInt === 0) ip = "";
    ip = ip.padStart(minInt, "0");
    if (m[1].includes(",")) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + ip + (dp ? "." + dp : "") + m[3];
  }
  function numStr(raw) {
    const x = Number(raw);
    if (!isFinite(x)) return raw;
    if (Number.isInteger(x)) return String(x);
    return String(parseFloat(x.toPrecision(15)));
  }

  function decodeText(buf) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder("big5").decode(buf); }
  }
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    const rows = [];
    let row = [], f = "", q = false, i = 0;
    const delim = (text.split(/\r?\n/)[0].match(/\t/g) || []).length > (text.split(/\r?\n/)[0].match(/,/g) || []).length ? "\t" : ",";
    while (i < text.length) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(f); rows.push(row); row = []; f = "";
      } else f += c;
      i++;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows.map((cells, k) => ({ r: k + 1, cells: cells.map((x) => (x === "" ? undefined : x)) }));
  }

  // 將列陣列轉為紀錄（第一個非空列為標題）
  function toRecords(rows) {
    const hi = rows.findIndex((r) => r.cells.some((x) => x !== undefined && x !== null && String(x).trim() !== ""));
    if (hi < 0) return { header: [], records: [] };
    const header = [];
    rows[hi].cells.forEach((h, j) => (header[j] = h === undefined ? null : String(h).trim()));
    const records = [];
    for (let k = hi + 1; k < rows.length; k++) {
      const cells = rows[k].cells;
      if (!cells.some((x) => x !== undefined && x !== null && String(x) !== "")) continue;
      const o = { __row: rows[k].r };
      header.forEach((h, j) => { if (h) o[h] = cells[j] === undefined ? null : cells[j]; });
      records.push(o);
    }
    return { header: header.filter((h) => h), records };
  }

  return { readXlsx, parseCSV, decodeText, toRecords };
})();
