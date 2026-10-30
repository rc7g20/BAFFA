// ============================================================================
// 圖表：SVG 繪製（長條、橫條、折線、散點、直方圖）＋ PNG／SVG 匯出
// ============================================================================
"use strict";
const Charts = (() => {
  const PALETTE = ["#2f6b5e", "#c0763a", "#5b7fa6", "#b5545c", "#8a7a3d", "#7a5c99", "#4f9a8f", "#d4a72c", "#6b6b6b", "#9c6644",
    "#3d5a80", "#e07a5f"];
  const FONT = '"Noto Sans TC","Microsoft JhengHei","PingFang TC","Heiti TC",Arial,sans-serif';

  const DEFAULT_STYLE = {
    title: "", xLabel: "", yLabel: "", width: 760, height: 440, fontSize: 13,
    fill: true, fillOpacity: 0.85, strokeColor: "", strokeWidth: 1, lineWidth: 2, pointSize: 5, pointShape: "circle",
    barGap: 0.25, showGrid: true, showValues: false, legend: "right", colorByCategory: false,
    colors: {}, binWidth: "", binStart: "", xMin: "", xMax: "", yMin: "", yMax: "", stacked: false, labelAngle: "auto",
    background: "#ffffff",
    colorBy: "", patterns: {}, patternSize: 8, patternWidth: 1.2, patternBg: "#ffffff", shapes: {},
    groupGap: 0.6, showGroups: true,
  };
  const PATTERNS = [["", "實心（無圖樣）"], ["diag", "斜線 ／"], ["diag2", "斜線 ＼"], ["cross", "交叉斜線 ╳"], ["horiz", "橫線 ═"],
    ["vert", "直線 ║"], ["grid", "方格 ╬"], ["dots", "點點 ⠿"], ["dense", "密點"], ["empty", "空白（只有外框）"]];
  const BW_PATTERNS = ["", "diag", "dots", "cross", "horiz", "diag2", "grid", "vert", "dense", "empty"];
  const BW_COLORS = ["#222222", "#555555", "#222222", "#333333", "#444444", "#222222", "#555555", "#333333", "#222222", "#222222"];
  const SHAPES = ["circle", "square", "triangle", "diamond"];

  function patternDef(id, kind, color, st) {
    const z = Number(st.patternSize) || 8, lw = Number(st.patternWidth) || 1.2;
    const bg = st.patternBg && st.patternBg !== "none" ? `<rect width="${z}" height="${z}" fill="${st.patternBg}"/>` : "";
    const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${lw}"/>`;
    let body = "", tr = "";
    if (kind === "diag" || kind === "diag2" || kind === "cross") {
      tr = ` patternTransform="rotate(${kind === "diag2" ? -45 : 45})"`;
      body = line(z / 2, 0, z / 2, z) + (kind === "cross" ? line(0, z / 2, z, z / 2) : "");
    } else if (kind === "horiz") body = line(0, z / 2, z, z / 2);
    else if (kind === "vert") body = line(z / 2, 0, z / 2, z);
    else if (kind === "grid") body = line(z / 2, 0, z / 2, z) + line(0, z / 2, z, z / 2);
    else if (kind === "dots") body = `<circle cx="${z / 2}" cy="${z / 2}" r="${lw * 1.1}" fill="${color}"/>`;
    else if (kind === "dense") body = `<circle cx="${z / 4}" cy="${z / 4}" r="${lw * 0.8}" fill="${color}"/><circle cx="${z * 3 / 4}" cy="${z * 3 / 4}" r="${lw * 0.8}" fill="${color}"/>`;
    else if (kind === "empty") body = "";
    return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${z}" height="${z}"${tr}>${bg}${body}</pattern>`;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v) => (v === "" || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));

  function niceTicks(lo, hi, n = 5) {
    if (lo === hi) { hi = lo + 1; }
    const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const err = step0 / mag;
    const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
    const t = [];
    for (let v = a; v <= b + step * 1e-9; v += step) t.push(+v.toFixed(10));
    return { ticks: t, min: a, max: b, step };
  }
  function fmt(v, f) {
    if (v === null || v === undefined || isNaN(v)) return "";
    if (f === "pct") return (v * 100).toFixed(Math.abs(v) < 0.1 && v !== 0 ? 2 : 1) + "%";
    if (f === "int") return Math.round(v).toLocaleString();
    return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : +v.toFixed(2) + "";
  }
  function tickFmt(v, f, dec) {
    if (f === "pct") return (v * 100).toFixed(Math.max(0, dec - 2)) + "%";
    if (f === "int") return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(dec);
    return v.toFixed(dec);
  }
  const textW = (s, fs) => [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? fs : fs * 0.56), 0);

  function colorOf(style, name, i) { return (style.colors && style.colors[name]) || PALETTE[i % PALETTE.length]; }
  function darker(hex, k = 0.75) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return hex;
    const n = parseInt(m[1], 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return "#" + [r, g, b].map((x) => Math.round(x * k).toString(16).padStart(2, "0")).join("");
  }

  /** 計算直方圖分組 */
  function bins(series, style) {
    const all = series.flatMap((s) => s.values).filter((v) => v !== null && !isNaN(v));
    if (!all.length) return { edges: [], counts: series.map(() => []) };
    let lo = Math.min(...all), hi = Math.max(...all);
    let w = num(style.binWidth);
    if (!w || w <= 0) {
      const k = Math.max(5, Math.ceil(Math.log2(all.length) + 1));
      w = niceTicks(0, (hi - lo) || 1, k).step;
    }
    let start = num(style.binStart);
    if (start === null || start > lo) start = Math.floor(lo / w) * w;
    const edges = [];
    for (let e = start; e <= hi + 1e-9; e += w) edges.push(+e.toFixed(10));
    edges.push(+(edges[edges.length - 1] + w).toFixed(10));
    const counts = series.map((s) => {
      const c = new Array(edges.length - 1).fill(0);
      for (const v of s.values) {
        if (v === null || isNaN(v)) continue;
        let i = Math.floor((v - start) / w + 1e-9); if (i >= c.length) i = c.length - 1; if (i >= 0) c[i]++;
      }
      return c;
    });
    return { edges, counts, w };
  }

  /**
   * spec: {type:'bar'|'hbar'|'line'|'scatter'|'hist', categories, series:[{name, values|points}], valueFormat}
   * style: DEFAULT_STYLE 的欄位
   */
  function render(spec, style0, size) {
    const st = { ...DEFAULT_STYLE, ...style0 };
    // 樣式中留空的標題／軸標題，使用資料提供的預設文字
    for (const k of ["title", "xLabel", "yLabel"]) if (!st[k] && spec[k]) st[k] = spec[k];
    const W = size ? size.w : st.width, H = size ? size.h : st.height;
    const fs = Number(st.fontSize) || 13;
    const type = spec.type;
    const series = spec.series || [];
    const multi = series.length > 1;
    const out = [];
    const legendItems = [];
    const uid = "c" + Math.random().toString(36).slice(2, 8);
    let colorBy = st.colorBy || spec.defaultColorBy || (st.colorByCategory ? "category" : "series");
    if (colorBy === "group" && !spec.catGroups) colorBy = "series";
    if ((type === "scatter" || type === "hist" || type === "line") && colorBy !== "series") colorBy = "series";

    // ----- 資料範圍
    let cats = spec.categories || [];
    let xIsCat = type === "bar" || type === "line" || type === "hbar";
    let hist = null;
    if (type === "hist") { hist = bins(series, st); cats = hist.edges.slice(0, -1); }
    let yLo = 0, yHi = 1, xLo = 0, xHi = 1;
    if (xIsCat) {
      let vals;
      if (st.stacked && (type === "bar" || type === "hbar")) vals = cats.map((_, i) => series.reduce((a, s) => a + (num(s.values[i]) || 0), 0));
      else vals = series.flatMap((s) => s.values.map(num)).filter((v) => v !== null);
      yLo = Math.min(0, ...vals); yHi = Math.max(0, ...vals, 0);
      if (yHi === yLo) yHi = yLo + 1;
    } else if (type === "scatter") {
      const pts = series.flatMap((s) => s.points);
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      xLo = Math.min(...xs); xHi = Math.max(...xs); yLo = Math.min(...ys); yHi = Math.max(...ys);
      if (!pts.length) { xLo = 0; xHi = 1; yLo = 0; yHi = 1; }
      const px = (xHi - xLo) * 0.05 || 1, py = (yHi - yLo) * 0.05 || 1;
      xLo -= px; xHi += px; yLo -= py; yHi += py;
    } else if (type === "hist") {
      xLo = hist.edges[0] ?? 0; xHi = hist.edges[hist.edges.length - 1] ?? 1;
      yLo = 0;
      yHi = st.stacked ? Math.max(1, ...cats.map((_, i) => hist.counts.reduce((a, c) => a + c[i], 0)))
        : Math.max(1, ...hist.counts.flat());
    }
    if (spec.yFixed) { yLo = spec.yFixed[0]; yHi = spec.yFixed[1]; }
    if (num(st.yMin) !== null) yLo = num(st.yMin);
    if (num(st.yMax) !== null) yHi = num(st.yMax);
    if (num(st.xMin) !== null) xLo = num(st.xMin);
    if (num(st.xMax) !== null) xHi = num(st.xMax);
    const valFmt = spec.valueFormat || "num";
    const dataHi = yHi;
    let yT = niceTicks(yLo, yHi, Math.max(3, Math.round((H - 120) / 60)));
    if (!spec.yFixed && num(st.yMax) === null && yT.max > 0 && dataHi >= yT.max - yT.step * 0.02) yT = niceTicks(yLo, yHi + yT.step * 0.5, Math.max(3, Math.round((H - 120) / 60)));
    if (num(st.yMin) === null) yLo = Math.min(yLo, yT.min); if (num(st.yMax) === null) yHi = yT.max;
    const yDec = Math.max(0, -Math.floor(Math.log10(yT.step) + 1e-9));
    let xT = null;
    if (type === "scatter" || type === "hist") {
      xT = niceTicks(xLo, xHi, Math.max(3, Math.round((W - 160) / 80)));
      if (type === "scatter") { if (num(st.xMin) === null) xLo = xT.min; if (num(st.xMax) === null) xHi = xT.max; }
    }

    // ----- 上色鍵（系列／分組／類別）與圖樣
    const keyOf = (sName, c, i) => (colorBy === "group" ? spec.catGroups[i] : colorBy === "category" ? String(c) : sName);
    const keyList = [];
    if (colorBy === "series") series.forEach((s) => keyList.push(s.name));
    else cats.forEach((c, i) => { const k = keyOf("", c, i); if (!keyList.includes(k)) keyList.push(k); });
    const colorOfKey = (k) => (st.colors && st.colors[k]) || PALETTE[Math.max(0, keyList.indexOf(k)) % PALETTE.length];
    const defs = [];
    const fillOf = (k) => {
      const pat = st.patterns && st.patterns[k];
      if (!pat) return colorOfKey(k);
      const id = `${uid}_p${keyList.indexOf(k)}`;
      if (!defs.some((d) => d.includes(`id="${id}"`))) defs.push(patternDef(id, pat, colorOfKey(k), st));
      return `url(#${id})`;
    };
    const shapeOf = (k) => (st.shapes && st.shapes[k]) || st.pointShape;

    // ----- 版面
    const showLegend = st.legend !== "none" && keyList.length > 1;
    if (showLegend) keyList.forEach((k) => legendItems.push({ name: k, color: colorOfKey(k) }));
    const legW = showLegend && st.legend === "right" ? Math.min(220, Math.max(...legendItems.map((l) => textW(l.name, fs))) + 44) : 0;
    const legH = showLegend && (st.legend === "top" || st.legend === "bottom") ? fs + 14 : 0;
    const titleH = st.title ? fs * 1.5 + 10 : 8;
    const yTickW = Math.max(...yT.ticks.map((t) => textW(tickFmt(t, type === "hist" ? "int" : valFmt, yDec), fs * 0.92))) + 10;
    let catLabelW = 0, rot = 0;
    const catLabels = type === "hist" ? [] : cats.map(String);
    if (type === "hbar") catLabelW = Math.max(0, ...catLabels.map((c) => textW(c, fs * 0.92))) + 10;
    let left = 14 + (st.yLabel ? fs * 1.4 : 0) + (type === "hbar" ? catLabelW : yTickW);
    let right = 16 + legW;
    let plotW = W - left - right;
    let bottomLab = fs + 12;
    if (xIsCat && type !== "hbar" && cats.length) {
      const slot = plotW / cats.length;
      const maxw = Math.max(...catLabels.map((c) => textW(c, fs * 0.92)));
      rot = st.labelAngle === "auto" ? (maxw > slot - 4 ? (maxw * 0.5 > slot ? 90 : 45) : 0) : Number(st.labelAngle) || 0;
      bottomLab = rot ? Math.min(maxw * Math.sin(rot * Math.PI / 180) + fs + 10, H * 0.45) : fs + 12;
    }
    if (type === "hbar") bottomLab = fs + 12;
    // 第一級分組（例如骨骼區域）：類別之間留空隙並在軸外標示組名
    const grp = (type === "bar" || type === "hbar") && spec.catGroups && st.showGroups !== false ? spec.catGroups : null;
    const groupH = grp ? fs * 1.7 : 0;
    if (grp && type === "bar") bottomLab += groupH;
    if (grp && type === "hbar") { left += groupH; plotW -= groupH; }
    const top = titleH + (st.legend === "top" ? legH : 0) + 6;
    const bottom = bottomLab + (st.xLabel ? fs * 1.5 : 0) + (st.legend === "bottom" ? legH : 0) + 6;
    const plotH = H - top - bottom;

    const yScale = (v) => top + plotH - ((v - yLo) / (yHi - yLo)) * plotH;
    const xScaleNum = (v) => left + ((v - xLo) / (xHi - xLo)) * plotW;

    out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${esc(st.background || "#fff")}"/>`);
    if (st.title) out.push(`<text x="${W / 2}" y="${fs * 1.25 + 4}" text-anchor="middle" font-size="${fs * 1.2}" font-weight="600">${esc(st.title)}</text>`);
    out.push(`<defs><clipPath id="${uid}_clip"><rect x="${left}" y="${top}" width="${plotW}" height="${plotH}"/></clipPath></defs>`);

    // ----- 格線與數值軸
    const valTicks = yT.ticks.filter((t) => t >= yLo - 1e-9 && t <= yHi + 1e-9);
    if (type === "hbar") {
      const xs = (v) => left + ((v - yLo) / (yHi - yLo)) * plotW;
      for (const t of valTicks) {
        const x = xs(t);
        if (st.showGrid) out.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${top + plotH}" stroke="#e4e0d8"/>`);
        out.push(`<text x="${x}" y="${top + plotH + fs + 4}" text-anchor="middle" font-size="${fs * 0.92}" fill="#555">${esc(tickFmt(t, valFmt, yDec))}</text>`);
      }
    } else {
      for (const t of valTicks) {
        const y = yScale(t);
        if (st.showGrid) out.push(`<line x1="${left}" y1="${y}" x2="${left + plotW}" y2="${y}" stroke="#e4e0d8"/>`);
        out.push(`<text x="${left - 6}" y="${y + fs * 0.34}" text-anchor="end" font-size="${fs * 0.92}" fill="#555">${esc(tickFmt(t, type === "hist" ? "int" : valFmt, yDec))}</text>`);
      }
    }
    const xDec = xT ? Math.max(0, -Math.floor(Math.log10(xT.step) + 1e-9)) : 0;
    if (xT && type === "scatter") {
      for (const t of xT.ticks.filter((t) => t >= xLo - 1e-9 && t <= xHi + 1e-9)) {
        const x = xScaleNum(t);
        if (st.showGrid) out.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${top + plotH}" stroke="#e4e0d8"/>`);
        out.push(`<text x="${x}" y="${top + plotH + fs + 4}" text-anchor="middle" font-size="${fs * 0.92}" fill="#555">${esc(tickFmt(t, "num", xDec))}</text>`);
      }
    }

    const sw = Number(st.strokeWidth) || 0;
    const fo = st.fill ? Number(st.fillOpacity) : 0;
    const strokeFor = (c) => (st.strokeColor ? st.strokeColor : darker(c));
    const valueLabel = (x, y, v, anchor = "middle") =>
      st.showValues ? `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${fs * 0.82}" fill="#333">${esc(fmt(v, valFmt))}</text>` : "";

    // ----- 繪製
    if (type === "bar" || type === "hbar") {
      const n = cats.length;
      // 位置：每個類別 1 格，分組之間多留 groupGap 格
      const gap = grp ? Math.max(0, Number(st.groupGap) || 0) : 0;
      const before = []; let ng = 0;
      cats.forEach((c, i) => { if (grp && i > 0 && grp[i] !== grp[i - 1]) ng++; before.push(ng); });
      const units = n + ng * gap;
      const slot = (type === "hbar" ? plotH : plotW) / Math.max(1, units);
      const pos = (i) => (i + before[i] * gap) * slot;
      const inner = slot * (1 - Math.min(0.9, Math.max(0, Number(st.barGap))));
      const nb = st.stacked ? 1 : series.length;
      const bw = inner / Math.max(1, nb);
      const vs = (v) => (type === "hbar" ? left + ((v - yLo) / (yHi - yLo)) * plotW : yScale(v));
      cats.forEach((c, i) => {
        let acc = 0;
        series.forEach((s, j) => {
          const v = num(s.values[i]); if (v === null) return;
          const k = keyOf(s.name, c, i);
          const col = colorOfKey(k);
          const a = st.stacked ? acc : 0, b = st.stacked ? acc + v : v; acc += st.stacked ? v : 0;
          const off = (slot - inner) / 2 + (st.stacked ? 0 : j * bw);
          let x, y, w, h;
          if (type === "hbar") { y = top + pos(i) + off; h = bw; x = Math.min(vs(a), vs(b)); w = Math.abs(vs(b) - vs(a)); }
          else { x = left + pos(i) + off; w = bw; y = Math.min(vs(a), vs(b)); h = Math.abs(vs(b) - vs(a)); }
          const pat = st.patterns && st.patterns[k];
          const strokeW = pat ? Math.max(sw, 0.8) : sw;
          out.push(`<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" fill="${fillOf(k)}" fill-opacity="${fo}" stroke="${strokeW ? strokeFor(col) : "none"}" stroke-width="${strokeW}"><title>${esc(s.name)} ${esc(c)}: ${esc(fmt(v, valFmt))}</title></rect>`);
          if (!st.stacked) out.push(type === "hbar" ? valueLabel(x + w + 4, y + h / 2 + fs * 0.3, v, "start") : valueLabel(x + w / 2, y - 4, v));
        });
        if (st.stacked && st.showValues) out.push(type === "hbar" ? valueLabel(vs(acc) + 4, top + pos(i) + slot / 2 + fs * 0.3, acc, "start") : valueLabel(left + pos(i) + slot / 2, vs(acc) - 4, acc));
      });
      // 類別標籤
      cats.forEach((c, i) => {
        if (type === "hbar") out.push(`<text x="${left - 6}" y="${top + pos(i) + slot / 2 + fs * 0.32}" text-anchor="end" font-size="${fs * 0.92}">${esc(c)}</text>`);
        else catLabel(out, left + pos(i) + slot / 2, top + plotH, c, rot, fs);
      });
      // 分組標示
      if (grp) {
        const spans = [];
        cats.forEach((c, i) => { if (!spans.length || spans[spans.length - 1].g !== grp[i]) spans.push({ g: grp[i], a: i, b: i }); else spans[spans.length - 1].b = i; });
        for (const sp of spans) {
          const p0 = pos(sp.a) + slot * 0.08, p1 = pos(sp.b) + slot * 0.92;
          if (type === "bar") {
            const y = top + plotH + bottomLab - groupH + 4;
            out.push(`<path d="M${left + p0},${y - 4} L${left + p0},${y} L${left + p1},${y} L${left + p1},${y - 4}" fill="none" stroke="#777"/>`);
            out.push(`<text x="${left + (p0 + p1) / 2}" y="${y + fs * 1.05}" text-anchor="middle" font-size="${fs * 0.95}" font-weight="600">${esc(sp.g)}</text>`);
          } else {
            const x = left - catLabelW - 4;
            out.push(`<path d="M${x + 4},${top + p0} L${x},${top + p0} L${x},${top + p1} L${x + 4},${top + p1}" fill="none" stroke="#777"/>`);
            out.push(`<text transform="translate(${x - 5},${top + (p0 + p1) / 2}) rotate(-90)" text-anchor="middle" font-size="${fs * 0.95}" font-weight="600">${esc(sp.g)}</text>`);
          }
        }
      }
    } else if (type === "line") {
      const n = cats.length, slot = plotW / Math.max(1, n);
      const xOf = (i) => left + i * slot + slot / 2;
      series.forEach((s, j) => {
        const col = colorOfKey(s.name);
        const pts = s.values.map((v, i) => [xOf(i), num(v)]).filter((p) => p[1] !== null);
        if (!pts.length) return;
        if (st.fill && fo > 0) {
          const base = yScale(Math.max(yLo, 0));
          const d = `M${pts[0][0]},${base} ` + pts.map((p) => `L${p[0]},${yScale(p[1])}`).join(" ") + ` L${pts[pts.length - 1][0]},${base} Z`;
          out.push(`<path d="${d}" fill="${fillOf(s.name)}" fill-opacity="${st.patterns && st.patterns[s.name] ? fo : fo * 0.35}" stroke="none"/>`);
        }
        const dash = st.dashes && st.dashes[s.name] ? ` stroke-dasharray="${st.dashes[s.name]}"` : "";
        out.push(`<polyline points="${pts.map((p) => `${p[0]},${yScale(p[1])}`).join(" ")}" fill="none" stroke="${col}" stroke-width="${st.lineWidth}"${dash}/>`);
        for (const [x, v] of pts) {
          out.push(marker(x, yScale(v), { ...st, pointShape: shapeOf(s.name) }, col, `${s.name}: ${fmt(v, valFmt)}`));
          out.push(valueLabel(x, yScale(v) - 7, v));
        }
      });
      cats.forEach((c, i) => catLabel(out, xOf(i), top + plotH, c, rot, fs));
    } else if (type === "scatter") {
      out.push(`<g clip-path="url(#${uid}_clip)">`);
      series.forEach((s, j) => {
        const col = colorOfKey(s.name);
        for (const p of s.points) out.push(marker(xScaleNum(p.x), yScale(p.y), { ...st, pointShape: shapeOf(s.name) }, col, `${p.label ? p.label + " " : ""}(${fmt(p.x)}, ${fmt(p.y)})`));
      });
      out.push(`</g>`);
    } else if (type === "hist") {
      const xs = (v) => left + ((v - xLo) / (xHi - xLo)) * plotW;
      const stackAcc = new Array(cats.length).fill(0);
      series.forEach((s, j) => {
        const col = colorOfKey(s.name);
        const hpat = st.patterns && st.patterns[s.name];
        hist.counts[j].forEach((c, i) => {
          if (!c) return;
          const a = st.stacked ? stackAcc[i] : 0, b = a + c; if (st.stacked) stackAcc[i] = b;
          const x0 = xs(hist.edges[i]), x1 = xs(hist.edges[i + 1]);
          out.push(`<rect x="${x0}" y="${yScale(b)}" width="${Math.max(0, x1 - x0)}" height="${Math.max(0, yScale(a) - yScale(b))}" fill="${fillOf(s.name)}" fill-opacity="${fo}" stroke="${sw || hpat ? strokeFor(col) : "none"}" stroke-width="${hpat ? Math.max(sw, 0.8) : sw}"><title>${esc(s.name)} ${fmt(hist.edges[i])}–${fmt(hist.edges[i + 1])}: ${c}</title></rect>`);
          if (!st.stacked) out.push(st.showValues ? `<text x="${(x0 + x1) / 2}" y="${yScale(b) - 4}" text-anchor="middle" font-size="${fs * 0.8}">${c}</text>` : "");
        });
      });
      const step = hist.edges.length > 16 ? Math.ceil(hist.edges.length / 12) : 1;
      hist.edges.forEach((e, i) => {
        if (i % step) return;
        out.push(`<text x="${xs(e)}" y="${top + plotH + fs + 4}" text-anchor="middle" font-size="${fs * 0.92}" fill="#555">${esc(tickFmt(e, "num", Math.max(0, -Math.floor(Math.log10(hist.w) + 1e-9))))}</text>`);
      });
    }

    // 軸線
    out.push(`<line x1="${left}" y1="${top + plotH}" x2="${left + plotW}" y2="${top + plotH}" stroke="#555"/>`);
    out.push(`<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotH}" stroke="#555"/>`);
    // 軸標題
    if (st.xLabel) out.push(`<text x="${left + plotW / 2}" y="${top + plotH + bottomLab + fs * 1.2}" text-anchor="middle" font-size="${fs}">${esc(st.xLabel)}</text>`);
    if (st.yLabel) out.push(`<text transform="translate(${14 + fs * 0.6},${top + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="${fs}">${esc(st.yLabel)}</text>`);
    // 圖例
    if (showLegend && legendItems.length) {
      const sq = fs * 0.85;
      const item = (l) => (type === "scatter" || type === "line")
        ? (type === "line" ? `<line x1="${-sq * 0.4}" y1="${-sq * 0.35}" x2="${sq * 1.4}" y2="${-sq * 0.35}" stroke="${l.color}" stroke-width="${st.lineWidth}"${st.dashes && st.dashes[l.name] ? ` stroke-dasharray="${st.dashes[l.name]}"` : ""}/>` : "")
          + marker(sq / 2, -sq * 0.35, { ...st, pointShape: shapeOf(l.name), pointSize: Math.min(st.pointSize, sq / 1.6) }, l.color, "")
        : `<rect x="0" y="${-sq + 2}" width="${sq * 1.3}" height="${sq}" fill="${fillOf(l.name)}" fill-opacity="${Math.max(fo, 0.15)}" stroke="${strokeFor(l.color)}" stroke-width="${Math.max(sw, 0.8)}"/>`;
      if (st.legend === "right") {
        const x = W - legW + 10;
        legendItems.forEach((l, i) => out.push(`<g transform="translate(${x},${top + 8 + i * (fs + 8) + fs})">${item(l)}<text x="${type === "line" ? sq * 1.4 + 6 : sq * 1.3 + 6}" y="0" font-size="${fs * 0.92}">${esc(l.name)}</text></g>`));
      } else {
        const y = st.legend === "top" ? titleH + fs : H - 8;
        let total = legendItems.reduce((a, l) => a + textW(l.name, fs * 0.92) + sq + 22, 0);
        let x = Math.max(8, (W - total) / 2);
        for (const l of legendItems) {
          out.push(`<g transform="translate(${x},${y})">${item(l)}<text x="${sq * 1.4 + 6}" y="0" font-size="${fs * 0.92}">${esc(l.name)}</text></g>`);
          x += textW(l.name, fs * 0.92) + sq * 1.4 + 26;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family='${FONT}' fill="#24211d"><defs>${defs.join("")}</defs>${out.join("")}</svg>`;
  }

  function catLabel(out, x, y, c, rot, fs) {
    if (!rot) out.push(`<text x="${x}" y="${y + fs + 4}" text-anchor="middle" font-size="${fs * 0.92}">${esc(c)}</text>`);
    else out.push(`<text transform="translate(${x + fs * 0.3},${y + 8}) rotate(${-rot})" text-anchor="end" font-size="${fs * 0.92}">${esc(c)}</text>`);
  }

  function marker(x, y, st, col, title) {
    const r = Number(st.pointSize) || 4;
    const fo = st.fill ? Number(st.fillOpacity) : 0;
    const stroke = st.strokeColor || darker(col);
    const sw = Math.max(Number(st.strokeWidth) || 0, st.fill ? 0 : 1.2);
    const t = title ? `<title>${esc(title)}</title>` : "";
    const common = `fill="${col}" fill-opacity="${fo}" stroke="${sw ? stroke : "none"}" stroke-width="${sw}"`;
    if (st.pointShape === "square") return `<rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" ${common}>${t}</rect>`;
    if (st.pointShape === "triangle") return `<path d="M${x},${y - r * 1.15} L${x + r},${y + r * 0.75} L${x - r},${y + r * 0.75} Z" ${common}>${t}</path>`;
    if (st.pointShape === "diamond") return `<path d="M${x},${y - r * 1.2} L${x + r},${y} L${x},${y + r * 1.2} L${x - r},${y} Z" ${common}>${t}</path>`;
    return `<circle cx="${x}" cy="${y}" r="${r}" ${common}>${t}</circle>`;
  }

  // ---------------------------------------------------------------- 匯出
  const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  /** 在 PNG 中加入 pHYs（DPI）資訊，讓 Word／排版軟體以正確尺寸置入 */
  function setPngDpi(buf, dpi) {
    const src = new Uint8Array(buf);
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4);
    dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
    dv.setUint32(17, crc32(chunk.subarray(4, 17)));
    const out = new Uint8Array(src.length + 21);
    out.set(src.subarray(0, 33), 0); out.set(chunk, 33); out.set(src.subarray(33), 54);
    return out;
  }

  /** opts: {mode:'px'|'cm', w, h, scale, dpi}；回傳 Promise<Blob> */
  async function toPNG(spec, style, opts) {
    let lw, lh, scale, dpi;
    if (opts.mode === "cm") {
      dpi = Number(opts.dpi) || 300;
      lw = Math.round(opts.w / 2.54 * 96); lh = Math.round(opts.h / 2.54 * 96); scale = dpi / 96;
    } else {
      lw = Math.round(opts.w); lh = Math.round(opts.h); scale = Number(opts.scale) || 1; dpi = 96 * scale;
    }
    const svg = render(spec, style, { w: lw, h: lh });
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const cv = document.createElement("canvas");
    cv.width = Math.round(lw * scale); cv.height = Math.round(lh * scale);
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    const withDpi = setPngDpi(await blob.arrayBuffer(), dpi);
    return { blob: new Blob([withDpi], { type: "image/png" }), px: [cv.width, cv.height] };
  }
  function toSVG(spec, style) { return new Blob([render(spec, style)], { type: "image/svg+xml;charset=utf-8" }); }

  /** 圖中實際用到的上色鍵（給樣式面板產生顏色／圖樣選項） */
  function keysOf(spec, st) {
    let colorBy = st.colorBy || spec.defaultColorBy || (st.colorByCategory ? "category" : "series");
    if (colorBy === "group" && !spec.catGroups) colorBy = "series";
    if (["scatter", "hist", "line"].includes(spec.type)) colorBy = "series";
    const keys = [];
    if (colorBy === "series") (spec.series || []).forEach((s) => keys.push(s.name));
    else (spec.categories || []).forEach((c, i) => { const k = colorBy === "group" ? spec.catGroups[i] : String(c); if (!keys.includes(k)) keys.push(k); });
    return { keys, colorBy };
  }
  return { render, toPNG, toSVG, keysOf, DEFAULT_STYLE, PALETTE, PATTERNS, BW_PATTERNS, BW_COLORS, SHAPES, niceTicks, bins };
})();
if (typeof module !== "undefined") module.exports = Charts;
