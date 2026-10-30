// ============================================================================
// 介面
// ============================================================================
"use strict";
const APP_VERSION = "1.1.0（2026-10-30）";
const $ = (id) => document.getElementById(id);
const escH = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return e;
}
const fmtPct = (v) => (v === null || v === undefined || isNaN(v) ? "" : (v * 100).toFixed(2) + "%");
const fmtNum = (v, d = 2) => (v === null || v === undefined || v === "" || isNaN(v) ? "" : Number.isInteger(v) ? String(v) : Number(v).toFixed(d));
const today = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; };
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, "_");

// ---------------------------------------------------------------- 檔案系統
function decodeBytes(buf) {
  let t = new TextDecoder("utf-8").decode(buf);
  const bad = (t.match(/�/g) || []).length;
  if (bad > 5) { try { t = new TextDecoder("big5").decode(buf); } catch (e) { /* keep */ } }
  return t;
}
const splitPath = (p) => String(p || "").split("/").filter(Boolean);

class DirFS {
  constructor(handle) { this.h = handle; this.writable = true; this.name = handle.name; }
  async _dir(parts, create = false) { let d = this.h; for (const p of parts) d = await d.getDirectoryHandle(p, { create }); return d; }
  async list(path) {
    try { const d = await this._dir(splitPath(path)); const out = [];
      for await (const [name, hd] of d.entries()) out.push({ name, kind: hd.kind, size: hd.kind === "file" ? (await hd.getFile()).size : 0 });
      return out; } catch (e) { return null; }
  }
  async file(path) {
    try { const ps = splitPath(path); const d = await this._dir(ps.slice(0, -1)); return await (await d.getFileHandle(ps[ps.length - 1])).getFile(); }
    catch (e) { return null; }
  }
  async readText(path) { const f = await this.file(path); return f ? decodeBytes(await f.arrayBuffer()) : null; }
  async write(path, data) {
    const ps = splitPath(path); const d = await this._dir(ps.slice(0, -1), true);
    const fh = await d.getFileHandle(ps[ps.length - 1], { create: true });
    const w = await fh.createWritable(); await w.write(data); await w.close();
  }
}
class ListFS {      // <input webkitdirectory>：唯讀
  constructor(files) {
    this.writable = false; this.files = new Map();
    for (const f of files) {
      if (f.webkitRelativePath) { const ps = splitPath(f.webkitRelativePath); this.name = ps[0]; this.files.set(ps.slice(1).join("/"), f); }
      else { this.name = "選取的檔案"; this.files.set(f.name, f); }   // 平板：直接選檔
    }
  }
  async list(path) {
    const pre = splitPath(path).join("/"); const out = new Map();
    for (const [p, f] of this.files) {
      if (pre && !p.startsWith(pre + "/")) continue;
      const rest = splitPath(pre ? p.slice(pre.length + 1) : p);
      if (!rest.length) continue;
      if (rest.length === 1) out.set(rest[0], { name: rest[0], kind: "file", size: f.size });
      else if (!out.has(rest[0])) out.set(rest[0], { name: rest[0], kind: "directory", size: 0 });
    }
    return out.size || !pre ? [...out.values()] : null;
  }
  async file(path) { return this.files.get(splitPath(path).join("/")) || null; }
  async readText(path) { const f = await this.file(path); return f ? decodeBytes(await f.arrayBuffer()) : null; }
  async write() { throw new Error("唯讀"); }
}
class MemFS {       // 測試用：{路徑: 文字}
  constructor(obj, name = "mem") { this.writable = true; this.data = new Map(Object.entries(obj)); this.name = name; this.written = {}; }
  async list(path) { return ListFS.prototype.list.call({ files: new Map([...this.data].map(([p, t]) => [p, { size: t.size ?? t.length }])) }, path); }
  async file(path) { const t = this.data.get(splitPath(path).join("/")); return t === undefined ? null : t instanceof Blob ? t : new Blob([t]); }
  async readText(path) { const t = this.data.get(splitPath(path).join("/")); return t === undefined ? null : t; }
  async write(path, data) { this.written[path] = data; this.data.set(splitPath(path).join("/"), typeof data === "string" ? data : "[blob]"); }
}

// ---------------------------------------------------------------- 狀態
const S = {
  fs: null, sites: [], site: null, csvName: null, header: [], rows: [], view: [], cfg: null, groups: [], log: [],
  parsedDir: null, folderIndex: null, longCache: {}, dirty: false, tab: "fauna",
  settings: null,
};
const blankSettings = () => ({ version: 1, filterCols: [], filters: {}, mniOverride: {}, markMap: {}, wearMap: {}, sexOverride: {}, molarExclude: {}, charts: {}, ui: {} });
const sitePath = (p) => [S.site, p].filter(Boolean).join("/");
const resultsPath = (p) => sitePath("分析結果/" + p);
const ui = (tab) => (S.settings.ui[tab] ||= {});

function markDirty() { S.dirty = true; $("saveBtn").classList.add("dirty"); $("sideSave").classList.add("dirty"); $("saveStatus").textContent = "設定已變更，尚未儲存"; }
// 資料篩選欄可收合（記在這台裝置）
const setSide = (collapsed) => { document.querySelector(".layout").classList.toggle("collapsed", collapsed); try { localStorage.setItem("za:sideCollapsed", collapsed ? "1" : ""); } catch (e) { /* 忽略 */ } };
$("sideClose").onclick = () => setSide(true);
$("sideOpen").onclick = () => setSide(false);
$("sideSave").onclick = () => $("saveBtn").click();
try { if (localStorage.getItem("za:sideCollapsed")) setSide(true); } catch (e) { /* 忽略 */ }
window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });

// ---------------------------------------------------------------- 瀏覽器內保存（唯讀／平板模式）
const LS = {
  key: () => `za:${S.fs ? S.fs.name : ""}/${S.site}/${S.csvName}${S.sheet ? "#" + S.sheet : ""}`,
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};
async function saveFile(rel, data, filename) {
  // rel：相對於遺址「分析結果」資料夾
  if (S.fs && S.fs.writable) {
    try { await S.fs.write(resultsPath(rel), data); return `已存到 ${S.site ? S.site + "/" : ""}分析結果/${rel}`; }
    catch (e) { console.warn(e); }
  }
  const blob = data instanceof Blob ? data : new Blob([data], { type: "text/plain;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: filename || rel.split("/").pop() });
  document.body.append(a); a.click(); a.remove();
  return `已下載 ${filename || rel.split("/").pop()}`;
}
function toast(msg) {
  const t = h("div", { style: { position: "fixed", right: "18px", bottom: "18px", background: "#2f6b5e", color: "#fff", padding: "8px 14px", borderRadius: "8px", zIndex: 99, boxShadow: "0 4px 14px rgba(0,0,0,.2)", fontSize: "13.5px" } }, msg);
  document.body.append(t); setTimeout(() => t.remove(), 3200);
}

// ---------------------------------------------------------------- 載入
$("pickDir").onclick = async () => {
  if (!window.showDirectoryPicker) { $("pickFallback").click(); return; }
  try { const hd = await window.showDirectoryPicker({ mode: "readwrite" }); await openRoot(new DirFS(hd)); }
  catch (e) { if (e.name !== "AbortError") alert("無法開啟資料夾：" + e.message); }
};
$("pickFallback").onchange = async (e) => { if (e.target.files.length) await openRoot(new ListFS(e.target.files)); };
$("pickFiles").onchange = async (e) => { if (e.target.files.length) await openRoot(new ListFS(e.target.files)); };
// 平板或不支援資料夾存取的瀏覽器：提示改用選檔
if (!window.showDirectoryPicker) $("pickHint").style.display = "";
// 以網站方式開啟時註冊離線快取（直接開 html 檔時略過）
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register("sw.js").catch(() => {});

const DATA_EXT = /\.(csv|xlsx)$/i;
async function openRoot(fs) {
  S.fs = fs;
  const top = (await fs.list("")) || [];
  const sites = [];
  if (top.some((x) => x.kind === "file" && DATA_EXT.test(x.name))) sites.push({ path: "", label: `（${fs.name} 本身）` });
  for (const d of top.filter((x) => x.kind === "directory" && !["程式", "分析結果"].includes(x.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const ls = (await fs.list(d.name)) || [];
    if (ls.some((x) => x.kind === "file" && DATA_EXT.test(x.name))) sites.push({ path: d.name, label: d.name });
  }
  S.sites = sites;
  $("rootStatus").innerHTML = `已選擇 <b>${escH(fs.name)}</b>${fs.writable ? "" : "（唯讀：設定存在這台裝置的瀏覽器中，圖檔與表格改為下載）"}；找到 ${sites.length} 個含清單（csv／xlsx）的遺址資料夾`;
  $("siteSel").innerHTML = sites.map((s, i) => `<option value="${i}">${escH(s.label)}</option>`).join("");
  $("siteRow").style.display = sites.length ? "flex" : "none";
  if (sites.length) await refreshCsvList();
}
$("siteSel").onchange = refreshCsvList;
async function refreshCsvList() {
  const s = S.sites[$("siteSel").value];
  const ls = ((await S.fs.list(s.path)) || []).filter((x) => x.kind === "file" && DATA_EXT.test(x.name) && !x.name.startsWith("~$")).sort((a, b) => b.size - a.size);
  $("csvSel").innerHTML = ls.map((x) => `<option>${escH(x.name)}</option>`).join("");
  await refreshSheets();
}
$("csvSel").onchange = refreshSheets;
S.wbCache = {};
async function workbook(path) {
  if (S.wbCache[path]) return S.wbCache[path];
  const f = await S.fs.file(path);
  return (S.wbCache[path] = await Xlsx.readXlsx(await f.arrayBuffer()));
}
async function refreshSheets() {
  const s = S.sites[$("siteSel").value], name = $("csvSel").value;
  if (!/\.xlsx$/i.test(name || "")) { $("sheetCtl").style.display = "none"; return; }
  $("sheetCtl").style.display = "";
  $("sheetSel").innerHTML = "<option>讀取中…</option>";
  try {
    const wb = await workbook([s.path, name].filter(Boolean).join("/"));
    // 預設：偵測到最多標準欄位的工作表
    let best = wb.sheetNames[0], bestN = -1;
    for (const n of wb.sheetNames) {
      const hdr = Core.fromMatrix((await wb.readSheet(n)).slice(0, 5)).header;
      const d = Core.detectFields(hdr); const k = Object.values(d).filter(Boolean).length + (d.物種 && d.骨骼 ? 10 : 0);
      if (k > bestN) { bestN = k; best = n; }
    }
    $("sheetSel").innerHTML = wb.sheetNames.map((n) => `<option ${n === best ? "selected" : ""}>${escH(n)}</option>`).join("");
  } catch (e) { $("sheetSel").innerHTML = ""; alert("無法讀取 xlsx：" + e.message); }
}
$("loadBtn").onclick = async () => {
  if (S.dirty && !confirm("目前的設定尚未儲存，確定要重新載入？")) return;
  await loadSite(S.sites[$("siteSel").value].path, $("csvSel").value, $("sheetCtl").style.display === "none" ? null : $("sheetSel").value);
};

async function readTable(site, name, sheet) {
  const path = [site, name].filter(Boolean).join("/");
  if (/\.xlsx$/i.test(name)) {
    const wb = await workbook(path);
    return Core.fromMatrix(await wb.readSheet(sheet || wb.sheetNames[0]));
  }
  return Core.parseCSV(await S.fs.readText(path));
}

// ---------------------------------------------------------------- 欄位對照對話框
function fieldDialog(header, rows, map) {
  return new Promise((resolve) => {
    const dlg = $("fieldDlg"), body = $("fieldBody");
    const cur = { ...map };
    const sample = (col) => {
      if (!col) return "";
      const vals = []; for (const r of rows) { const v = r[col]; if (v && !vals.includes(v)) vals.push(v); if (vals.length >= 5) break; }
      return vals.join("、");
    };
    const trs = Core.FIELDS.map((f) => {
      const smp = h("span", { class: "muted small" }, sample(cur[f.k]));
      const sel = h("select", { onchange: (e) => { cur[f.k] = e.target.value; smp.textContent = sample(cur[f.k]); } },
        [h("option", { value: "" }, "（沒有）"), ...header.map((c) => h("option", { value: c, selected: cur[f.k] === c }, c))]);
      return h("tr", {}, h("td", {}, h("b", {}, f.k), f.req ? h("span", { style: { color: "var(--bad)" } }, " *") : ""), h("td", {}, sel), h("td", { class: "wrap" }, smp));
    });
    body.innerHTML = "";
    body.append(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "標準欄位"), h("th", {}, "清單中的欄位"), h("th", {}, "內容範例"))), h("tbody", {}, trs)));
    $("fieldMsg").textContent = "";
    $("fieldOk").onclick = () => {
      const miss = Core.FIELDS.filter((f) => f.req && !cur[f.k]).map((f) => f.k);
      if (miss.length) { $("fieldMsg").textContent = "必要欄位未指定：" + miss.join("、"); return; }
      dlg.close(); resolve(cur);
    };
    $("fieldCancel").onclick = () => { dlg.close(); resolve(null); };
    dlg.showModal();
  });
}

// ---------------------------------------------------------------- 認不得的名稱
function unknownNames() {
  const bones = new Map(), sides = new Map();
  for (const r of S.rows) {
    const b = String(r.骨骼 ?? "").replace(/\s+/g, " ").trim();
    if (b && !Core.isKnownElement(S.cfg, b)) {
      const e = bones.get(b) || { n: 0, sp: new Map() }; e.n++; e.sp.set(r.物種, (e.sp.get(r.物種) || 0) + 1); bones.set(b, e);
    }
    const sv = String(r.側 ?? "").trim();
    if (sv && !["L", "R", "Ax", "-", "UN"].includes(Core.normalizeSide(sv, S.cfg))) sides.set(sv, (sides.get(sv) || 0) + 1);
  }
  return { bones: [...bones].sort((a, b) => b[1].n - a[1].n), sides: [...sides].sort((a, b) => b[1] - a[1]) };
}
function unknownDialog() {
  return new Promise((resolve) => {
    const unk = unknownNames();
    if (!unk.bones.length && !unk.sides.length) { resolve(false); return; }
    const dlg = $("unkDlg"), body = $("unkBody");
    const regions = Core.REGION_ORDER;
    const byRegion = Core.groupBy(S.cfg.elements, (e) => e.骨骼區域);
    const boneSel = (raw) => h("select", { "data-raw": raw },
      h("optgroup", { label: "新增為獨立部位" }, regions.map((rg) => h("option", { value: "new:" + rg, selected: rg === "其他" }, `新增：${rg}${rg === "其他" ? "（只計數）" : ""}`))),
      ...regions.filter((rg) => byRegion.has(rg)).map((rg) => h("optgroup", { label: `歸入既有部位（${rg}）` },
        byRegion.get(rg).map((e) => h("option", { value: "to:" + e.標準名稱 }, `歸入 ${e.標準名稱}`)))));
    const sideSel = (raw) => h("select", { "data-side": raw }, [["UN", "UN（不明）"], ["L", "L"], ["R", "R"], ["Ax", "Ax（中軸）"], ["-", "-（未記錄）"]].map(([v, l]) => h("option", { value: v }, l)));
    body.innerHTML = "";
    if (unk.bones.length) body.append(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "骨骼寫法"), h("th", { class: "num" }, "筆數"), h("th", {}, "常見物種"), h("th", {}, "處理方式"))),
      h("tbody", {}, unk.bones.map(([raw, e]) => h("tr", {}, h("td", {}, raw), h("td", { class: "num" }, String(e.n)),
        h("td", { class: "small" }, [...e.sp].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}(${n})`).join("、")), h("td", {}, boneSel(raw)))))));
    if (unk.sides.length) body.append(h("table", { style: { marginTop: "10px" } }, h("thead", {}, h("tr", {}, h("th", {}, "側別寫法"), h("th", { class: "num" }, "筆數"), h("th", {}, "歸入"))),
      h("tbody", {}, unk.sides.map(([raw, n]) => h("tr", {}, h("td", {}, raw), h("td", { class: "num" }, String(n)), h("td", {}, sideSel(raw)))))));
    $("unkLater").onclick = () => { dlg.close(); resolve(false); };
    $("unkOk").onclick = async () => {
      const els = S.cfg.elements.map((e) => ({ 標準名稱: e.標準名稱, 別名: e.別名 || "", 骨骼區域: e.骨骼區域, 部位順序: e.部位順序, 側別MNI: e.側別MNI }));
      for (const sel of body.querySelectorAll("select[data-raw]")) {
        const raw = sel.dataset.raw, v = sel.value;
        if (v.startsWith("to:")) { const e = els.find((x) => x.標準名稱 === v.slice(3)); e.別名 = [e.別名, raw].filter(Boolean).join(";"); }
        else {
          const rg = v.slice(4);
          const ord = Math.max(0, ...els.filter((x) => x.骨骼區域 === rg).map((x) => Number(x.部位順序) || 0)) + 1;
          els.push({ 標準名稱: raw, 別名: "", 骨骼區域: rg, 部位順序: ord, 側別MNI: "N" });
        }
      }
      S.elementsCSV = Core.toCSV(["標準名稱", "別名", "骨骼區域", "部位順序", "側別MNI"], els).replace(/^﻿/, "");
      const sideRows = Object.entries(S.sideExtra || {}).map(([k, v]) => ({ 原始寫法: k, 歸入: v }));
      for (const sel of body.querySelectorAll("select[data-side]")) sideRows.push({ 原始寫法: sel.dataset.side, 歸入: sel.value });
      S.sideExtra = Object.fromEntries(sideRows.map((x) => [x.原始寫法, x.歸入]));
      S.sidesCSV = Core.toCSV(["原始寫法", "歸入"], sideRows).replace(/^﻿/, "");
      S.cfg = Core.makeConfig(S.elementsCSV, S.aliasesCSV, S.sidesCSV);
      const msgs = [];
      LS.set("za:config:elements", S.elementsCSV); LS.set("za:config:sides", S.sidesCSV);
      if (!(S.fs.writable && S.site !== "")) { toast("對照已存在這台裝置的瀏覽器中"); dlg.close(); resolve(true); return; }
      for (const [path, text] of [["程式/設定/骨骼分類.csv", S.elementsCSV], ["程式/設定/側別對照.csv", S.sidesCSV]]) {
        if (S.fs.writable && S.site !== "") { try { await S.fs.write(path, text); msgs.push("已寫入 " + path); continue; } catch (e) { console.warn(e); } }
        const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: path.split("/").pop() }); document.body.append(a); a.click(); a.remove();
        msgs.push("已下載 " + path.split("/").pop() + "（請放到 程式/設定/）");
      }
      toast(msgs.join("；"));
      dlg.close(); resolve(true);
    };
    dlg.showModal();
  });
}

async function loadSite(site, csvName, sheet = null) {
  const fs = S.fs;
  S.site = site; S.csvName = csvName; S.sheet = sheet; S.longCache = {}; S.dirty = false;
  $("loadStatus").textContent = "讀取中…";
  const parsed = await readTable(site, csvName, sheet);
  S.header = parsed.header; S.rows = parsed.rows;
  // 欄位對照
  const fmText = await fs.readText(resultsPath("欄位對照.csv"));
  let saved = {}; if (fmText) for (const x of Core.parseCSV(fmText).rows) saved[x.標準欄位] = x.原始欄位;
  else if (!fs.writable) { const ls0 = LS.get(LS.key()); if (ls0 && ls0.fieldMap) saved = ls0.fieldMap; }
  let fmap = Core.detectFields(S.header, saved);
  const missing = Core.FIELDS.filter((f) => f.req && !fmap[f.k]);
  if (missing.length || S.forceFieldDlg) {
    S.forceFieldDlg = false;
    const m = await fieldDialog(S.header, S.rows, fmap);
    if (!m) { $("loadStatus").textContent = "已取消載入"; return; }
    fmap = m;
    const txt = Core.toCSV(["標準欄位", "原始欄位"], Object.entries(fmap).map(([k, v]) => ({ 標準欄位: k, 原始欄位: v })));
    try { await saveFile("欄位對照.csv", txt, "欄位對照.csv"); } catch (e) { console.warn(e); }
  }
  S.fieldMap = fmap;
  Core.applyFields(S.rows, fmap);
  if (!fmap.數量) for (const r of S.rows) r.數量 = "1";
  // 設定檔
  S.elementsCSV = (site !== "" ? await fs.readText("程式/設定/骨骼分類.csv") : null) || LS.get("za:config:elements");
  S.aliasesCSV = (site !== "" ? await fs.readText("程式/設定/物種別名.csv") : null) || LS.get("za:config:aliases");
  S.sidesCSV = (site !== "" ? await fs.readText("程式/設定/側別對照.csv") : null) || LS.get("za:config:sides");
  S.sideExtra = {}; if (S.sidesCSV) for (const x of Core.parseCSV(S.sidesCSV).rows) S.sideExtra[x.原始寫法] = x.歸入;
  S.cfg = Core.makeConfig(S.elementsCSV, S.aliasesCSV, S.sidesCSV);
  const lsSaved = !fs.writable ? LS.get(LS.key()) : null;
  const smText = (await fs.readText(resultsPath("物種對照表.csv"))) || (lsSaved && lsSaved.groupsCSV) || null;
  const r = Core.defaultSpeciesGroups(S.rows, smText ? Core.groupsFromCSV(smText) : null);
  S.groups = r.groups;
  S.settings = blankSettings();
  const js = await fs.readText(resultsPath("網頁工具設定.json"));
  if (js) { try { Object.assign(S.settings, JSON.parse(js)); } catch (e) { console.warn(e); } }
  else if (lsSaved && lsSaved.settings) Object.assign(S.settings, lsSaved.settings);
  const mniCSV = await fs.readText(resultsPath("MNI部位設定.csv"));
  if (mniCSV) {
    S.settings.mniOverride = {};
    for (const x of Core.parseCSV(mniCSV).rows) (S.settings.mniOverride[x.物種] ||= {})[x.骨骼部位] = String(x.納入).toUpperCase() === "Y";
  }
  const mkCSV = await fs.readText(resultsPath("表面痕歸類.csv"));
  if (mkCSV) {
    S.settings.markMap = {};
    for (const x of Core.parseCSV(mkCSV).rows) (S.settings.markMap[x.項目] ||= {})[x.原始寫法] = x.歸入;
  }
  const wmCSV = await fs.readText(resultsPath("磨耗對照.csv"));
  if (wmCSV) { S.settings.wearMap = {}; for (const x of Core.parseCSV(wmCSV).rows) S.settings.wearMap[x.原始寫法] = x.Lemoine分數; }
  S.settings.filterCols = (S.settings.filterCols || []).filter((c) => S.header.includes(c));
  if (!S.settings.filterCols.length && fmap.文化層) S.settings.filterCols = [fmap.文化層];
  // 測量值解析工具輸出
  const ls = (await fs.list(site)) || [];
  const pd = ls.filter((x) => x.kind === "directory" && /測量長表/.test(x.name)).map((x) => x.name).sort();
  S.parsedDir = pd.length ? pd[pd.length - 1] : null;
  S.folderIndex = null;
  if (S.parsedDir) {
    const idx = await fs.readText(sitePath(S.parsedDir + "/物種資料夾一覽.csv"));
    if (idx) S.folderIndex = Core.parseCSV(idx).rows;
  }
  // 認不得的骨骼／側別：立即處理
  if (!S.skipUnknownDlg) await unknownDialog();
  reprepare();
  const msgs = [`<b>${S.rows.length.toLocaleString()}</b> 筆紀錄${sheet ? `（工作表：${escH(sheet)}）` : ""}`];
  const mapped = Object.entries(fmap).filter(([k, v]) => v && v !== k).map(([k, v]) => `${escH(v)}→${k}`);
  if (mapped.length) msgs.push("欄位：" + mapped.join("、"));
  msgs.push(smText ? "已讀入物種對照表" : "物種對照表：自動產生（大小寫合併）");
  if (r.added.length && smText) msgs.push(`新物種名稱 ${r.added.length} 個已補入`);
  const loose = ls.filter((x) => x.kind === "file" && /_長表_(mandible|tooth|maxilla)\.csv$/i.test(x.name)).length;
  msgs.push(S.parsedDir ? `長表：${escH(S.parsedDir)}` : loose ? `長表：直接選取的 ${loose} 個檔案` : "無測量值解析輸出（年齡、臼齒只用原表齒位欄）");
  $("loadStatus").innerHTML = msgs.join("　·　");
  renderLoadTools();
  $("app").style.display = "block";
  $("saveBtn").classList.remove("dirty"); $("sideSave").classList.remove("dirty"); $("saveStatus").textContent = S.fs.writable ? "" : "唯讀模式：設定會存在這台裝置的瀏覽器中（可另外下載備份）";
  buildFilters(); buildTabs(); renderTab();
}
function renderLoadTools() {
  const unk = unknownNames();
  const box = $("loadTools"); box.innerHTML = ""; box.style.display = "flex";
  box.append(
    h("button", { class: "mini", onclick: async () => {
      const m = await fieldDialog(S.header, S.rows, S.fieldMap); if (!m) return;
      await saveFile("欄位對照.csv", Core.toCSV(["標準欄位", "原始欄位"], Object.entries(m).map(([k, v]) => ({ 標準欄位: k, 原始欄位: v }))), "欄位對照.csv");
      S.skipUnknownDlg = false; await loadSite(S.site, S.csvName, S.sheet);
    } }, "欄位對照…"),
    h("button", { class: "mini", disabled: !unk.bones.length && !unk.sides.length, onclick: async () => { if (await unknownDialog()) { reprepare(); renderLoadTools(); renderTab(); } } },
      unk.bones.length || unk.sides.length ? `處理認不得的名稱（骨骼 ${unk.bones.length}、側別 ${unk.sides.length}）` : "骨骼與側別名稱皆已對照"));
}

function reprepare() { S.log = Core.prepare(S.rows, S.cfg, S.groups); applyFilters(); }

// ---------------------------------------------------------------- 篩選
function applyFilters() {
  const f = S.settings.filters;
  S.view = S.rows.filter((r) => S.settings.filterCols.every((c) => !(f[c] || []).includes(r[c] ?? "")));
  const st = $("filterStatus");
  if (st) st.innerHTML = S.view.length === S.rows.length ? `使用全部 <b>${S.rows.length}</b> 筆` : `使用 <b>${S.view.length}</b> / ${S.rows.length} 筆`;
  const nf = S.settings.filterCols.filter((c) => (f[c] || []).length).length;
  $("sideInfo").innerHTML = "篩<br>選" + (nf ? `<br><b title="${nf} 個篩選條件">${nf}</b>` : "");
  $("sideOpen").title = S.view.length === S.rows.length ? "展開資料篩選" : `展開資料篩選（目前使用 ${S.view.length}／${S.rows.length} 筆）`;
}
function buildFilters() {
  const box = $("filters"); box.innerHTML = "";
  for (const col of S.settings.filterCols) {
    const counts = new Map();
    for (const r of S.rows) { const v = r[col] ?? ""; counts.set(v, (counts.get(v) || 0) + 1); }
    const excl = new Set(S.settings.filters[col] || []);
    const vals = [...counts].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh-Hant"));
    const list = h("div", { class: "vals" }, vals.map(([v, n]) => h("label", {},
      h("input", { type: "checkbox", checked: !excl.has(v), onchange: (e) => {
        const s = new Set(S.settings.filters[col] || []); e.target.checked ? s.delete(v) : s.add(v);
        S.settings.filters[col] = [...s]; markDirty(); applyFilters(); renderTab();
      } }), h("span", {}, v === "" ? "（空白）" : v), h("span", { class: "cnt" }, n))));
    const setAll = (on) => { S.settings.filters[col] = on ? [] : vals.map((x) => x[0]); markDirty(); applyFilters(); buildFilters(); renderTab(); };
    box.append(h("div", { class: "filter" },
      h("div", { class: "fhead" }, h("b", {}, col), h("span", {},
        h("button", { class: "mini", onclick: () => setAll(true) }, "全選"), " ",
        h("button", { class: "mini", onclick: () => setAll(false) }, "全不選"), " ",
        h("button", { class: "mini", title: "移除此篩選", onclick: () => { S.settings.filterCols = S.settings.filterCols.filter((c) => c !== col); delete S.settings.filters[col]; markDirty(); applyFilters(); buildFilters(); renderTab(); } }, "×"))),
      list));
  }
  const sel = $("addFilterSel");
  const skip = new Set(["流水號", "原代號", "備註", "數量", "GL", "WA", "WP", "WM", "1", "2", "3", "4", "5", "6", "7", "8"]);
  sel.innerHTML = `<option value="">＋ 新增篩選欄位…</option>` + S.header.filter((c) => !S.settings.filterCols.includes(c) && !skip.has(c) && !/\.\d+$/.test(c))
    .map((c) => `<option>${escH(c)}</option>`).join("");
  sel.onchange = () => { if (sel.value) { S.settings.filterCols.push(sel.value); markDirty(); buildFilters(); } };
  applyFilters();
}

// ---------------------------------------------------------------- 儲存設定
$("saveBtn").onclick = async () => {
  const out = [];
  out.push(["物種對照表.csv", Core.groupsToCSV(S.groups)]);
  const mrows = [];
  for (const [sp, m] of Object.entries(S.settings.mniOverride)) for (const [el, v] of Object.entries(m)) mrows.push({ 物種: sp, 骨骼部位: el, 納入: v ? "Y" : "N" });
  out.push(["MNI部位設定.csv", Core.toCSV(["物種", "骨骼部位", "納入"], mrows)]);
  const krows = [];
  for (const [it, m] of Object.entries(S.settings.markMap)) for (const [raw, cat] of Object.entries(m)) krows.push({ 項目: it, 原始寫法: raw, 歸入: cat });
  out.push(["表面痕歸類.csv", Core.toCSV(["項目", "原始寫法", "歸入"], krows)]);
  const wrows = Object.entries(S.settings.wearMap || {}).map(([raw, sc]) => ({ 原始寫法: raw, Lemoine分數: sc }));
  out.push(["磨耗對照.csv", Core.toCSV(["原始寫法", "Lemoine分數"], wrows)]);
  out.push(["網頁工具設定.json", JSON.stringify(S.settings, null, 1)]);
  const msgs = [];
  if (!S.fs.writable) {
    // 平板／唯讀：設定存在這台裝置的瀏覽器裡，下次選同一個檔案會自動套用；同時提供下載備份
    const ok = LS.set(LS.key(), { settings: S.settings, groupsCSV: Core.groupsToCSV(S.groups), fieldMap: S.fieldMap, savedAt: Date.now() });
    S.dirty = false; $("saveBtn").classList.remove("dirty"); $("sideSave").classList.remove("dirty");
    $("saveStatus").innerHTML = ok ? `已存在這台裝置的瀏覽器中（${new Date().toLocaleTimeString()}）。` : "瀏覽器不允許儲存（可能是私密瀏覽）。";
    $("saveStatus").append(h("button", { class: "mini", style: { marginTop: "4px" }, onclick: async () => { for (const [name, text] of out) await saveFile(name, text, name); } }, "下載設定檔備份"));
    return;
  }
  for (const [name, text] of out) msgs.push(await saveFile(name, text, name));
  S.dirty = false; $("saveBtn").classList.remove("dirty"); $("sideSave").classList.remove("dirty");
  $("saveStatus").textContent = S.fs.writable ? `已儲存（${new Date().toLocaleTimeString()}）：物種對照表、MNI部位設定、表面痕歸類、磨耗對照、網頁工具設定` : "已下載 5 個設定檔，請放到遺址的「分析結果」資料夾";
};

// ---------------------------------------------------------------- 表格
const WRAP_COLS = new Set(["備註", "檢查", "側別依據", "區位依據", "zones", "內容", "測量"]);
/** cols: [{k,label,f:'int'|'pct'|'num'|fn, num:bool, render:(row)=>Node}] */
function makeTable(cols, rows, opts = {}) {
  const thead = h("thead", {}, h("tr", {}, cols.map((c) => h("th", { class: c.num || ["int", "pct", "num"].includes(c.f) ? "num" : "" }, c.label ?? c.k))));
  const cell = (c, r) => {
    if (c.render) return c.render(r);
    const v = r[c.k];
    if (typeof c.f === "function") return c.f(v, r);
    if (c.f === "pct") return fmtPct(v);
    if (c.f === "int") return v === null || v === undefined || v === "" ? "" : String(Math.round(v));
    if (c.f === "num") return fmtNum(v);
    return v ?? "";
  };
  const tr = (r, cls) => {
    const row = h("tr", { class: [cls, opts.rowClass ? opts.rowClass(r) : "", opts.onClick ? "click" : ""].filter(Boolean).join(" "),
      onclick: opts.onClick ? (e) => { if (!["INPUT", "SELECT", "BUTTON"].includes(e.target.tagName)) opts.onClick(r); } : null },
    cols.map((c) => { const v = cell(c, r); return h("td", { class: [c.num || ["int", "pct", "num"].includes(c.f) ? "num" : "", WRAP_COLS.has(c.k) ? "wrap" : "", c.cls ? c.cls(r) : ""].join(" ") }, v); }));
    return row;
  };
  const tbody = h("tbody", {}, rows.map((r) => tr(r)), opts.total ? tr(opts.total, "total") : null);
  const tbl = h("table", {}, thead, tbody);
  const textOf = () => {
    const lines = [cols.map((c) => c.label ?? c.k).join("\t")];
    for (const r of rows.concat(opts.total ? [opts.total] : [])) lines.push(cols.map((c) => {
      if (c.text) return c.text(r);
      const v = cell(c, r); return v instanceof Node ? v.textContent : String(v).replace(/\t|\n/g, " ");
    }).join("\t"));
    return lines;
  };
  const bar = h("div", { class: "tbar" },
    opts.title ? h("b", { style: { marginRight: "auto" } }, opts.title) : null,
    h("button", { class: "mini", onclick: async () => { await navigator.clipboard.writeText(textOf().join("\n")); toast("已複製，可直接貼到試算表"); } }, "複製表格"),
    h("button", { class: "mini", onclick: async () => {
      const lines = textOf().map((l) => l.split("\t"));
      const csv = Core.toCSV(lines[0], lines.slice(1));
      const name = `${safeName(opts.name || "表格")}.csv`;
      toast(await saveFile("表格/" + name, csv, name));
    } }, "匯出 CSV"));
  return h("div", {}, bar, h("div", { class: "tablewrap", style: opts.maxHeight ? { maxHeight: opts.maxHeight } : null }, tbl));
}

// ---------------------------------------------------------------- 圖表卡片
const TYPE_LABEL = { bar: "長條圖", hbar: "橫條圖", line: "折線圖", scatter: "散點圖", hist: "直方圖" };
/**
 * key：設定中保存樣式的名稱；specFn(type, style) 回傳 spec；opts.types 可用圖型；opts.defaults 預設樣式
 */
function chartCard(key, specFn, opts = {}) {
  const types = opts.types || ["bar", "hbar"];
  const saved = S.settings.charts[key];
  const st = S.settings.charts[key] = Object.assign({}, Charts.DEFAULT_STYLE, { type: types[0] }, opts.defaults || {}, saved || {});
  for (const k of ["colors", "patterns", "shapes", "dashes"]) st[k] = { ...(st[k] || {}) };
  if (!types.includes(st.type)) st.type = types[0];
  const box = h("div", { class: "chartbox" });
  const panel = h("div", { class: "stylepanel" });
  let spec = null, lastNames = "";
  const draw = () => {
    spec = specFn(st.type, st);
    box.innerHTML = Charts.render(spec, st);
    const names = seriesNames().join("\u0001");
    if (names !== lastNames) { lastNames = names; buildColors(); }
  };
  const seriesNames = () => Charts.keysOf(spec, st).keys;
  const colorsBox = h("div", { class: "colors3" });
  const PAT_OPTS = Charts.PATTERNS, SHAPE_OPTS = [["", "（同上方設定）"], ["circle", "● 圓"], ["square", "■ 方"], ["triangle", "▲ 三角"], ["diamond", "◆ 菱形"]];
  const DASH_OPTS = [["", "實線"], ["6 4", "虛線"], ["2 3", "點線"], ["10 4 2 4", "點虛線"]];
  const buildColors = () => {
    colorsBox.innerHTML = "";
    const t = st.type;
    seriesNames().forEach((n, i) => {
      const cur = st.colors[n] || Charts.PALETTE[i % Charts.PALETTE.length];
      const ctl = [];
      if (t === "scatter" || t === "line") ctl.push(h("select", { title: "點形狀", onchange: (e) => { if (e.target.value) st.shapes[n] = e.target.value; else delete st.shapes[n]; markDirty(); draw(); } },
        SHAPE_OPTS.map(([v, l]) => h("option", { value: v, selected: (st.shapes[n] || "") === v }, l))));
      if (t === "line") ctl.push(h("select", { title: "線條樣式", onchange: (e) => { if (e.target.value) st.dashes[n] = e.target.value; else delete st.dashes[n]; markDirty(); draw(); } },
        DASH_OPTS.map(([v, l]) => h("option", { value: v, selected: (st.dashes[n] || "") === v }, l))));
      if (t !== "scatter") ctl.push(h("select", { title: "填滿圖樣（黑白印刷用）", onchange: (e) => { if (e.target.value) st.patterns[n] = e.target.value; else delete st.patterns[n]; markDirty(); draw(); } },
        PAT_OPTS.map(([v, l]) => h("option", { value: v, selected: (st.patterns[n] || "") === v }, l))));
      colorsBox.append(h("div", { class: "crow" },
        h("input", { type: "color", value: cur, oninput: (e) => { st.colors[n] = e.target.value; markDirty(); draw(); } }),
        h("span", { class: "small cname", title: n }, n), h("div", { class: "cctl" }, ctl)));
    });
  };
  const bwStyle = () => {
    const keys = seriesNames(), t = st.type;
    keys.forEach((n, i) => {
      if (t === "scatter" || t === "line") {
        st.colors[n] = ["#111111", "#555555", "#888888", "#333333"][i % 4];
        st.shapes[n] = Charts.SHAPES[i % Charts.SHAPES.length];
        if (t === "line") { const d = ["", "6 4", "2 3", "10 4 2 4"][i % 4]; if (d) st.dashes[n] = d; else delete st.dashes[n]; }
      } else {
        st.colors[n] = Charts.BW_COLORS[i % Charts.BW_COLORS.length];
        const p = Charts.BW_PATTERNS[i % Charts.BW_PATTERNS.length]; if (p) st.patterns[n] = p; else delete st.patterns[n];
      }
    });
    if (t === "scatter") { st.fill = false; }
    else { st.fill = true; st.fillOpacity = 1; if (!Number(st.strokeWidth)) st.strokeWidth = 1; }
    st.strokeColor = "#111111"; st.showGrid = false;
    markDirty(); buildPanel(); draw();
  };
  const field = (label, input, show = true) => (show ? h("div", { class: "f" }, h("span", {}, label), input) : null);
  const txt = (k) => h("input", { type: "text", value: st[k] ?? "", placeholder: (spec && spec[k]) || "", oninput: (e) => { st[k] = e.target.value; markDirty(); draw(); } });
  const numIn = (k, step = 1, w = 70) => h("input", { type: "number", step, value: st[k] ?? "", style: { width: w + "px" }, oninput: (e) => { st[k] = e.target.value === "" ? "" : e.target.value; markDirty(); draw(); } });
  const chk = (k, label) => h("label", { class: "small" }, h("input", { type: "checkbox", checked: !!st[k], onchange: (e) => { st[k] = e.target.checked; markDirty(); draw(); } }), " " + label);
  const range = (k, min, max, step) => {
    const out = h("span", { class: "small" }, String(st[k]));
    return h("span", { class: "row", style: { flexWrap: "nowrap" } }, h("input", { type: "range", min, max, step, value: st[k], oninput: (e) => { st[k] = Number(e.target.value); out.textContent = e.target.value; markDirty(); draw(); } }), out);
  };
  const sel = (k, options) => h("select", { onchange: (e) => { st[k] = e.target.value; markDirty(); buildPanel(); draw(); } },
    options.map(([v, l]) => h("option", { value: v, selected: String(st[k]) === String(v) }, l)));
  const buildPanel = () => {
    const t = st.type;
    const isBar = t === "bar" || t === "hbar";
    panel.innerHTML = "";
    const parts = [
      field("圖型", sel("type", types.map((x) => [x, TYPE_LABEL[x]]))),
      opts.extra ? opts.extra(st, () => { markDirty(); draw(); }) : null,
      h("div", { class: "sec" },
        field("標題", txt("title")), field("X 軸標題", txt("xLabel")), field("Y 軸標題", txt("yLabel")),
        field("寬 × 高", h("span", {}, numIn("width", 10, 64), " × ", numIn("height", 10, 64))),
        field("字級", numIn("fontSize", 1, 56))),
      h("div", { class: "sec" }, h("div", { class: "small", style: { marginBottom: "4px" } }, t === "scatter" ? "顏色與點形狀" : "顏色與填滿圖樣"),
        isBar ? field("上色依據", sel("colorBy", [["", "預設"], ["series", "系列"], ...(spec && spec.catGroups ? [["group", "第一級分組"]] : []), ["category", "每個類別"]])) : null,
        colorsBox,
        h("div", { class: "row", style: { marginTop: "6px" } },
          h("button", { class: "mini", onclick: bwStyle, title: "黑／灰色＋不同圖樣（點形狀、線條），適合黑白印刷" }, "黑白印刷樣式"),
          h("button", { class: "mini", onclick: () => { st.colors = {}; st.patterns = {}; st.shapes = {}; st.dashes = {}; markDirty(); buildPanel(); draw(); } }, "恢復預設配色")),
        t !== "scatter" ? field("圖樣大小", numIn("patternSize", 1, 56)) : null,
        t !== "scatter" ? field("圖樣線寬", numIn("patternWidth", 0.2, 56)) : null,
        t !== "scatter" ? field("圖樣底色", h("span", { class: "row", style: { flexWrap: "nowrap" } },
          h("input", { type: "color", value: st.patternBg && st.patternBg !== "none" ? st.patternBg : "#ffffff", oninput: (e) => { st.patternBg = e.target.value; markDirty(); draw(); } }),
          h("button", { class: "mini", onclick: () => { st.patternBg = "none"; markDirty(); draw(); } }, "透明"))) : null),
      h("div", { class: "sec" },
        h("div", {}, chk("fill", t === "line" ? "線下填色" : "填滿")),
        field("透明度", range("fillOpacity", 0, 1, 0.05)),
        field("外框顏色", h("span", { class: "row", style: { flexWrap: "nowrap" } },
          h("input", { type: "color", value: st.strokeColor || "#333333", oninput: (e) => { st.strokeColor = e.target.value; markDirty(); draw(); } }),
          h("button", { class: "mini", onclick: () => { st.strokeColor = ""; markDirty(); draw(); } }, "自動"))),
        field("外框粗細", numIn("strokeWidth", 0.5, 56)),
        field("線寬", numIn("lineWidth", 0.5, 56), t === "line"),
        field("點大小", numIn("pointSize", 0.5, 56), t === "scatter" || t === "line"),
        field("點形狀", sel("pointShape", [["circle", "圓"], ["square", "方"], ["triangle", "三角"], ["diamond", "菱形"]]), t === "scatter" || t === "line"),
        field("條間距", range("barGap", 0, 0.9, 0.05), isBar),
        field("分組間距", range("groupGap", 0, 2, 0.1), isBar && spec && spec.catGroups),
        isBar && spec && spec.catGroups ? h("div", {}, chk("showGroups", "顯示第一級分組")) : null,
        isBar || t === "hist" ? h("div", {}, chk("stacked", "堆疊")) : null,
        field("組距", numIn("binWidth", 0.1), t === "hist"),
        field("起點", numIn("binStart", 0.1), t === "hist")),
      h("div", { class: "sec" },
        field("Y 範圍", h("span", {}, numIn("yMin", "any", 56), " – ", numIn("yMax", "any", 56))),
        field("X 範圍", h("span", {}, numIn("xMin", "any", 56), " – ", numIn("xMax", "any", 56)), t === "scatter" || t === "hist"),
        field("標籤角度", sel("labelAngle", [["auto", "自動"], ["0", "水平"], ["45", "45°"], ["90", "90°"]]), t === "bar" || t === "line"),
        field("圖例", sel("legend", [["right", "右側"], ["top", "上方"], ["bottom", "下方"], ["none", "不顯示"]])),
        h("div", {}, chk("showValues", "顯示數值"), " ", chk("showGrid", "格線")),
        field("背景", h("span", { class: "row", style: { flexWrap: "nowrap" } },
          h("input", { type: "color", value: st.background || "#ffffff", oninput: (e) => { st.background = e.target.value; markDirty(); draw(); } }),
          h("button", { class: "mini", onclick: () => { st.background = "#ffffff"; markDirty(); buildPanel(); draw(); } }, "白色")))),
      h("div", { class: "sec row" },
        h("button", { class: "primary mini", onclick: () => openExport(spec, st, key) }, "匯出圖檔…"),
        h("button", { class: "mini", onclick: () => { const keepType = st.type; Object.keys(st).forEach((k) => delete st[k]); Object.assign(st, Charts.DEFAULT_STYLE, { type: keepType }, opts.defaults || {}, { type: keepType }); markDirty(); buildPanel(); draw(); } }, "重設樣式"))];
    panel.append(...parts.filter(Boolean));
    buildColors();
  };
  draw(); buildPanel();
  const card = h("div", { class: "chartcard" }, box, panel);
  card.redraw = () => { draw(); };
  return card;
}

// PNG／SVG 匯出對話框
let EXP = null;
function openExport(spec, st, key) {
  EXP = { spec, st };
  const dlg = $("pngDlg");
  const mode = () => document.querySelector("input[name=pmode]:checked").value;
  const setUnits = () => {
    const m = mode();
    $("pWu").textContent = m === "cm" ? "cm" : "px"; $("pHu").textContent = m === "cm" ? "cm" : "px";
    $("pDpiRow").style.display = m === "cm" ? "" : "none"; $("pScaleRow").style.display = m === "cm" ? "none" : "";
    if (m === "cm") { $("pW").value = 16; $("pH").value = +(16 * st.height / st.width).toFixed(1); $("pW").step = 0.1; }
    else { $("pW").value = st.width; $("pH").value = st.height; $("pW").step = 10; }
    info();
  };
  const info = () => {
    const m = mode(); const w = Number($("pW").value), hh = Number($("pH").value);
    const px = m === "cm" ? [Math.round(w / 2.54 * $("pDpi").value), Math.round(hh / 2.54 * $("pDpi").value)] : [Math.round(w * $("pScale").value), Math.round(hh * $("pScale").value)];
    $("pInfo").textContent = document.querySelector("input[name=pfmt]:checked").value === "svg" ? "SVG 為向量圖，不受解析度限制（版面依上面的尺寸）。" : `輸出 ${px[0]} × ${px[1]} 像素`;
  };
  document.querySelectorAll("input[name=pmode]").forEach((r) => (r.onchange = setUnits));
  document.querySelectorAll("input[name=pfmt]").forEach((r) => (r.onchange = info));
  ["pW", "pH", "pDpi", "pScale"].forEach((id) => ($(id).oninput = info));
  $("pName").value = `${safeName(S.site || "data")}_${safeName(st.title || key)}_${today()}`;
  setUnits();
  $("pCancel").onclick = () => dlg.close();
  $("pGo").onclick = async () => {
    const m = mode(), fmt = document.querySelector("input[name=pfmt]:checked").value;
    const w = Number($("pW").value), hh = Number($("pH").value);
    const name = safeName($("pName").value || "chart");
    let msg;
    if (fmt === "svg") {
      const lw = m === "cm" ? Math.round(w / 2.54 * 96) : w, lh = m === "cm" ? Math.round(hh / 2.54 * 96) : hh;
      msg = await saveFile(`圖表/${name}.svg`, new Blob([Charts.render(EXP.spec, EXP.st, { w: lw, h: lh })], { type: "image/svg+xml" }), name + ".svg");
    } else {
      const r = await Charts.toPNG(EXP.spec, EXP.st, { mode: m, w, h: hh, dpi: $("pDpi").value, scale: $("pScale").value });
      msg = await saveFile(`圖表/${name}.png`, r.blob, name + ".png") + `（${r.px[0]}×${r.px[1]}）`;
    }
    dlg.close(); toast(msg);
  };
  dlg.showModal();
}

// ---------------------------------------------------------------- 共用元件
function speciesOptions() {
  // 只列出目前篩選條件下有資料的物種
  const present = new Set(S.view.map((r) => r._sp));
  return [...S.groups].filter((g) => g.include && !Core.NON_TAXON.test(g.name) && present.has(g.name)).sort((a, b) => a.order - b.order).map((g) => g.name);
}
function speciesSelect(tab, def) {
  const u = ui(tab); const opts = speciesOptions();
  if (!u.sp || !opts.includes(u.sp)) u.sp = Core.resolveSpecies(S.cfg, S.groups, def) || opts[0];
  return h("span", { class: "ctl" }, "物種 ", h("select", { onchange: (e) => { u.sp = e.target.value; markDirty(); renderTab(); } },
    opts.map((n) => { const zh = S.cfg.aliases.find((a) => a.資料名稱 === n); return h("option", { value: n, selected: n === u.sp }, zh && zh.中文名 !== n ? `${n}（${zh.中文名}）` : n); })));
}
function segs(options, cur, onPick) {
  return h("span", { class: "segs" }, options.map(([v, l]) => h("button", { class: v === cur ? "on" : "", onclick: () => onPick(v) }, l)));
}
const card = (title, ...kids) => h("div", { class: "card" }, title ? h("h2", {}, title) : null, ...kids);
function logBox() {
  const n = S.log.length; if (!n) return null;
  return h("details", {}, h("summary", {}, `處理紀錄（${n}）`), makeTable([{ k: "類型" }, { k: "流水號" }, { k: "原表列號" }, { k: "內容" }], S.log, { name: "處理紀錄", maxHeight: "240px" }));
}

// ---------------------------------------------------------------- 分頁
const TABS = [
  ["fauna", "物種相"], ["mni", "MNI"], ["elements", "骨骼部位"], ["sex", "性別"], ["age", "年齡"], ["marks", "表面痕"], ["molars", "臼齒測量"], ["help", "說明"],
];
function buildTabs() {
  $("tabs").innerHTML = "";
  for (const [id, label] of TABS) $("tabs").append(h("button", { class: id === S.tab ? "on" : "", onclick: () => { S.tab = id; buildTabs(); renderTab(); } }, label));
}
async function renderTab() {
  const body = $("tabBody");
  const scroll = window.scrollY;
  body.innerHTML = "";
  const fn = RENDER[S.tab];
  try { await fn(body); } catch (e) { console.error(e); body.append(h("div", { class: "notice" }, "發生錯誤：" + e.message)); }
  window.scrollTo(0, scroll);
}
const RENDER = {};

// ===== 物種相 =====
RENDER.fauna = (body) => {
  const u = ui("fauna");
  u.value ||= "NISP"; u.hideNonTaxon ??= true; u.level ||= "物種";
  // --- 分類層級與範圍
  const levels = Core.TAXON_LEVELS.filter((c) => c === "物種" || S.rows.some((r) => r[c]));
  if (!levels.includes(u.level)) u.level = "物種";
  const lvl = u.level;
  const scopeCols = levels.filter((c) => c !== lvl);
  if (u.scopeCol && !scopeCols.includes(u.scopeCol)) { u.scopeCol = ""; u.scopeVal = ""; }
  let rowsF = S.view;
  if (u.scopeCol && u.scopeVal) rowsF = rowsF.filter((r) => (r[u.scopeCol] ?? "") === u.scopeVal);
  const scopeVals = u.scopeCol ? [...Core.groupBy(S.view, (r) => r[u.scopeCol] ?? "")].map(([v, rs]) => [v, rs.length]).sort((a, b) => b[1] - a[1]) : [];
  // 物種層級使用「物種對照表」；其他層級各自有一份合併／排序設定（存在網頁工具設定中）
  let G;
  if (lvl === "物種") G = S.groups;
  else {
    S.settings.levelGroups ||= {};
    G = S.settings.levelGroups[lvl] = Core.defaultSpeciesGroups(S.rows, S.settings.levelGroups[lvl] || null, lvl).groups;
  }
  const setG = (ng) => { if (lvl === "物種") S.groups = ng; else S.settings.levelGroups[lvl] = ng; };
  const higher = Core.TAXON_LEVELS.slice(0, Core.TAXON_LEVELS.indexOf(lvl)).filter((c) => S.rows.some((r) => r[c]));
  u.taxCols = (u.taxCols || []).filter((c) => higher.includes(c));
  const res = Core.fauna(rowsF, G, lvl, u.taxCols);
  const scopeTxt = u.scopeCol && u.scopeVal ? `（${u.scopeCol}＝${u.scopeVal}）` : "";
  const top = h("div", { class: "row" },
    h("span", { class: "ctl" }, "計算欄位 ", h("select", { onchange: (e) => { u.level = e.target.value; markDirty(); renderTab(); } }, levels.map((c) => h("option", { selected: c === lvl }, c)))),
    h("span", { class: "ctl" }, "範圍 ", h("select", { onchange: (e) => { u.scopeCol = e.target.value; u.scopeVal = ""; markDirty(); renderTab(); } },
      [h("option", { value: "" }, "（全部）"), ...scopeCols.map((c) => h("option", { selected: c === u.scopeCol }, c))])),
    u.scopeCol ? h("select", { onchange: (e) => { u.scopeVal = e.target.value; markDirty(); renderTab(); } },
      [h("option", { value: "" }, "（請選擇）"), ...scopeVals.map(([v, n]) => h("option", { value: v, selected: v === u.scopeVal }, `${v || "（空白）"}（${n}）`))]) : null,
    higher.length ? h("span", { class: "ctl" }, "表格加列 ", higher.map((c) => h("label", {}, h("input", { type: "checkbox", checked: u.taxCols.includes(c), onchange: (e) => {
      u.taxCols = higher.filter((x) => (x === c ? e.target.checked : u.taxCols.includes(x))); markDirty(); renderTab(); } }), " " + c))) : null,
    h("span", { class: "muted" }, levels.length > 1 ? "例如：計算欄位＝物種、範圍＝綱：鳥綱，只看鳥類各物種；或計算欄位＝科。「表格加列」只是說明欄，不會重複計算件數。" : "清單中沒有綱／目／科／屬欄位，只能以物種計算。"));

  // --- 名稱設定清單（合併、排序、納入）
  const groups = [...G].sort((a, b) => a.order - b.order);
  const viewNisp = new Map(res.table.map((x) => [x.物種, x.NISP]));
  const allNisp = new Map(); for (const r of S.rows) { const k = lvl === "物種" ? r._sp : r[lvl] ?? ""; allNisp.set(k, (allNisp.get(k) || 0) + r._qty); }
  const changed = () => { markDirty(); if (lvl === "物種") reprepare(); renderTab(); };
  const renumber = (list) => list.forEach((g, i) => (g.order = i + 1));
  let dragName = null;
  const move = (g, d) => { const arr = [...groups]; const i = arr.indexOf(g), j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; renumber(arr); changed(); };
  const mergeSel = (g, x) => h("select", { class: x ? "" : "msel", title: x ? "把這個原始名稱併入其他名稱或拆出" : "把這個名稱併入其他名稱", onchange: (e) => {
    const to = e.target.value; if (!to) return;
    const moving = x ? [x] : g.raws;
    g.raws = g.raws.filter((y) => !moving.includes(y));
    if (to === "__new") G.push({ name: x.raw, order: g.order + 0.5, include: g.include, raws: [x] });
    else G.find((y) => y.name === to).raws.push(...moving);
    if (!g.raws.length) G.splice(G.indexOf(g), 1);
    renumber([...G].sort((a, b) => a.order - b.order)); changed();
  } }, h("option", { value: "" }, x ? "▾" : "併入…"), x && g.raws.length > 1 ? h("option", { value: "__new" }, "拆成獨立名稱") : null,
  groups.filter((y) => y !== g).map((y) => h("option", { value: y.name }, "併入 " + y.name)));
  // 只列出目前篩選與範圍下有資料的名稱（可切換顯示全部）
  const inScope = new Set(rowsF.map((r) => (lvl === "物種" ? r._sp : r[lvl] ?? "")));
  const present = groups.filter((g) => inScope.has(g.name) || g.raws.some((x) => inScope.has(x.raw)));
  const shown = u.showAllNames ? groups : present;
  const hiddenN = groups.length - present.length;
  const list = h("div", { class: "sp-list" }, shown.map((g) => {
    const item = h("div", { class: "sp-item" + (g.include ? "" : " excl"), draggable: "true",
      ondragstart: (e) => { dragName = g.name; e.dataTransfer.effectAllowed = "move"; },
      ondragover: (e) => { e.preventDefault(); item.classList.add("drag-over"); },
      ondragleave: () => item.classList.remove("drag-over"),
      ondrop: (e) => {
        e.preventDefault(); item.classList.remove("drag-over");
        if (!dragName || dragName === g.name) return;
        const arr = groups.filter((x) => x.name !== dragName); const moved = groups.find((x) => x.name === dragName);
        arr.splice(arr.indexOf(g), 0, moved); renumber(arr); changed();
      } },
    h("span", { class: "handle", title: "拖曳調整順序（平板請用 ▲▼）" }, "≡"),
    h("input", { type: "checkbox", checked: g.include, title: "納入物種相", onchange: (e) => { g.include = e.target.checked; changed(); } }),
    h("input", { type: "text", value: g.name, title: "合併名稱（改成另一個已有名稱即合併）", onchange: (e) => {
      const nn = e.target.value.trim(); if (!nn || nn === g.name) return;
      const other = G.find((x) => x.name === nn);
      if (other) { other.raws.push(...g.raws); G.splice(G.indexOf(g), 1); }
      else g.name = nn;
      changed();
    } }),
    h("span", { class: "muted", title: "目前篩選與範圍下的 NISP" }, `${viewNisp.get(g.name) ?? 0}`),
    h("span", { class: "updown" }, h("button", { class: "mini", title: "上移", onclick: () => move(g, -1) }, "▲"), h("button", { class: "mini", title: "下移", onclick: () => move(g, 1) }, "▼")),
    mergeSel(g, null),
    g.raws.length > 1 ? h("div", { class: "raws" }, h("span", { class: "muted small" }, "含："), g.raws.map((x) => h("span", { class: "chip", title: `原始名稱 ${x.raw}：${x.n} 筆` }, `${x.raw || "（空白）"}（${x.n}）`, mergeSel(g, x)))) : null);
    return item;
  }));
  const tools = h("div", { class: "row", style: { margin: "8px 0" } },
    h("button", { class: "mini", onclick: () => {
      const cat = (n) => (Core.NON_TAXON.test(n) ? (/sze|size/i.test(n) ? 2 : 3) : 1);
      renumber([...G].sort((a, b) => cat(a.name) - cat(b.name) || (allNisp.get(b.name) || 0) - (allNisp.get(a.name) || 0))); changed();
    } }, "依 NISP 排序"),
    h("button", { class: "mini", onclick: () => { if (!confirm(`「${lvl}」的合併、順序、納入設定都會回到自動預設（大小寫合併）。確定？`)) return; setG(Core.defaultSpeciesGroups(S.rows, null, lvl).groups); changed(); } }, "重設為預設"));
  // 依分類排序：綱 → 目 → 科 → 屬 → NISP
  if (higher.length) tools.append(h("button", { class: "mini", title: `依 ${higher.join("、")} 排序，同一類內依 NISP`, onclick: () => {
    const byKey = Core.groupBy(S.rows, (r) => (lvl === "物種" ? r._sp : r[lvl] ?? ""));
    const key = (g) => higher.map((c) => { const v = Core.taxOf(byKey.get(g.name) || [], c).split("／")[0]; return !v || Core.NON_TAXON.test(v) ? "\uffff" : v; });
    const nt = (n) => (Core.NON_TAXON.test(n) ? 1 : 0);
    renumber([...G].sort((a, b) => nt(a.name) - nt(b.name) || key(a).join("\u0001").localeCompare(key(b).join("\u0001"), "zh-Hant") || (allNisp.get(b.name) || 0) - (allNisp.get(a.name) || 0)));
    changed();
  } }, "依分類排序"));
  if (hiddenN) tools.append(h("label", { class: "small muted" }, h("input", { type: "checkbox", checked: !!u.showAllNames, onchange: (e) => { u.showAllNames = e.target.checked; markDirty(); renderTab(); } }),
    ` 也顯示目前篩選下沒有資料的 ${hiddenN} 個名稱`));
  const left = card(`${lvl}設定`, h("div", { class: "muted" }, "勾選＝納入；拖曳 ≡ 調整順序；改名稱可合併（改成已有的名稱）；原始名稱旁的 ▾ 可併入其他名稱或拆出。" + (lvl === "物種" ? "物種的合併也會影響其他分頁。" : "")), tools, list);

  // --- 結果表
  const cols = [...u.taxCols.map((c) => ({ k: "_tax_" + c, label: c })), { k: "物種", label: lvl }, { k: "NISP", f: "int" }, { k: "百分比", f: "pct" }, { k: "可鑑定百分比", label: "百分比（僅可鑑定）", f: "pct" }];
  if (res.hasW) cols.push({ k: "重量", f: "num" }, { k: "重量百分比", f: "pct" });
  cols.push({ k: "筆數", label: "紀錄筆數", f: "int" });
  const total = { [u.taxCols.length ? "_tax_" + u.taxCols[0] : "物種"]: "合計", NISP: res.total, 百分比: 1, 可鑑定百分比: 1, 筆數: Core.sum(res.table, (x) => x.筆數), 重量: res.wTotal, 重量百分比: res.hasW ? 1 : null };
  const tbl = makeTable(cols, res.table, { total, name: `${S.site}_動物相_${lvl}${u.scopeVal ? "_" + u.scopeVal : ""}`, title: `遺址${lvl}相${scopeTxt}（NISP = 數量加總${res.hasW ? "；重量 = 重量欄加總" : ""}）` });
  // --- 圖
  const valOpts = [["NISP", "NISP"], ["百分比", "百分比"], ["可鑑定百分比", "百分比（僅可鑑定）"]].concat(res.hasW ? [["重量", "重量"], ["重量百分比", "重量百分比"]] : []);
  if (!valOpts.some(([v]) => v === u.value)) u.value = "NISP";
  const chartOpts = h("div", { class: "row small" },
    "數值 ", h("select", { onchange: (e) => { u.value = e.target.value; markDirty(); renderTab(); } }, valOpts.map(([v, l]) => h("option", { value: v, selected: u.value === v }, l))),
    h("label", {}, h("input", { type: "checkbox", checked: !!u.hideNonTaxon, onchange: (e) => { u.hideNonTaxon = e.target.checked; markDirty(); renderTab(); } }), " 圖中不顯示 UN／不明與體型分級"));
  const ch = chartCard("fauna", (type) => {
    let t = res.table; if (u.hideNonTaxon || u.value === "可鑑定百分比") t = t.filter((x) => !Core.NON_TAXON.test(x.物種));
    const pct = /百分比/.test(u.value);
    return { type, categories: t.map((x) => x.物種), series: [{ name: u.value, values: t.map((x) => x[u.value]) }], valueFormat: u.value === "NISP" ? "int" : pct ? "pct" : "num",
      title: `遺址${lvl}相${scopeTxt}`, yLabel: u.value === "重量" ? "重量 (g)" : u.value };
  }, { types: ["bar", "hbar"] });
  body.append(card(null, top), h("div", { class: "split" }, left, card(null, tbl, logBox())), card("圖表", chartOpts, ch));
};

// ===== MNI =====
RENDER.mni = (body) => {
  const u = ui("mni");
  const ov = S.settings.mniOverride;
  const res = Core.mni(S.view, S.cfg, S.groups, ov);
  if (!u.sp || !res.detail[u.sp]) u.sp = res.species.find((x) => x.物種 === Core.resolveSpecies(S.cfg, S.groups, "Sus"))?.物種 || res.species[0]?.物種;
  u.series ||= ["側別MNI", "區位MNI"];
  const sumCols = [{ k: "物種" }, { k: "側別MNI", f: "int" }, { k: "側別百分比", label: "側別%", f: "pct" }, { k: "側別依據" },
    { k: "區位MNI", f: "int" }, { k: "區位百分比", label: "區位%", f: "pct" }, { k: "區位依據" },
    { k: "_m", label: "", render: (r) => (ov[r.物種] && Object.keys(ov[r.物種]).length ? h("span", { class: "pill mod" }, "已調整部位") : "") }];
  const total = { 物種: "合計", 側別MNI: res.totalSide, 側別百分比: 1, 區位MNI: res.totalZone, 區位百分比: 1 };
  const sumTbl = makeTable(sumCols, res.species, { total, name: `${S.site}_MNI`, title: "MNI（點選物種可調整採計部位）",
    onClick: (r) => { u.sp = r.物種; markDirty(); renderTab(); }, rowClass: (r) => (r.物種 === u.sp ? "sel" : "") });
  // --- 部位明細
  const det = res.detail[u.sp] || [];
  const sideMax = Math.max(0, ...det.filter((e) => e.納入).map((e) => e.側別最大));
  const zoneMax = Math.max(0, ...det.filter((e) => e.納入).map((e) => e.區位最大));
  const toggle = (el, v) => {
    const def = Core.mniDefault(S.cfg, u.sp, el);
    ov[u.sp] ||= {};
    if (v === def) delete ov[u.sp][el]; else ov[u.sp][el] = v;
    if (!Object.keys(ov[u.sp]).length) delete ov[u.sp];
    markDirty(); renderTab();
  };
  const zs = (s) => (r) => r[s].zoned + "/" + r[s].n;
  const detCols = [
    { k: "納入", render: (r) => h("input", { type: "checkbox", checked: r.納入, onchange: (e) => toggle(r.骨骼部位, e.target.checked) }), text: (r) => (r.納入 ? "Y" : "N") },
    { k: "骨骼部位" }, { k: "預設", f: (v, r) => (r.預設 ? "Y" : "N") },
    { k: "L件", label: "L 件", render: (r) => String(r.L.n), num: true, cls: (r) => (r.納入 && r.L.n === sideMax ? "star" : "") },
    { k: "R件", label: "R 件", render: (r) => String(r.R.n), num: true, cls: (r) => (r.納入 && r.R.n === sideMax ? "star" : "") },
    { k: "L區", label: "L 區位MNE", render: (r) => String(r.L.mne), num: true, cls: (r) => (r.納入 && r.L.mne === zoneMax ? "star" : "") },
    { k: "R區", label: "R 區位MNE", render: (r) => String(r.R.mne), num: true, cls: (r) => (r.納入 && r.R.mne === zoneMax ? "star" : "") },
    { k: "Lz", label: "L 有區位/件", render: zs("L"), num: true }, { k: "Rz", label: "R 有區位/件", render: zs("R"), num: true },
  ];
  if (u.showZones) detCols.push({ k: "zones", label: "標本區位（流水號:區位）", render: (r) => ["L", "R"].filter((s) => r[s].specimens.length).map((s) => `${s} ▸ ` + r[s].specimens.map((x) => `${x.id}:${x.zones}`).join(" | ")).join("　") });
  const detTbl = makeTable(detCols, det, { name: `${S.site}_MNI_${u.sp}`, title: `${u.sp}：部位明細`,
    rowClass: (r) => [r.納入 !== r.預設 ? "mod" : "", r.納入 ? "" : "off"].join(" ") });
  const detCard = card(null,
    h("div", { class: "row small" }, "★ = 目前的最大值（決定 MNI）。黃色列＝與預設不同。",
      h("label", {}, h("input", { type: "checkbox", checked: !!u.showZones, onchange: (e) => { u.showZones = e.target.checked; markDirty(); renderTab(); } }), " 顯示標本區位"),
      ov[u.sp] ? h("button", { class: "mini", onclick: () => { delete ov[u.sp]; markDirty(); renderTab(); } }, "此物種恢復預設") : null),
    detTbl,
    h("div", { class: "muted", style: { marginTop: "6px" } }, "側別 MNI＝同側同部位件數最大值；區位 MNI＝同側同部位標本區位（1–8）重疊即為不同骨，求最少骨數。沒有區位紀錄的標本不增加 MNE；整個部位都沒有區位紀錄時記為 1。預設採計的部位依 程式/設定/骨骼分類.csv。"));
  // --- 圖
  const chartOpts = h("div", { class: "row small" }, ["側別MNI", "區位MNI"].map((k) => h("label", {}, h("input", { type: "checkbox", checked: u.series.includes(k), onchange: (e) => {
    u.series = e.target.checked ? [...new Set([...u.series, k])] : u.series.filter((x) => x !== k); markDirty(); renderTab(); } }), " " + k)),
    h("label", {}, h("input", { type: "checkbox", checked: !!u.hidePresence, onchange: (e) => { u.hidePresence = e.target.checked; markDirty(); renderTab(); } }), " 不顯示「以出現計 1」的物種"));
  const ch = chartCard("mni", (type) => {
    let t = res.species; if (u.hidePresence) t = t.filter((x) => !/以出現計/.test(x.側別依據));
    return { type, categories: t.map((x) => x.物種), series: u.series.map((k) => ({ name: k, values: t.map((x) => x[k]) })), valueFormat: "int" };
  }, { types: ["bar", "hbar"], defaults: { title: "MNI", yLabel: "MNI" } });
  body.append(card(null, sumTbl), detCard, card("圖表", chartOpts, ch));
};

// ===== 骨骼部位 =====
RENDER.elements = (body) => {
  const u = ui("elements");
  const top = h("div", { class: "row" }, speciesSelect("elements", "Sus"));
  const sp = u.sp; u.mode ||= "noside"; u.value ||= "加總"; u.sides ||= ["L", "R"]; u.sideValue ||= "件數";
  const hidden = new Set((u.hidden ||= {})[sp] || []);
  // 排除的部位不列入合計與百分比（三種模式一致）
  const full = Core.elements(S.view, sp);
  const res = Core.elements(S.view.filter((r) => r._sp !== sp || !hidden.has(r._el)), sp);
  top.append(segs([["noside", "不分側別"], ["side", "分側別（左右對照）"], ["region", "區域小計"]], u.mode, (v) => { u.mode = v; markDirty(); renderTab(); }));
  const setHidden = (el, on) => { on ? hidden.delete(el) : hidden.add(el); u.hidden[sp] = [...hidden]; markDirty(); renderTab(); };
  const inclChk = (r) => h("input", { type: "checkbox", title: "納入計算與圖表", checked: !hidden.has(r.骨骼部位), onchange: (e) => setHidden(r.骨骼部位, e.target.checked) });
  const offRows = (list) => list.filter((x) => hidden.has(x.骨骼部位)).map((x) => ({ ...x, _off: true }));
  const offCls = (r) => (r._off ? "off" : "");
  const pctOrBlank = (k) => ({ k, f: (v, r) => (r._off ? "" : fmtPct(v)), num: true });
  const exclNote = hidden.size ? h("div", { class: "notice" }, `已排除：${[...hidden].join("、")}（不列入合計、百分比與圖表）`,
    h("button", { class: "mini", style: { marginLeft: "8px" }, onclick: () => { u.hidden[sp] = []; markDirty(); renderTab(); } }, "全部納入")) : null;
  let tbl, chartOpts, ch, extra = null;
  if (u.mode === "region") {
    tbl = makeTable([{ k: "骨骼區域" }, { k: "加總", f: "int" }, { k: "整體百分比", f: "pct" }], res.regions, { total: { 骨骼區域: "合計", 加總: res.total, 整體百分比: 1 }, name: `${S.site}_骨骼區域_${sp}`,
      title: hidden.size ? `骨骼區域小計（已排除 ${hidden.size} 個部位）` : "骨骼區域小計" });
    // 部位勾選清單（依區域）
    const byReg = Core.groupBy(full.noSide, (x) => x.骨骼區域);
    extra = card("納入計算的部位", h("div", { class: "muted" }, "取消勾選的部位不列入區域小計（例如牙齒）。"),
      h("div", { class: "row", style: { alignItems: "flex-start", gap: "18px", marginTop: "6px" } }, [...byReg].map(([rg, xs]) => h("div", {},
        h("div", { class: "row" }, h("b", { class: "small" }, rg),
          h("button", { class: "mini", onclick: () => { xs.forEach((x) => hidden.delete(x.骨骼部位)); u.hidden[sp] = [...hidden]; markDirty(); renderTab(); } }, "全選"),
          h("button", { class: "mini", onclick: () => { xs.forEach((x) => hidden.add(x.骨骼部位)); u.hidden[sp] = [...hidden]; markDirty(); renderTab(); } }, "全不選")),
        xs.map((x) => h("label", { style: { display: "flex", gap: "6px", fontSize: "13px" } },
          h("input", { type: "checkbox", checked: !hidden.has(x.骨骼部位), onchange: (e) => setHidden(x.骨骼部位, e.target.checked) }),
          h("span", {}, x.骨骼部位), h("span", { class: "muted", style: { marginLeft: "auto" } }, String(x.加總))))))));
    chartOpts = h("div", { class: "row small" }, "數值 ", h("select", { onchange: (e) => { u.value = e.target.value === "整體百分比" ? "整體百分比" : "加總"; markDirty(); renderTab(); } }, ["加總", "整體百分比"].map((v) => h("option", { selected: u.value === v }, v))));
    const vk = u.value === "加總" ? "加總" : "整體百分比";
    ch = chartCard("elements_region", (type) => ({ type, categories: res.regions.map((x) => x.骨骼區域), defaultColorBy: "category", valueFormat: vk === "加總" ? "int" : "pct",
      series: [{ name: vk, values: res.regions.map((x) => x[vk]) }], title: `${sp} 骨骼區域`, yLabel: vk === "加總" ? "NISP" : "百分比" }), { types: ["bar", "hbar"] });
  } else if (u.mode === "noside") {
    tbl = makeTable([{ k: "納入", render: (r) => inclChk(r), text: (r) => (r._off ? "排除" : "") }, { k: "骨骼區域" }, { k: "骨骼部位" }, { k: "加總", f: "int" }, pctOrBlank("區域百分比"), pctOrBlank("整體百分比")],
      res.noSide.concat(offRows(full.noSide)), { total: { 骨骼區域: "合計", 加總: res.total, 整體百分比: 1 }, name: `${S.site}_骨骼部位_${sp}`, rowClass: offCls });
    chartOpts = h("div", { class: "row small" },
      "數值 ", h("select", { onchange: (e) => { u.value = e.target.value; markDirty(); renderTab(); } }, ["加總", "整體百分比", "區域百分比"].map((v) => h("option", { selected: u.value === v }, v))),
      h("span", { class: "muted" }, "同一區域預設同色；表格「納入」欄取消勾選可排除該部位（例如牙齒）。"));
    const els = res.noSide;
    ch = chartCard("elements_noside", (type) => ({ type, categories: els.map((x) => x.骨骼部位), catGroups: els.map((x) => x.骨骼區域), defaultColorBy: "group",
      series: [{ name: u.value, values: els.map((x) => x[u.value]) }], valueFormat: u.value === "加總" ? "int" : "pct",
      title: `${sp} 骨骼部位分布`, yLabel: u.value === "加總" ? "NISP" : u.value }), { types: ["bar", "hbar"] });
  } else {
    tbl = makeTable([{ k: "納入", render: (r) => inclChk(r), text: (r) => (r._off ? "排除" : "") }, { k: "骨骼區域" }, { k: "骨骼部位" }, { k: "L", label: "左 L", f: "int" }, { k: "R", label: "右 R", f: "int" },
      { k: "合計", label: "左右合計", f: "int" }, pctOrBlank("L百分比"), pctOrBlank("R百分比")], res.sides.concat(offRows(full.sides)),
    { total: { 骨骼區域: "合計", L: res.totL, R: res.totR, 合計: res.totL + res.totR, L百分比: 1, R百分比: 1 }, name: `${S.site}_骨骼部位左右_${sp}`, rowClass: offCls,
      title: `只列有左／右紀錄的部位；不分側（Ax、-、UN）共 ${res.nonLR} 件未列入` });
    chartOpts = h("div", { class: "row small" }, "側別 ",
      [["L", "左側"], ["R", "右側"]].map(([k, l]) => h("label", {}, h("input", { type: "checkbox", checked: u.sides.includes(k), onchange: (e) => {
        u.sides = e.target.checked ? ["L", "R"].filter((x) => u.sides.includes(x) || x === k) : u.sides.filter((x) => x !== k); markDirty(); renderTab(); } }), " " + l)),
      "　數值 ", h("select", { onchange: (e) => { u.sideValue = e.target.value; markDirty(); renderTab(); } }, ["件數", "佔同側百分比"].map((v) => h("option", { selected: u.sideValue === v }, v))),
      h("span", { class: "muted" }, "同側預設同色，左右並列；第一級分組標在軸下。"));
    const els = res.sides;
    const pctMode = u.sideValue !== "件數";
    ch = chartCard("elements_side", (type) => ({ type, categories: els.map((x) => x.骨骼部位), catGroups: els.map((x) => x.骨骼區域), defaultColorBy: "series",
      series: u.sides.map((sd) => ({ name: sd === "L" ? "左 L" : "右 R", values: els.map((x) => (pctMode ? x[sd + "百分比"] : x[sd])) })), valueFormat: pctMode ? "pct" : "int",
      title: `${sp} 骨骼部位（左右對照）`, yLabel: pctMode ? "佔同側百分比" : "NISP" }), { types: ["bar", "hbar"] });
  }
  body.append(card(null, top, exclNote), u.mode === "region" ? h("div", { class: "split" }, card(null, tbl), extra) : card(null, tbl), card("圖表", chartOpts, ch));
};

// ===== 性別 =====
RENDER.sex = (body) => {
  const u = ui("sex");
  const top = h("div", { class: "row" }, speciesSelect("sex", "Sus"));
  const sp = u.sp; const ov = S.settings.sexOverride;
  const res = Core.sex(S.view, S.cfg, sp, ov);
  const tot = { 性別: "合計", 上顎: Core.sum(res.table, (x) => x.上顎), 下顎: Core.sum(res.table, (x) => x.下顎), 不明: Core.sum(res.table, (x) => x.不明), 合計: Core.sum(res.table, (x) => x.合計) };
  const sumTbl = makeTable([{ k: "性別" }, { k: "上顎", f: "int" }, { k: "下顎", f: "int" }, { k: "不明", label: "上下顎不明", f: "int" }, { k: "合計", f: "int" }], res.table, { total: tot, name: `${S.site}_性別_${sp}`, title: "性別結構（只計採計者，每筆紀錄算 1）" });
  const setOv = (id, k, v, auto) => { ov[id] ||= {}; if (v === auto) delete ov[id][k]; else ov[id][k] = v; if (!Object.keys(ov[id]).length) delete ov[id]; markDirty(); renderTab(); };
  const detTbl = makeTable([
    { k: "採計", render: (r) => h("input", { type: "checkbox", checked: r.採計, onchange: (e) => setOv(r.流水號, "採計", e.target.checked, r.自動採計) }), text: (r) => (r.採計 ? "Y" : "N") },
    { k: "流水號" }, { k: "骨骼" }, { k: "側" }, { k: "備註" }, { k: "判定詞" },
    { k: "性別", render: (r) => h("select", { onchange: (e) => setOv(r.流水號, "性別", e.target.value, r.性別) }, Core.SEX_ROWS.concat(r.性別 === "矛盾" ? ["矛盾"] : []).map((s) => h("option", { selected: s === r.性別_用 }, s))), text: (r) => r.性別_用 },
    { k: "上下顎", render: (r) => h("select", { onchange: (e) => setOv(r.流水號, "上下顎", e.target.value, r.上下顎) }, ["上顎", "下顎", "不明"].map((s) => h("option", { selected: s === r.上下顎_用 }, s))), text: (r) => r.上下顎_用 },
    { k: "犬齒依據" }, { k: "同個體註記", label: "同個體" }, { k: "不採計原因" },
  ], res.detail, { name: `${S.site}_性別明細_${sp}`, title: "判定明細（可修改採計、性別、上下顎；黃色＝已修改）", rowClass: (r) => [r.已修改 ? "mod" : "", r.採計 ? "" : "off"].join(" ") });
  const ch = chartCard("sex", (type) => ({ type, categories: res.table.map((x) => x.性別), valueFormat: "int",
    series: ["上顎", "下顎", "不明"].filter((k) => res.table.some((x) => x[k])).map((k) => ({ name: k, values: res.table.map((x) => x[k]) })) }),
  { types: ["bar", "hbar"], defaults: { title: `${sp} 性別結構`, yLabel: "件數", stacked: true } });
  body.append(card(null, top, Object.keys(ov).length ? h("button", { class: "mini", style: { marginTop: "6px" }, onclick: () => { if (confirm("清除所有性別判定的修改？")) { S.settings.sexOverride = {}; markDirty(); renderTab(); } } }, "清除所有修改") : null),
    card(null, sumTbl), card("圖表", ch), card(null, detTbl));
};

// ===== 年齡 =====
async function longsFor(sp) {
  if (S.longCache[sp]) return S.longCache[sp];
  const longs = { mandible: [], tooth: [], maxilla: [] };
  if (S.parsedDir && S.folderIndex) {
    const g = S.groups.find((x) => x.name === sp);
    const raws = new Set(g ? g.raws.map((x) => x.raw) : [sp]);
    for (const row of S.folderIndex.filter((x) => raws.has(x.物種))) {
      const dir = sitePath(`${S.parsedDir}/${row.資料夾}`);
      const files = (await S.fs.list(dir)) || [];
      for (const f of files) {
        const m = /_長表_(.+)\.csv$/i.exec(f.name);
        if (!m || !(m[1].toLowerCase() in longs)) continue;
        longs[m[1].toLowerCase()].push(...Core.parseCSV(await S.fs.readText(`${dir}/${f.name}`)).rows);
      }
    }
  }
  if (!S.folderIndex) {
    // 平板／選檔模式：直接選取的「物種_長表_骨骼.csv」
    const g = S.groups.find((x) => x.name === sp);
    const names = new Set([sp, ...(g ? g.raws.map((x) => x.raw) : [])].map((x) => String(x).toLowerCase().replace(/[\\/:*?"<>| ]+/g, "_")));
    for (const f of ((await S.fs.list(S.site)) || []).filter((x) => x.kind === "file")) {
      const m = /^(.+?)(?:_\d+)?_長表_(mandible|tooth|maxilla)\.csv$/i.exec(f.name);
      if (m && names.has(m[1].toLowerCase())) longs[m[2].toLowerCase()].push(...Core.parseCSV(await S.fs.readText(sitePath(f.name))).rows);
    }
  }
  return (S.longCache[sp] = longs);
}
RENDER.age = async (body) => {
  const u = ui("age");
  const top = h("div", { class: "row" }, speciesSelect("age", "Sus"));
  const sp = u.sp; u.jaw ||= "全部"; u.teeth ||= [...Core.MAIN_TEETH]; u.value ||= "件數"; u.sys ||= "Simplified-B";
  body.append(card(null, top, h("div", { class: "muted" }, "讀取長表…")));
  const longs = await longsFor(sp);
  body.innerHTML = "";
  const res = Core.age(S.view, S.cfg, sp, longs);
  const wm = (S.settings.wearMap ||= {});
  const scoreOf = (raw) => (raw in wm ? wm[raw] : Core.defaultWearScore(raw).expr);
  top.append(h("span", { class: "ctl" }, "上下顎 ", h("select", { onchange: (e) => { u.jaw = e.target.value; markDirty(); renderTab(); } }, ["全部", "下顎", "上顎", "不明"].map((v) => h("option", { selected: u.jaw === v }, v)))),
    h("span", { class: "ctl" }, "年齡組系統 "), segs(Core.SYSTEMS.map((x) => [x, x]), u.sys, (v) => { u.sys = v; markDirty(); renderTab(); }));
  const rows = res.table.filter((r) => u.jaw === "全部" || (r.上下顎 || "不明") === u.jaw);
  // --- Lemoine 判定
  for (const r of rows) for (const sys of Core.SYSTEMS) { const a = Core.lemoineAssign(r, sys, scoreOf); r["_" + sys] = a; r[sys] = a.cls || ""; }
  const assigned = rows.map((r) => r[u.sys]).filter(Boolean);
  const summ = Core.lemoineSummary(assigned, u.sys);
  const unres = rows.length - assigned.length;

  // --- 磨耗寫法對照
  const wcount = new Map();
  for (const r of res.table) for (const t of Core.MAIN_TEETH) for (const v of String(r[t] || "").split(/;\s*/).filter(Boolean)) wcount.set(v, (wcount.get(v) || 0) + 1);
  const wrows = [...wcount].map(([raw, n]) => { const d = Core.defaultWearScore(raw); return { 原始寫法: raw, 件數: n, 預設: d.expr, 說明: d.note, _flag: d.flag, 使用: scoreOf(raw) }; })
    .sort((a, b) => Core.wearRank(a.原始寫法) - Core.wearRank(b.原始寫法) || a.原始寫法.localeCompare(b.原始寫法));
  const wtbl = makeTable([{ k: "原始寫法" }, { k: "件數", f: "int" },
    { k: "使用", label: "Lemoine 分數", render: (r) => h("input", { type: "text", value: r.使用, style: { width: "70px" }, placeholder: "空白＝不採用", onchange: (e) => {
      const v = e.target.value.trim(); if (v === r.預設) delete wm[r.原始寫法]; else wm[r.原始寫法] = v; markDirty(); renderTab(); } }), text: (r) => r.使用 },
    { k: "預設" }, { k: "說明" }], wrows,
  { name: `${S.site}_磨耗對照_${sp}`, title: "磨耗寫法 → Lemoine 分數", maxHeight: "430px",
    rowClass: (r) => (r.原始寫法 in wm ? "mod" : r._flag ? "warn" : "") });
  const wnote = h("div", { class: "muted", style: { marginTop: "6px" } },
    "分數（Lemoine et al. 2014 Table 1）：0 未萌出、1–3 齒囊中、4 萌出穿過骨、5 萌出一半、6 完全萌出無磨耗、7–19 = Grant a–n（無 i）。可填範圍（如 1-3）或多值（如 9,11）。橘色＝自動判讀但需確認；黃色＝已修改。");

  // --- 年齡組統計
  const L = Core.LEMOINE[u.sys];
  const stbl = makeTable([{ k: "年齡組" }, { k: "年齡估計" }, { k: "件數", f: "int" }, { k: "死亡率", label: "死亡率（%）", f: "pct" }, { k: "存活率", label: "存活率（%）", f: "pct" }],
    summ.rows, { total: { 年齡組: "合計", 件數: summ.n, 死亡率: 1 }, name: `${S.site}_年齡組_${u.sys}_${sp}`, title: `${u.sys} 年齡組（判定 ${summ.n} 件；無法判定 ${unres} 件）` });
  const snote = h("div", { class: "muted", style: { marginTop: "6px" } },
    "判定方式（Lemoine et al. 2014 §3.2）：每顆牙依分數對照 Table 3 找出可能的年齡組，同一列（同一流水號、同上下顎）各齒可能組別的眾數若唯一，即為該列的年齡組；否則不列入該系統。存活率＝100% 減去累計死亡率。上顎與下顎依各自的範圍判定；上下顎不明者兩者皆可。");

  // --- 存活曲線
  // 分組比較（例如各文化層各畫一條曲線）
  const byId = new Map(); for (const r of S.view) if (!byId.has(r.流水號)) byId.set(r.流水號, r);
  const gcol = u.compare || "";
  const cmpMap = gcol ? ((u.cmpMap ||= {})[gcol] ||= {}) : {};
  const cmpHide = new Set(gcol ? ((u.cmpHide ||= {})[gcol] || []) : []);
  const rawOf = (r) => String((byId.get(r.流水號) || {})[gcol] ?? "") || "（空白）";
  const tgtOf = (v) => (v in cmpMap ? cmpMap[v] : v);
  let groupsCmp = [], cmpEditor = null;
  if (gcol) {
    const asg = rows.filter((r) => r[u.sys]);
    const gm = Core.groupBy(asg.filter((r) => tgtOf(rawOf(r)) && !cmpHide.has(tgtOf(rawOf(r)))), (r) => tgtOf(rawOf(r)));
    groupsCmp = [...gm].sort((a, b) => b[1].length - a[1].length).map(([g, rs]) => ({ g, summ: Core.lemoineSummary(rs.map((r) => r[u.sys]), u.sys) }))
      .filter((x) => x.summ.n >= (Number(u.minN) || 1));
    // --- 分組編輯：原始值 → 歸入組；組別顯示與否
    const rawCnt = new Map(); for (const r of asg) rawCnt.set(rawOf(r), (rawCnt.get(rawOf(r)) || 0) + 1);
    const raws = [...rawCnt].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh-Hant"));
    const tgtCnt = new Map(); for (const [v, n] of raws) { const t = tgtOf(v); if (t) tgtCnt.set(t, (tgtCnt.get(t) || 0) + n); }
    const changed = () => { u.cmpHide[gcol] = [...cmpHide]; markDirty(); renderTab(); };
    const dl = h("datalist", { id: "cmpTargets" }, [...tgtCnt.keys()].map((t) => h("option", { value: t })));
    const rawTbl = makeTable([{ k: "原始值" }, { k: "件數", f: "int" },
      { k: "歸入", render: (r) => h("input", { type: "text", list: "cmpTargets", value: tgtOf(r.原始值), style: { width: "150px" }, placeholder: "空白＝不列入", onchange: (e) => {
        const v = e.target.value.trim(); if (v === r.原始值) delete cmpMap[r.原始值]; else cmpMap[r.原始值] = v; changed(); } }), text: (r) => tgtOf(r.原始值) }],
    raws.map(([v, n]) => ({ 原始值: v, 件數: n })), { name: `${S.site}_分組對照_${gcol}`, title: "原始值 → 歸入組（改成同一名稱即合併；清空＝不列入）", maxHeight: "300px",
      rowClass: (r) => (r.原始值 in cmpMap ? "mod" : "") });
    const grpList = h("div", { class: "vals", style: { maxHeight: "300px" } }, [...tgtCnt].sort((a, b) => b[1] - a[1]).map(([t, n]) => h("label", { style: { display: "flex", gap: "6px" } },
      h("input", { type: "checkbox", checked: !cmpHide.has(t), onchange: (e) => { e.target.checked ? cmpHide.delete(t) : cmpHide.add(t); changed(); } }),
      h("span", {}, t), h("span", { class: "muted", style: { marginLeft: "auto" } }, `n=${n}${n < (Number(u.minN) || 1) ? "（不足）" : ""}`))));
    cmpEditor = h("details", { open: u.cmpOpen ? true : null, ontoggle: (e) => { u.cmpOpen = e.target.open; } },
      h("summary", {}, `調整「${gcol}」分組（合併、只顯示部分組）`),
      h("div", { class: "row", style: { margin: "6px 0" } },
        h("button", { class: "mini", onclick: () => { for (const [v] of raws) { const t = v.replace(/\s*[*＊]+\s*$/, ""); if (t && t !== v) cmpMap[v] = t; } changed(); } }, "自動合併：去掉結尾的 *"),
        h("button", { class: "mini", onclick: () => { cmpHide.clear(); [...tgtCnt.keys()].forEach((t) => cmpHide.add(t)); changed(); } }, "全不顯示"),
        h("button", { class: "mini", onclick: () => { cmpHide.clear(); changed(); } }, "全部顯示"),
        h("button", { class: "mini", onclick: () => { if (!confirm(`清除「${gcol}」的所有合併與顯示設定？`)) return; u.cmpMap[gcol] = {}; u.cmpHide[gcol] = []; markDirty(); renderTab(); } }, "重設")),
      h("div", { class: "split" }, h("div", {}, rawTbl, dl), h("div", {}, h("b", { class: "small" }, "顯示的組（勾選）"), grpList)));
  }
  const cmpCols = S.header.filter((c) => !/^(流水號|原代號|備註|數量|GL|WA|WP|WM|stage|齒位|[1-8])(\.\d+)?$/.test(c));
  const chartOpts = h("div", { class: "row small" },
    "分組比較 ", h("select", { onchange: (e) => { u.compare = e.target.value; markDirty(); renderTab(); } }, [h("option", { value: "" }, "（不分組）"), ...cmpCols.map((c) => h("option", { selected: gcol === c }, c))]),
    gcol ? h("span", {}, "　每組至少 ", h("input", { type: "number", min: 1, value: u.minN || 1, style: { width: "56px" }, onchange: (e) => { u.minN = e.target.value; markDirty(); renderTab(); } }), " 件") : null,
    h("label", {}, h("input", { type: "checkbox", checked: !!u.ageLabels, onchange: (e) => { u.ageLabels = e.target.checked; markDirty(); renderTab(); } }), " 類別標籤加上年齡"),
    h("span", { class: "muted" }, "折線圖＝存活曲線（由出生 100% 降到 0%）；長條圖＝各年齡組死亡率。"));
  const lab = (c) => (u.ageLabels ? `${c} (${L.ages[c]})` : c);
  const sets = gcol ? groupsCmp.map((x) => ({ name: `${x.g}（n=${x.summ.n}）`, summ: x.summ })) : [{ name: `${sp}（n=${summ.n}）`, summ }];
  const survChart = chartCard("age_surv", (type) => {
    if (type === "line") return { type, title: `${sp} 存活曲線（${u.sys}）`, yLabel: "存活率", valueFormat: "pct", yFixed: [0, 1],
      categories: ["出生", ...L.order.map(lab)], series: sets.map((x) => ({ name: x.name, values: [1, ...x.summ.rows.map((r) => r.存活率)] })) };
    return { type, title: `${sp} 死亡率（${u.sys}）`, yLabel: "死亡率", valueFormat: "pct", categories: L.order.map(lab), series: sets.map((x) => ({ name: x.name, values: x.summ.rows.map((r) => r.死亡率) })) };
  }, { types: ["line", "bar"], defaults: { pointSize: 4, lineWidth: 2, fill: false, legend: "right" } });
  const cmpTbl = gcol && groupsCmp.length ? makeTable([{ k: "組" }, { k: "n", f: "int" }, ...L.order.flatMap((c) => [{ k: "m" + c, label: `${c} 死亡率`, f: "pct" }, { k: "s" + c, label: `${c} 存活率`, f: "pct" }])],
    groupsCmp.map((x) => { const o = { 組: x.g, n: x.summ.n }; x.summ.rows.forEach((r) => { o["m" + r.年齡組] = r.死亡率; o["s" + r.年齡組] = r.存活率; }); return o; }),
    { name: `${S.site}_年齡組分組_${u.sys}_${sp}`, title: `依「${gcol}」分組`, maxHeight: "300px" }) : null;

  // --- 年齡結構表
  const sysCol = (sys) => ({ k: sys, label: sys === "Specific" ? "Specific" : sys.replace("Simplified-", "Simp-"), render: (r) => (r[sys] ? (r["_" + sys].note ? h("span", { title: r["_" + sys].note }, r[sys] + " *") : r[sys]) : h("span", { class: "muted", title: r["_" + sys].note }, "—")),
    text: (r) => r[sys] || "", cls: (r) => (sys === u.sys ? "star" : "") });
  const tbl = makeTable([{ k: "流水號" }, { k: "骨骼" }, { k: "上下顎" }, ...Core.MAIN_TEETH.map((k) => ({ k })), sysCol("Specific"), sysCol("Simplified-A"), sysCol("Simplified-B"),
    { k: "判定說明", render: (r) => r["_" + u.sys].note || "", text: (r) => r["_" + u.sys].note || "" }, { k: "其他齒位" }, { k: "側別" }, { k: "來源" }, { k: "檢查" }, { k: "原表列號" }], rows,
  { name: `${S.site}_年齡_${sp}`, title: `年齡結構（${rows.length} 列；— ＝該系統無法判定，滑鼠移上可看原因；* ＝牙齒間不完全一致）`, rowClass: (r) => (r.檢查 ? "warn" : "") });

  // --- 磨耗等級分布（原寫法）
  const stages = new Map(); const counts = {};
  for (const t of Core.MAIN_TEETH) counts[t] = new Map();
  for (const r of rows) for (const t of Core.MAIN_TEETH) for (const v of String(r[t] || "").split("; ").filter(Boolean)) { stages.set(v, 1); counts[t].set(v, (counts[t].get(v) || 0) + 1); }
  const stageList = [...stages.keys()].sort((a, b) => Core.wearRank(a) - Core.wearRank(b) || a.localeCompare(b));
  const dist = stageList.map((s) => { const o = { 磨耗: s }; Core.MAIN_TEETH.forEach((t) => (o[t] = counts[t].get(s) || 0)); return o; });
  const distTot = { 磨耗: "合計" }; Core.MAIN_TEETH.forEach((t) => (distTot[t] = Core.sum(dist, (x) => x[t])));
  const distTbl = makeTable([{ k: "磨耗" }, ...Core.MAIN_TEETH.map((k) => ({ k, f: "int" }))], dist, { total: distTot, name: `${S.site}_磨耗分布_${sp}`, title: "各齒位磨耗等級件數（原寫法）", maxHeight: "380px" });
  const distOpts = h("div", { class: "row small" }, "齒位 ", Core.MAIN_TEETH.map((t) => h("label", {}, h("input", { type: "checkbox", checked: u.teeth.includes(t), onchange: (e) => {
    u.teeth = e.target.checked ? Core.MAIN_TEETH.filter((x) => u.teeth.includes(x) || x === t) : u.teeth.filter((x) => x !== t); markDirty(); renderTab(); } }), " " + t)),
  "　數值 ", h("select", { onchange: (e) => { u.value = e.target.value; markDirty(); renderTab(); } }, ["件數", "齒位內百分比"].map((v) => h("option", { selected: u.value === v }, v))));
  const distChart = chartCard("age", (type) => ({ type, categories: stageList, valueFormat: u.value === "件數" ? "int" : "pct", title: `${sp} 牙齒磨耗等級`, xLabel: "磨耗等級", yLabel: u.value,
    series: u.teeth.map((t) => ({ name: t, values: dist.map((x) => (u.value === "件數" ? x[t] : distTot[t] ? x[t] / distTot[t] : 0)) })) }), { types: ["bar", "line", "hbar"] });

  const miss = res.missing.length ? h("details", {}, h("summary", {}, `可能遺漏：備註看起來有磨耗、但長表與原表齒位欄都沒有的紀錄（${res.missing.length}）`),
    makeTable([{ k: "原表列號" }, { k: "流水號" }, { k: "骨骼" }, { k: "側" }, { k: "備註" }], res.missing, { name: `${S.site}_年齡可能遺漏_${sp}`, maxHeight: "300px" })) : null;
  const note = h("div", { class: "muted" }, `來源：${S.parsedDir ? "mandible／tooth 長表＋" : ""}原表「齒位／stage」欄。年齡組依 Lemoine et al. (2014) Table 3（dP4、P4、M1、M2、M3），年齡估計依 Table 7。`);
  body.append(card(null, top, note),
    h("div", { class: "split" }, card(null, wtbl, wnote), card(null, stbl, snote)),
    card("存活曲線／死亡率", chartOpts, cmpEditor, survChart, cmpTbl),
    card(null, tbl, miss),
    card("磨耗等級分布", h("details", {}, h("summary", {}, "展開表格"), distTbl), distOpts, distChart));
};

// ===== 表面痕 =====
RENDER.marks = (body) => {
  const u = ui("marks");
  const top = h("div", { class: "row" }, speciesSelect("marks", "Sus"));
  const sp = u.sp; u.item ||= "切割"; u.chart ||= "cats"; u.hideZero ??= true;
  top.append(segs(Core.MARK_ITEMS.map((x) => [x, x]), u.item, (v) => { u.item = v; markDirty(); renderTab(); }));
  const map = (S.settings.markMap[u.item] ||= {});
  const res = Core.marks(S.view, sp, u.item, map);
  const known = Core.uniq(res.rawValues.map((x) => (x.原始寫法 in map ? map[x.原始寫法] : x.原始寫法)).filter(Boolean));
  const dl = h("datalist", { id: "markCats" }, known.map((k) => h("option", { value: k })));
  const mapTbl = makeTable([{ k: "原始寫法" }, { k: "筆數", f: "int" }, { k: "數量加總", f: "int" },
    { k: "歸入", render: (r) => h("input", { type: "text", list: "markCats", value: r.原始寫法 in map ? map[r.原始寫法] : r.原始寫法, style: { width: "120px" }, onchange: (e) => {
      const v = e.target.value.trim(); if (v === r.原始寫法) delete map[r.原始寫法]; else map[r.原始寫法] = v; markDirty(); renderTab(); } }),
    text: (r) => (r.原始寫法 in map ? map[r.原始寫法] : r.原始寫法) }],
  res.rawValues, { name: `${S.site}_${u.item}寫法_${sp}`, title: `${u.item}：原始寫法歸類`, maxHeight: "420px", rowClass: (r) => (r.原始寫法 in map ? "mod" : "") });
  const cols = [{ k: "骨骼部位" }, ...res.cols.map((c) => ({ k: c, f: "int" })), { k: "有紀錄合計", f: "int" }, { k: "無紀錄", f: "int" }, { k: "總數", label: "總數(NISP)", f: "int" }, { k: "有紀錄百分比", f: "pct" }];
  const tbl = makeTable(cols, res.table, { total: res.total, name: `${S.site}_${u.item}_${sp}`, title: `${sp} ${u.item}（數量加總）` });
  const chartOpts = h("div", { class: "row small" }, "圖表內容 ", h("select", { onchange: (e) => { u.chart = e.target.value; markDirty(); renderTab(); } },
    [["cats", "各類別數量"], ["catspct", "各類別佔該部位百分比"], ["pct", "有紀錄百分比"]].map(([v, l]) => h("option", { value: v, selected: u.chart === v }, l))),
  h("label", {}, h("input", { type: "checkbox", checked: u.hideZero, onchange: (e) => { u.hideZero = e.target.checked; markDirty(); renderTab(); } }), " 不顯示沒有紀錄的部位"));
  const ch = chartCard("marks_" + u.item, (type) => {
    const t = u.hideZero ? res.table.filter((x) => x.有紀錄合計 > 0) : res.table;
    if (u.chart === "pct") return { type, categories: t.map((x) => x.骨骼部位), series: [{ name: "有紀錄百分比", values: t.map((x) => x.有紀錄百分比) }], valueFormat: "pct" };
    return { type, categories: t.map((x) => x.骨骼部位), valueFormat: u.chart === "cats" ? "int" : "pct",
      series: res.cols.map((c) => ({ name: c, values: t.map((x) => (u.chart === "cats" ? x[c] : x.總數 ? x[c] / x.總數 : 0)) })) };
  }, { types: ["bar", "hbar"], defaults: { title: `${sp} ${u.item}`, yLabel: "NISP", stacked: true } });
  body.append(card(null, top, h("div", { class: "muted" }, "空白與「-」＝無紀錄；v／V 合併為 v。在左側「歸入」欄可把不同寫法歸成同一類（例如把 Br+B 歸入 Br）；清空＝視為無紀錄。")),
    h("div", { class: "split" }, card(null, mapTbl, dl), card(null, tbl)), card("圖表", chartOpts, ch));
};

// ===== 臼齒測量 =====
RENDER.molars = async (body) => {
  const u = ui("molars");
  const top = h("div", { class: "row" }, speciesSelect("molars", "Sus"));
  const sp = u.sp; u.tooth ||= "M1"; u.jaw ||= "全部"; u.x ||= "GL"; u.y ||= "WA"; u.group ||= "上下顎";
  body.append(card(null, top, h("div", { class: "muted" }, "讀取長表…")));
  const longs = await longsFor(sp);
  body.innerHTML = "";
  const res = Core.molars(S.view, S.cfg, sp, longs);
  const ex = S.settings.molarExclude;
  const key = (r) => `${r.流水號}|${r.齒位}`;
  const isUnsure = (r) => !(r.齒位 in Core.MOLAR_ITEMS) && /M/.test(r.齒位);
  top.append(segs([["M1", "M1"], ["M2", "M2"], ["M3", "M3"], ["unsure", "齒位不確定"]], u.tooth, (v) => { u.tooth = v; markDirty(); renderTab(); }),
    h("span", { class: "ctl" }, "上下顎 ", h("select", { onchange: (e) => { u.jaw = e.target.value; markDirty(); renderTab(); } }, ["全部", "下顎", "上顎", "不明"].map((v) => h("option", { selected: u.jaw === v }, v)))));
  const items = u.tooth === "unsure" ? Core.ALL_MI : Core.MOLAR_ITEMS[u.tooth];
  let rows = res.records.filter((r) => (u.tooth === "unsure" ? isUnsure(r) : r.齒位 === u.tooth) && items.some((i) => r[i] !== null && r[i] !== undefined));
  rows = rows.filter((r) => u.jaw === "全部" || (r.上下顎 || "不明") === u.jaw);
  const used = rows.filter((r) => !ex[key(r)]);
  const tbl = makeTable([
    { k: "排除", render: (r) => h("input", { type: "checkbox", checked: !!ex[key(r)], onchange: (e) => { if (e.target.checked) ex[key(r)] = true; else delete ex[key(r)]; markDirty(); renderTab(); } }), text: (r) => (ex[key(r)] ? "排除" : "") },
    { k: "流水號" }, ...(u.tooth === "unsure" ? [{ k: "齒位" }] : []), { k: "上下顎" }, { k: "側別" }, ...items.map((k) => ({ k, f: "num" })), { k: "磨耗" }, { k: "來源" }, { k: "檢查" }, { k: "坑號" }, { k: "層位" }, { k: "文化層" }, { k: "原表列號" }],
  rows, { name: `${S.site}_${sp}_${u.tooth}`, title: `${sp} ${u.tooth === "unsure" ? "齒位不確定" : u.tooth}（${used.length}/${rows.length} 顆採用）`,
    rowClass: (r) => [ex[key(r)] ? "off" : "", r._outlier ? "warn" : ""].join(" ") });
  // 描述統計（不含排除）
  const stats = [];
  for (const jaw of ["下顎", "上顎", ""]) for (const it of items) {
    const d = Core.describe(used.filter((r) => r.上下顎 === jaw).map((r) => r[it]));
    if (d) stats.push({ 上下顎: jaw || "不明", 項目: it, ...d });
  }
  const statTbl = makeTable([{ k: "上下顎" }, { k: "項目" }, { k: "n", f: "int" }, { k: "平均", f: "num" }, { k: "標準差", f: "num" }, { k: "最小", f: "num" }, { k: "最大", f: "num" }], stats, { name: `${S.site}_${sp}_${u.tooth}_統計`, title: "描述統計（不含排除者）" });
  const groupOf = (r) => (u.group === "不分組" ? "全部" : String(r[u.group] || "（空白）"));
  const chartOpts = h("div", { class: "row small" },
    "X ", h("select", { onchange: (e) => { u.x = e.target.value; markDirty(); renderTab(); } }, items.map((v) => h("option", { selected: u.x === v }, v))),
    "Y ", h("select", { onchange: (e) => { u.y = e.target.value; markDirty(); renderTab(); } }, items.map((v) => h("option", { selected: u.y === v }, v))),
    "分組 ", h("select", { onchange: (e) => { u.group = e.target.value; markDirty(); renderTab(); } }, ["上下顎", "文化層", "磨耗", "來源", "不分組"].map((v) => h("option", { selected: u.group === v }, v))),
    h("span", { class: "muted" }, "（直方圖使用 X 項目）"));
  const ch = chartCard("molars", (type) => {
    const gs = Core.groupBy(used, groupOf);
    const lab = { title: `${sp} ${u.tooth === "unsure" ? "齒位不確定" : u.tooth}`, xLabel: `${u.x} (mm)`, yLabel: type === "hist" ? "件數" : `${u.y} (mm)` };
    if (type === "hist") return { ...lab, type, series: [...gs].map(([g, rs]) => ({ name: g, values: rs.map((r) => r[u.x]).filter((v) => v !== null && v !== undefined) })) };
    return { ...lab, type: "scatter", series: [...gs].map(([g, rs]) => ({ name: g, points: rs.filter((r) => r[u.x] != null && r[u.y] != null).map((r) => ({ x: r[u.x], y: r[u.y], label: r.流水號 })) })) };
  }, { types: ["scatter", "hist"], defaults: { fillOpacity: 0.6, strokeWidth: 1, legend: "right" } });
  const other = res.other.length ? h("details", {}, h("summary", {}, `其他測量代號（L、B、MWA…，未自動對應；${res.other.length}）`),
    makeTable([{ k: "流水號" }, { k: "骨骼" }, { k: "上下顎" }, { k: "側別" }, { k: "齒位" }, { k: "測量" }, { k: "磨耗" }, { k: "來源" }], res.other, { name: `${S.site}_${sp}_其他測量代號`, maxHeight: "260px" })) : null;
  body.append(card(null, top, h("div", { class: "muted" }, "主要來源為原表兩組「齒位、GL、WA、WP、WM、stage」欄，長表只補缺。橘色＝疑似離群（偏離中位數 25% 以上）；勾「排除」後不進入統計與圖表（儲存設定後保留）。")),
    h("div", { class: "split" }, card(null, tbl, other), card(null, statTbl)), card("圖表", chartOpts, ch));
};

// ===== 說明 =====
RENDER.help = (body) => {
  body.append(card("使用說明", h("div", { class: "helptext", html: `
<ol>
<li>按「選擇『獸骨資料整理』資料夾」，瀏覽器詢問權限時選「允許編輯」，設定與圖檔才能直接存回資料夾。</li>
<li>選遺址與清單後按「載入」。左側「資料篩選」可依文化層等欄位排除部分紀錄，所有分頁會立即重算。</li>
<li>各分頁的調整（物種合併與順序、MNI 採計部位、表面痕寫法歸類、性別判定修改、臼齒排除、圖表樣式）按左下「儲存設定到『分析結果』」後才會保存。</li>
<li>年齡分頁依 Lemoine et al. (2014) 把每列（流水號＋上下顎）判定為 Specific（1–10）、Simplified-A（A–G）、Simplified-B（I–IV）年齡組，並畫存活曲線；磨耗寫法先在左側對照表轉成分數。</li>
<li>圖表右側可改顏色、填滿圖樣（斜線、點點、交叉…）與點形狀；「黑白印刷樣式」一鍵改成黑灰色＋不同圖樣。</li>
<li>表格可「複製表格」直接貼到試算表，或「匯出 CSV」；圖表可「匯出圖檔」，PNG 可設定公分＋DPI（會寫入 DPI 資訊，置入 Word 時尺寸正確）或像素＋倍率，也可存 SVG 向量檔。</li>
</ol>
<h3>設定檔（存在 遺址/分析結果/）</h3>
<ul>
<li><b>欄位對照.csv</b>：清單欄名 → 標準欄位（例如 Qty → 數量）。</li>
<li><b>物種對照表.csv</b>：合併名稱、排序、納入動物相。</li>
<li><b>MNI部位設定.csv</b>：各物種與預設不同的 MNI 採計部位（納入 Y/N）。</li>
<li><b>表面痕歸類.csv</b>：表面痕原始寫法 → 歸入類別。</li>
<li><b>磨耗對照.csv</b>：磨耗原始寫法 → Lemoine 分數。</li>
<li><b>網頁工具設定.json</b>：篩選、性別修改、臼齒排除、圖表樣式等。</li>
</ul>
<p class="muted">共用設定（所有遺址）：程式/設定/骨骼分類.csv（骨骼別名、區域、順序、預設 MNI 採計）、物種別名.csv（中文名、反芻類）、側別對照.csv。沒有這些檔案時使用內建預設。平板或唯讀模式下，設定存在這台裝置的瀏覽器中，可另外下載備份。</p>
<p class="muted">版本 ${APP_VERSION}。所有計算都在這台裝置的瀏覽器中進行，資料不會上傳。</p>
<p class="muted">骨骼名稱別名、骨骼區域與順序、預設 MNI 採計部位在 程式/設定/骨骼分類.csv；中文物種名與反芻類在 程式/設定/物種別名.csv。計算規則與 程式/zooarch/*.py 相同。</p>` })));
};

// 測試介面
window.ZA = { S, Core, Charts, MemFS, openRoot, loadSite, renderTab };
