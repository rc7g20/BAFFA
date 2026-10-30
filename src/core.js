// ============================================================================
// 計算核心：讀檔、名稱正規化、各項分析的計算規則（不含介面）
// ============================================================================
"use strict";
const Core = (() => {

  // ---------------------------------------------------------------- CSV
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(f); rows.push(row); row = []; f = "";
      } else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return fromMatrix(rows.map((r, i) => ({ r: i + 1, cells: r })));
  }
  /** 試算表列（[{r:列號, cells:[...]}]）→ {header, rows}；第一個非空列為標題 */
  function fromMatrix(mrows) {
    const blank = (r) => !r.cells.some((x) => x !== undefined && x !== null && String(x).trim() !== "");
    const hi = mrows.findIndex((r) => !blank(r));
    if (hi < 0) return { header: [], rows: [] };
    // 重複欄名比照 pandas：第二個「齒位」→「齒位.1」；空白欄名 → 欄N
    const seen = {};
    const hc = mrows[hi].cells;
    const header = [];
    for (let j = 0; j < hc.length; j++) {
      let hd = String(hc[j] ?? "").replace(/\s+/g, " ").trim();
      if (!hd) hd = `欄${j + 1}`;
      if (seen[hd] === undefined) { seen[hd] = 0; header.push(hd); }
      else { seen[hd] += 1; header.push(`${hd}.${seen[hd]}`); }
    }
    const out = [];
    for (let k = hi + 1; k < mrows.length; k++) {
      const r = mrows[k];
      if (blank(r)) continue;
      const o = { _列號: r.r };
      header.forEach((hd, j) => { o[hd] = String(r.cells[j] ?? "").trim(); });
      out.push(o);
    }
    return { header, rows: out };
  }

  // ---------------------------------------------------------------- 欄位對照
  // 標準欄位 → 可能的原始欄名（不分大小寫）；required 為必要欄位
  const FIELDS = [
    { k: "物種", req: true, syn: ["物種", "種", "species", "taxon", "taxa"] },
    { k: "骨骼", req: true, syn: ["骨骼", "骨骼部位", "部位", "element", "bone", "skeletal element"] },
    { k: "數量", req: false, syn: ["數量", "qty", "nisp", "件數", "count", "n", "quantity"] },
    { k: "側", req: false, syn: ["側", "側別", "side"] },
    { k: "流水號", req: false, syn: ["流水號", "編號", "標本號", "id", "no", "no.", "specimen"] },
    { k: "備註", req: false, syn: ["備註", "note", "notes", "remark", "remarks", "說明", "comment", "comments"] },
    { k: "切割", req: false, syn: ["切割", "切割痕", "cut", "cutmark", "cut marks", "butchery"] },
    { k: "燒炙", req: false, syn: ["燒炙", "燒痕", "burn", "burning", "burnt"] },
    { k: "啃咬", req: false, syn: ["啃咬", "啃咬痕", "gnaw", "gnawing", "gnawed"] },
    { k: "重量", req: false, syn: ["重量", "weight", "wt", "重量(g)", "重量（g）", "weight (g)"] },
    { k: "性別", req: false, syn: ["性別", "sex"] },
    { k: "文化層", req: false, syn: ["文化層", "culture", "phase", "period"] },
    { k: "綱", req: false, syn: ["綱", "class"] },
    { k: "目", req: false, syn: ["目", "order"] },
    { k: "科", req: false, syn: ["科", "family"] },
    { k: "屬", req: false, syn: ["屬", "genus"] },
  ];
  const TAXON_LEVELS = ["綱", "目", "科", "屬", "物種"];
  /** 回傳 {標準欄位: 原始欄名 | ""} */
  function detectFields(header, saved = {}) {
    const low = new Map(header.map((x) => [String(x).toLowerCase().trim(), x]));
    const out = {};
    for (const f of FIELDS) {
      if (saved[f.k] !== undefined && (saved[f.k] === "" || header.includes(saved[f.k]))) { out[f.k] = saved[f.k]; continue; }
      out[f.k] = "";
      for (const s of f.syn) if (low.has(s)) { out[f.k] = low.get(s); break; }
    }
    return out;
  }
  /** 依對照在每列加上標準欄位（保留原欄位）；回傳缺少的必要欄位 */
  function applyFields(rows, map) {
    for (const [std, src] of Object.entries(map)) {
      if (!src || src === std) continue;
      for (const r of rows) r[std] = r[src];
    }
    return FIELDS.filter((f) => f.req && !map[f.k]).map((f) => f.k);
  }

  function toCSV(header, rows) {
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return "﻿" + [header.map(esc).join(",")].concat(rows.map((r) =>
      header.map((h) => esc(Array.isArray(r) ? r[header.indexOf(h)] : r[h])).join(","))).join("\r\n") + "\r\n";
  }

  // ---------------------------------------------------------------- 小工具
  const groupBy = (arr, keyFn) => {
    const m = new Map();
    for (const x of arr) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return m;
  };
  const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + f(x), 0);
  const uniq = (arr) => [...new Set(arr)];

  function qtyOf(v) {
    const m = /^(\d+(?:\.\d+)?)\+?$/.exec(String(v).trim());
    return m ? parseFloat(m[1]) : null;
  }

  // ---------------------------------------------------------------- 設定
  const DEFAULT_ELEMENTS = `標準名稱,別名,骨骼區域,部位順序,側別MNI
skull,頭骨;顱骨,顱部,1,N
cranium,,顱部,2,N
maxilla,上顎;上頜,顱部,3,Y
premaxilla,,顱部,4,Y
nasal,,顱部,5,N
zygomatic,,顱部,6,N
mandible,下顎;下頜,顱部,7,Y
hyoid,,顱部,8,N
tooth,牙齒,顱部,9,N
antler,鹿角,顱部,10,N
atlas,,軀幹,1,N
axis,,軀幹,2,N
cervical,cervical vertebra;頸椎,軀幹,3,N
thoracic,thoracic vertebra;胸椎,軀幹,4,N
lumbar,lumbar vertebra;腰椎,軀幹,5,N
sacrum,薦椎;synsacrum,軀幹,6,N
caudal,caudal vertebra;尾椎;尾骨,軀幹,7,N
vertebrae,vertebra;脊椎,軀幹,8,N
rib,肋骨,軀幹,9,N
sternum,胸骨,軀幹,10,N
pelvis,盆骨;骨盆;innominate;os coxae,軀幹,11,Y
ilium,,軀幹,12,Y
ischium,,軀幹,13,Y
pubis,,軀幹,14,Y
scapula,肩胛骨,近端多肉骨骼,1,Y
humerus,肱骨,近端多肉骨骼,2,Y
radius,橈骨,近端多肉骨骼,3,Y
ulna,尺骨,近端多肉骨骼,4,Y
radio-ulna,radioulna;radius+ulna;radius & ulna;radius and ulna,近端多肉骨骼,5,Y
femur,股骨,近端多肉骨骼,6,Y
patella,髕骨,近端多肉骨骼,7,Y
tibia,脛骨,近端多肉骨骼,8,Y
fibula,腓骨,近端多肉骨骼,9,Y
tibio-fibula,tibiofibula,近端多肉骨骼,10,Y
coracoid,,近端多肉骨骼,11,Y
clavicle,,近端多肉骨骼,12,N
wishbone,furcula,近端多肉骨骼,13,N
tibiotarsus,,近端多肉骨骼,14,Y
carpus,腕骨,遠端少肉骨骼,1,N
tarsus,跗骨,遠端少肉骨骼,2,N
calcaneus,跟骨,遠端少肉骨骼,3,Y
astragalus,距骨;talus,遠端少肉骨骼,4,Y
central tarsal,centrotarsal;naviculocuboid;os centrotarsale;centrotarsale;navicular-cuboid,遠端少肉骨骼,5,Y
os malleolare,malleolus,遠端少肉骨骼,6,Y
MC,metacarpal;metacarpus;掌骨,遠端少肉骨骼,7,反芻類
MT,metatarsal;metatarsus;蹠骨,遠端少肉骨骼,8,反芻類
MP,metapodial;掌蹠骨,遠端少肉骨骼,9,N
carpometacarpus,,遠端少肉骨骼,10,Y
tarsometatarsus,,遠端少肉骨骼,11,Y
phalanx,phalanx*;指骨;趾骨;phalange;phalanges;phalanx 1;phalanx 2;phalanx 3;ph1;ph2;ph3;第一指骨;第二指骨;第三指骨,遠端少肉骨骼,12,N
sesamoid,,遠端少肉骨骼,13,N
LB,long bone;long bone fragment;long bone fragments;長骨,其他,1,N
UN,unknown;un;fragment;fragments;frag;frags;indet;indet.;unidentified;不明;碎片,其他,2,N
`;
  const DEFAULT_ALIASES = `資料名稱,中文名,反芻類
Sus,豬,N
cervus,梅花鹿,Y
muntjac,羌,Y
獐,獐,Y
小鹿,小型鹿,Y
偶蹄目,偶蹄目,N
lupus,狗,N
Canis,狗,N
犬,狗,N
犬屬,狗,N
野豬屬,豬,N
Sus scrofa,豬,N
臺灣梅花鹿,梅花鹿,Y
台灣梅花鹿,梅花鹿,Y
Cervus nippon,梅花鹿,Y
鹿屬,梅花鹿,Y
山羌,羌,Y
麂屬,羌,Y
獐屬,獐,Y
水鹿屬,水鹿,Y
`;
  const REGION_ORDER = ["顱部", "軀幹", "近端多肉骨骼", "遠端少肉骨骼", "其他"];

  const DEFAULT_SIDES = `原始寫法,歸入
Indet.,UN
Indet,UN
Indeterminate,UN
Unknown,UN
R/L,UN
L/R,UN
R or L,UN
N/A,-
NA,-
n/a,-
`;
  function makeConfig(elementsCSV, aliasesCSV, sidesCSV) {
    const et = parseCSV(elementsCSV || DEFAULT_ELEMENTS).rows;
    const al = parseCSV(aliasesCSV || DEFAULT_ALIASES).rows;
    const idx = {}, info = {};
    for (const r of et) {
      idx[r.標準名稱.toLowerCase()] = r.標準名稱;
      for (const a of [r.標準名稱, ...String(r.別名 || "").split(";")]) {
        const k = a.trim().toLowerCase(); if (!k) continue;
        idx[k] = r.標準名稱; idx[k.replace(/[\s\-_]+/g, "")] = r.標準名稱;
      }
      info[r.標準名稱] = { region: r.骨骼區域, order: Number(r.部位順序), mni: r.側別MNI };
    }
    const sideMap = {};
    for (const r of parseCSV(DEFAULT_SIDES).rows.concat(sidesCSV ? parseCSV(sidesCSV).rows : [])) sideMap[String(r.原始寫法).trim().toUpperCase()] = r.歸入;
    return {
      elements: et, aliases: al, idx, info, sideMap,
      ruminants: new Set(al.filter((r) => String(r.反芻類).toUpperCase() === "Y").map((r) => r.資料名稱)),
    };
  }

  const VERT_KEYS = [["cervical", /cervical|頸椎/i], ["thoracic", /thoracic|胸椎/i], ["lumbar", /lumbar|腰椎/i],
    ["sacrum", /sacr|薦椎/i], ["caudal", /caudal|尾椎/i]];

  /** 依序嘗試：原樣 → 去掉 *? → 去掉括號註記 → 去掉空白與連字號 → 去掉結尾數字（Phalange 1） */
  function lookupElement(cfg, name) {
    const s = String(name || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!s) return "UN";
    const tries = [s, s.replace(/[*?？]+$/, "").trim()];
    tries.push(tries[1].replace(/\s*[(（][^)）]*[)）]\s*/g, " ").trim());
    tries.push(tries[2].replace(/[\s\-_]+/g, ""));
    tries.push(tries[2].replace(/\s*\d+$/, "").trim(), tries[3].replace(/\d+$/, ""));
    tries.push(tries[4].replace(/s$/, ""), tries[4].replace(/es$/, ""));
    tries.push(tries[2].replace(/\s+bones?$/, "").trim(), tries[2].replace(/\s+/g, ""));
    for (const t of tries) if (t && cfg.idx[t] !== undefined) return cfg.idx[t];
    return null;
  }
  function isKnownElement(cfg, name) { return lookupElement(cfg, name) !== null; }
  function normalizeElement(cfg, name, note = "") {
    const s = String(name || "").replace(/\s+/g, " ").trim();
    const std = lookupElement(cfg, s);
    if (std === null) return s || "UN";
    if (std === "vertebrae" && note) {
      const hits = VERT_KEYS.filter(([, p]) => p.test(note)).map(([k]) => k);
      if (hits.length === 1) return hits[0];
    }
    return std;
  }
  function elementInfo(cfg, std) {
    const i = cfg.info[std];
    if (!i) return { region: "其他", regionIdx: 4, order: 999, mni: "N" };
    const ri = REGION_ORDER.indexOf(i.region);
    return { region: i.region, regionIdx: ri < 0 ? 99 : ri, order: i.order, mni: i.mni };
  }

  function normalizeSide(v, cfg = null) {
    const s = String(v ?? "").trim();
    if (cfg && cfg.sideMap && cfg.sideMap[s.toUpperCase()] !== undefined) return cfg.sideMap[s.toUpperCase()];
    const u = s.toUpperCase().replace(/[*?？]+$/, "").trim();
    if (["L", "LEFT", "左"].includes(u)) return "L";
    if (["R", "RIGHT", "右"].includes(u)) return "R";
    if (["AX", "AXIAL", "中"].includes(u)) return "Ax";
    if (["", "-", "—"].includes(u)) return "-";
    if (["UN", "?", "？"].includes(u)) return "UN";
    return s;
  }
  const SIDE_ORDER = { L: 0, R: 1, Ax: 2, "-": 3, UN: 4 };
  const sideIdx = (s) => (s in SIDE_ORDER ? SIDE_ORDER[s] : 5);

  const ZONE_COLS = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const zonesOf = (r) => ZONE_COLS.filter((c) => c in r && !["", "-"].includes(String(r[c]).trim()));

  // ---------------------------------------------------------------- 物種對照
  const SIZE_PAT = /sze|size/i;
  const NON_FAUNA = new Set(["陶", "石", "pottery", "stone"]);
  const NON_TAXON = /sze|size|^un$|^unknown$|^不明$|^indet/i;
  const IDENT_EXCL = /sze|size|^UN$|^unknown$|^不明$|^indet/i;

  /** 物種設定：groups = [{name, order, include, raws:[{raw,n,nisp}]}] */
  function defaultSpeciesGroups(rows, existing = null, col = "物種") {
    const cnt = new Map(), nisp = new Map();
    for (const r of rows) {
      const v = r[col] ?? "";
      cnt.set(v, (cnt.get(v) || 0) + 1);
      nisp.set(v, (nisp.get(v) || 0) + (qtyOf(r.數量) ?? 1));
    }
    const groups = existing ? existing.map((g) => ({ ...g, raws: g.raws.map((x) => ({ ...x })) })) : [];
    const known = new Map();
    groups.forEach((g) => g.raws.forEach((x) => known.set(x.raw, g)));
    // 已知名稱：更新筆數
    for (const g of groups) for (const x of g.raws) { x.n = cnt.get(x.raw) || 0; x.nisp = nisp.get(x.raw) || 0; }
    const newNames = [...cnt.keys()].filter((n) => !known.has(n));
    if (!newNames.length) return { groups, added: [] };
    const byLow = groupBy(newNames, (n) => n.toLowerCase());
    const fresh = [];
    for (const [low, names] of byLow) {
      // 若已有同小寫的群組，併入
      const exist = groups.find((g) => g.name.toLowerCase() === low || g.raws.some((x) => x.raw.toLowerCase() === low));
      const raws = names.map((n) => ({ raw: n, n: cnt.get(n), nisp: nisp.get(n) })).sort((a, b) => b.n - a.n);
      if (exist) { exist.raws.push(...raws); continue; }
      const cat = /^(un|unknown|unid|不明|indet\.?)$/.test(low) ? 3 : SIZE_PAT.test(low) ? 2 : NON_FAUNA.has(low) ? 4 : 1;
      fresh.push({ name: raws[0].raw, include: cat !== 4, raws, _cat: cat, _tot: sum(raws, (x) => x.nisp) });
    }
    fresh.sort((a, b) => a._cat - b._cat || b._tot - a._tot || a.name.localeCompare(b.name));
    let start = groups.length ? Math.max(...groups.map((g) => g.order)) + 1 : 1;
    for (const g of fresh) { g.order = start++; delete g._cat; delete g._tot; groups.push(g); }
    return { groups, added: newNames };
  }

  function groupsFromCSV(text) {
    const rows = parseCSV(text).rows;
    const m = new Map();
    for (const r of rows) {
      const name = r.合併名稱 || r.原始名稱;
      if (!m.has(name)) m.set(name, { name, order: Number(r.排序) || 999, include: String(r.納入動物相 || "Y").toUpperCase() !== "N", raws: [] });
      m.get(name).raws.push({ raw: r.原始名稱, n: Number(r.筆數) || 0, nisp: 0 });
    }
    return [...m.values()];
  }
  function groupsToCSV(groups) {
    const out = [];
    [...groups].sort((a, b) => a.order - b.order).forEach((g) => g.raws.forEach((x) =>
      out.push({ 原始名稱: x.raw, 合併名稱: g.name, 筆數: x.n, 排序: g.order, 納入動物相: g.include ? "Y" : "N" })));
    return toCSV(["原始名稱", "合併名稱", "筆數", "排序", "納入動物相"], out);
  }

  function resolveSpecies(cfg, groups, name) {
    const hit = cfg.aliases.find((a) => name === a.中文名 || name === a.資料名稱);
    if (hit) {
      const cands = cfg.aliases.filter((a) => a.中文名 === hit.中文名).map((a) => a.資料名稱);
      for (const c of [name, ...cands]) {
        const g = groups.find((g) => g.name === c) || groups.find((g) => g.raws.some((x) => x.raw === c));
        if (g) return g.name;
      }
    }
    const g = groups.find((g) => g.name === name) || groups.find((g) => g.name.toLowerCase() === String(name).toLowerCase())
      || groups.find((g) => g.raws.some((x) => x.raw.toLowerCase() === String(name).toLowerCase()));
    return g ? g.name : null;
  }

  // ---------------------------------------------------------------- 準備資料
  /** 為每列加上計算欄位；log 收集警示 */
  function prepare(rows, cfg, groups) {
    const log = [];
    const map = new Map(); const ord = new Map(); const inc = new Map();
    for (const g of groups) for (const x of g.raws) { map.set(x.raw, g.name); ord.set(g.name, g.order); inc.set(g.name, g.include); }
    for (const r of rows) {
      const q = qtyOf(r.數量);
      if (q === null) log.push({ 類型: "數量非數字", 流水號: r.流水號, 原表列號: r._列號, 內容: `「${r.數量}」視為 1` });
      r._qty = q ?? 1;
      r._sp = map.get(r.物種) ?? r.物種;
      r._spOrder = ord.get(r._sp) ?? 9999;
      r._spInclude = inc.get(r._sp) ?? true;
      r._el = normalizeElement(cfg, r.骨骼, r.備註 || "");
      const i = elementInfo(cfg, r._el);
      r._region = i.region; r._regionIdx = i.regionIdx; r._elIdx = i.order; r._mni = i.mni;
      r._side = normalizeSide(r.側, cfg);
    }
    return log;
  }

  const spOrderMap = (groups) => new Map(groups.map((g) => [g.name, g.order]));

  // ---------------------------------------------------------------- 動物相
  /** col：計算的分類欄（預設物種）；groups：該欄的名稱合併與排序設定 */
  function fauna(rows, groups, col = "物種") {
    const ord = spOrderMap(groups);
    let use;
    if (col === "物種") use = rows.filter((r) => r._spInclude).map((r) => [r._sp, r]);
    else {
      const map = new Map(), inc = new Map();
      for (const g of groups) for (const x of g.raws) { map.set(x.raw, g.name); inc.set(g.name, g.include); }
      use = rows.map((r) => [map.get(r[col] ?? "") ?? (r[col] ?? ""), r]).filter(([k]) => inc.get(k) !== false);
    }
    const by = groupBy(use, (x) => x[0]);
    const hasW = rows.some((r) => r.重量 !== undefined && r.重量 !== "");
    const wOf = (r) => { const m = /^\s*(\d+(?:\.\d+)?)/.exec(String(r.重量 ?? "")); return m ? parseFloat(m[1]) : 0; };
    let t = [...by].map(([sp, xs]) => {
      const rs = xs.map((x) => x[1]);
      const o = { 物種: sp, NISP: sum(rs, (r) => r._qty), 筆數: rs.length };
      if (hasW) o.重量 = sum(rs, wOf);
      return o;
    });
    t.sort((a, b) => (ord.get(a.物種) ?? 9999) - (ord.get(b.物種) ?? 9999) || b.NISP - a.NISP);
    const total = sum(t, (x) => x.NISP);
    const idTotal = sum(t.filter((x) => !IDENT_EXCL.test(x.物種)), (x) => x.NISP);
    t.forEach((x) => { x.百分比 = total ? x.NISP / total : 0; x.可鑑定百分比 = IDENT_EXCL.test(x.物種) ? null : (idTotal ? x.NISP / idTotal : 0); });
    const wTotal = hasW ? sum(t, (x) => x.重量) : null;
    if (hasW) t.forEach((x) => (x.重量百分比 = wTotal ? x.重量 / wTotal : 0));
    return { table: t, total, idTotal, hasW, wTotal };
  }

  // ---------------------------------------------------------------- MNI
  /** override: {物種: {骨骼: true/false}} */
  function mniEligible(r, cfg, override) {
    const o = override && override[r._sp] && override[r._sp][r._el];
    if (o === true || o === false) return o;
    return r._mni === "Y" || (r._mni === "反芻類" && cfg.ruminants.has(r._sp));
  }
  function mniDefault(cfg, sp, el) {
    const i = elementInfo(cfg, el);
    return i.mni === "Y" || (i.mni === "反芻類" && cfg.ruminants.has(sp));
  }

  function chromatic(sets) {
    const n = sets.length;
    if (!n) return 0;
    const adj = sets.map((a, i) => sets.map((b, j) => i !== j && a.some((z) => b.includes(z))));
    const zc = {};
    for (const s of sets) for (const z of s) zc[z] = (zc[z] || 0) + 1;
    const lower = Math.max(1, ...Object.values(zc));
    const order = [...Array(n).keys()].sort((a, b) => adj[b].filter(Boolean).length - adj[a].filter(Boolean).length);
    if (n > 80) {
      const color = {};
      for (const v of order) {
        const used = new Set(Object.keys(color).filter((u) => adj[v][u]).map((u) => color[u]));
        let c = 0; while (used.has(c)) c++; color[v] = c;
      }
      return Math.max(...Object.values(color)) + 1;
    }
    const can = (k) => {
      const color = new Array(n).fill(-1);
      const bt = (pos) => {
        if (pos === n) return true;
        const v = order[pos];
        const used = new Set();
        for (let u = 0; u < n; u++) if (adj[v][u] && color[u] >= 0) used.add(color[u]);
        const maxc = Math.max(-1, ...color) + 1;
        for (let c = 0; c < Math.min(k, maxc + 1); c++) {
          if (!used.has(c)) { color[v] = c; if (bt(pos + 1)) return true; color[v] = -1; }
        }
        return false;
      };
      return bt(0);
    };
    let k = lower; while (!can(k)) k++;
    return k;
  }

  /** 回傳 {species:[{物種,側別MNI,側別依據,區位MNI,區位依據}], detail:{物種:[部位列]}} */
  function mni(rows, cfg, groups, override) {
    const ord = spOrderMap(groups);
    const base = rows.filter((r) => r._spInclude && !NON_TAXON.test(r._sp));
    const skipped = uniq(rows.filter((r) => r._spInclude && NON_TAXON.test(r._sp)).map((r) => r._sp));
    const lr = base.filter((r) => r._side === "L" || r._side === "R");
    const species = uniq(base.map((r) => r._sp)).sort((a, b) => (ord.get(a) ?? 9999) - (ord.get(b) ?? 9999));
    const detail = {}, summ = [];
    for (const sp of species) {
      const rs = lr.filter((r) => r._sp === sp);
      const byEl = groupBy(rs, (r) => r._el);
      const els = [];
      for (const [el, ers] of byEl) {
        const info = elementInfo(cfg, el);
        const row = { 骨骼部位: el, _ri: info.regionIdx, _oi: info.order, 預設: mniDefault(cfg, sp, el),
          納入: mniEligible(ers[0], cfg, override) };
        for (const s of ["L", "R"]) {
          const ss = ers.filter((r) => r._side === s);
          const zoned = ss.filter((r) => zonesOf(r).length);
          const sets = zoned.map(zonesOf);
          let mne = chromatic(sets);
          if (mne === 0 && ss.length) mne = 1;
          const zc = {};
          sets.forEach((st) => st.forEach((z) => (zc[z] = (zc[z] || 0) + 1)));
          row[s] = { n: ss.length, qty: sum(ss, (r) => r._qty), zoned: zoned.length, unzoned: ss.length - zoned.length, mne,
            zc, specimens: zoned.map((r, i) => ({ id: r.流水號, zones: sets[i].join("") })) };
        }
        row.側別最大 = Math.max(row.L.n, row.R.n);
        row.區位最大 = Math.max(row.L.mne, row.R.mne);
        els.push(row);
      }
      els.sort((a, b) => a._ri - b._ri || a._oi - b._oi || a.骨骼部位.localeCompare(b.骨骼部位));
      detail[sp] = els;
      const use = els.filter((e) => e.納入);
      const best = (key, sub) => {
        if (!use.length) return [1, "無可判側別骨骼，以出現計 1"];
        const m = Math.max(...use.map((e) => e[key]));
        if (m === 0) return [1, "無可判側別骨骼，以出現計 1"];
        const basis = [];
        for (const e of use) for (const s of ["L", "R"]) if (e[s][sub] === m) basis.push(`${e.骨骼部位} ${s}`);
        return [m, basis.join("、")];
      };
      const [sm, sb] = best("側別最大", "n");
      const [zm, zb] = best("區位最大", "mne");
      summ.push({ 物種: sp, 側別MNI: sm, 側別依據: sb, 區位MNI: zm, 區位依據: zb });
    }
    const ts = sum(summ, (x) => x.側別MNI), tz = sum(summ, (x) => x.區位MNI);
    summ.forEach((x) => { x.側別百分比 = ts ? x.側別MNI / ts : 0; x.區位百分比 = tz ? x.區位MNI / tz : 0; });
    return { species: summ, detail, skipped, totalSide: ts, totalZone: tz };
  }

  // ---------------------------------------------------------------- 骨骼部位
  function elements(rows, sp) {
    const rs = rows.filter((r) => r._sp === sp);
    const total = sum(rs, (r) => r._qty);
    const g = groupBy(rs, (r) => `${r._el}\u0001${r._side}`);
    let t = [...g.values()].map((x) => ({ 骨骼區域: x[0]._region, 骨骼部位: x[0]._el, 側別: x[0]._side, 加總: sum(x, (r) => r._qty),
      _ri: x[0]._regionIdx, _oi: x[0]._elIdx }));
    t.sort((a, b) => a._ri - b._ri || a._oi - b._oi || a.骨骼部位.localeCompare(b.骨骼部位) || sideIdx(a.側別) - sideIdx(b.側別));
    const reg = {};
    t.forEach((x) => (reg[x.骨骼區域] = (reg[x.骨骼區域] || 0) + x.加總));
    t.forEach((x) => { x.區域百分比 = x.加總 / reg[x.骨骼區域]; x.整體百分比 = total ? x.加總 / total : 0; });
    const regions = REGION_ORDER.filter((r) => r in reg).concat(Object.keys(reg).filter((r) => !REGION_ORDER.includes(r)))
      .map((r) => ({ 骨骼區域: r, 加總: reg[r], 整體百分比: total ? reg[r] / total : 0 }));
    const byEl = groupBy(t, (x) => x.骨骼部位);
    const noSide = [...byEl.values()].map((xs) => ({ 骨骼區域: xs[0].骨骼區域, 骨骼部位: xs[0].骨骼部位, 加總: sum(xs, (x) => x.加總) }));
    noSide.forEach((x) => { x.區域百分比 = x.加總 / reg[x.骨骼區域]; x.整體百分比 = total ? x.加總 / total : 0; });
    // 左右對照（只取有 L／R 的部位）
    const lr = new Map();
    for (const x of t) {
      if (x.側別 !== "L" && x.側別 !== "R") continue;
      const k = x.骨骼部位;
      if (!lr.has(k)) lr.set(k, { 骨骼區域: x.骨骼區域, 骨骼部位: k, L: 0, R: 0, _ri: x._ri, _oi: x._oi });
      lr.get(k)[x.側別] += x.加總;
    }
    const sides = [...lr.values()].sort((a, b) => a._ri - b._ri || a._oi - b._oi || a.骨骼部位.localeCompare(b.骨骼部位));
    const totL = sum(sides, (x) => x.L), totR = sum(sides, (x) => x.R);
    const regLR = {};
    sides.forEach((x) => { x.合計 = x.L + x.R; regLR[x.骨骼區域] = (regLR[x.骨骼區域] || 0) + x.合計; });
    sides.forEach((x) => { x.L百分比 = totL ? x.L / totL : 0; x.R百分比 = totR ? x.R / totR : 0; x.區域百分比 = x.合計 / regLR[x.骨骼區域]; });
    const nonLR = total - totL - totR;
    return { table: t, regions, noSide, total, sides, totL, totR, nonLR };
  }

  // ---------------------------------------------------------------- 性別
  const SEX_PAT = /\b(female|femal)\b|\bmale\b|雌|雄|(?<![a-zA-Z])公(?![分斤尺克里])|母(?![體岩語])/gi;
  const CANINE_PAT1 = /canine|tusk|犬齒|獠牙/i, CANINE_PAT2 = /(?<![A-Za-z])d?C(?![a-z])/;
  const UNCERTAIN_PAT = /[?？]|prob|possib|maybe|perhaps|可能|疑|或/i;
  const UPPER_PAT = /upper|上顎|上頜|上犬|maxill/i, LOWER_PAT = /lower|下顎|下頜|下犬|mandib/i;
  const SAME_IND = /同個體|同一個體|same individual/i;
  const UPPER_BONES = new Set(["maxilla", "premaxilla", "skull", "cranium"]), LOWER_BONES = new Set(["mandible"]);
  const SEX_ROWS = ["male", "male?", "female", "female?"];

  function jawFrom(cfg, text, bone) {
    const up = UPPER_PAT.test(text), low = LOWER_PAT.test(text);
    if (up && !low) return "上顎";
    if (low && !up) return "下顎";
    const b = normalizeElement(cfg, bone);
    if (UPPER_BONES.has(b)) return "上顎";
    if (LOWER_BONES.has(b)) return "下顎";
    return "";
  }

  function sexFromColumn(v) {
    const s = String(v ?? "").trim();
    if (!s || s === "-" || /^(n\/?a|un|unknown|indet\.?)$/i.test(s)) return null;
    const q = /[?？]/.test(s) || /prob|可能|疑/i.test(s);
    let sx = null;
    if (/^(f|female|femal|雌|母)/i.test(s.replace(/^(prob\.?|probably)\s*/i, ""))) sx = "female";
    else if (/^(m|male|雄|公)/i.test(s.replace(/^(prob\.?|probably)\s*/i, ""))) sx = "male";
    return sx ? sx + (q ? "?" : "") : null;
  }
  function analyseSexNote(cfg, note, bone) {
    const hits = [...note.matchAll(SEX_PAT)].map((m) => m[0]);
    if (!hits.length) return null;
    const sexes = uniq(hits.map((h) => (/^fem/i.test(h) || h === "雌" || h === "母" ? "female" : "male")));
    const sex = sexes.length === 1 ? sexes[0] : "矛盾";
    let uncertain = false;
    for (const ch of note.split(/[,，;；\n]/)) {
      if (!ch.trim()) continue;
      SEX_PAT.lastIndex = 0;
      if (new RegExp(SEX_PAT.source, "i").test(ch) && UNCERTAIN_PAT.test(ch)) uncertain = true;
    }
    const canine = CANINE_PAT1.test(note) || CANINE_PAT2.test(note);
    let jaw = jawFrom(cfg, note, bone);
    if (UPPER_PAT.test(note) && LOWER_PAT.test(note)) jaw = "不明";
    if (!jaw) jaw = "不明";
    return { 判定詞: hits.join("、"), 性別: sex + (uncertain && sex !== "矛盾" ? "?" : ""), 犬齒依據: canine ? "是" : "否",
      上下顎: jaw, 同個體註記: SAME_IND.test(note) ? "是" : "" };
  }

  /** override: {流水號: {採計:true/false, 性別, 上下顎}} */
  function sex(rows, cfg, sp, override = {}) {
    const det = [];
    for (const r of rows.filter((r) => r._sp === sp)) {
      let a = analyseSexNote(cfg, String(r.備註 || ""), r.骨骼);
      const cs = sexFromColumn(r.性別);
      if (cs) {
        const ctx = String(r.備註 || "") + " " + String(r.骨骼 || "");
        if (!a) {
          const jaw = jawFrom(cfg, String(r.備註 || ""), r.骨骼) || "不明";
          a = { 判定詞: "", 性別: cs, 犬齒依據: CANINE_PAT1.test(ctx) || CANINE_PAT2.test(ctx) ? "是" : "否", 上下顎: jaw, 同個體註記: SAME_IND.test(String(r.備註 || "")) ? "是" : "" };
        } else if (a.性別.replace("?", "") !== cs.replace("?", "")) a.性別 = "矛盾";
        else a.性別 = cs;
        a.判定詞 = [`性別欄：${r.性別}`, a.判定詞].filter(Boolean).join("、");
      }
      if (!a) continue;
      const auto = a.犬齒依據 === "是" && a.性別 !== "矛盾";
      const reason = auto ? "" : a.性別 === "矛盾" ? "性別詞互相矛盾" : "未提到犬齒，不採計";
      const o = override[r.流水號] || {};
      det.push({ 原表列號: r._列號, 流水號: r.流水號, 骨骼: r.骨骼, 側: r.側, 數量: r.數量, 備註: r.備註, ...a,
        自動採計: auto, 不採計原因: reason,
        採計: o.採計 ?? auto, 性別_用: o.性別 || a.性別, 上下顎_用: o.上下顎 || a.上下顎, 已修改: Object.keys(o).length > 0 });
    }
    const tab = {};
    SEX_ROWS.forEach((s) => (tab[s] = { 上顎: 0, 下顎: 0, 不明: 0 }));
    for (const d of det.filter((d) => d.採計)) {
      if (!tab[d.性別_用]) tab[d.性別_用] = { 上顎: 0, 下顎: 0, 不明: 0 };
      const col = d.上下顎_用 === "上顎" || d.上下顎_用 === "下顎" ? d.上下顎_用 : "不明";
      tab[d.性別_用][col] += 1;
    }
    const table = Object.entries(tab).map(([k, v]) => ({ 性別: k, ...v, 合計: v.上顎 + v.下顎 + v.不明 }));
    return { table, detail: det };
  }

  // ---------------------------------------------------------------- 年齡
  const MAIN_TEETH = ["dp4", "P4", "M1", "M2", "M3"];
  const WEAR_NOTE_A = /\/\s*[a-nuv]\b|\/\s*\d\/\d|"[a-nuv]"|磨耗/, WEAR_NOTE_B = /stage|unerupt|erupt|crypt|wear/i;
  const isWearNote = (s) => WEAR_NOTE_A.test(s) || WEAR_NOTE_B.test(s);

  function normPos(p) {
    let s = String(p ?? "").trim();
    if (!s) return "";
    s = s.replace(/\s*(or|\/|、)\s*/gi, "/");
    s = s.replace(/^p\s*m\s*(\d)/i, "P$1");
    s = s.replace(/^d\s*p\s*(\d)/i, "dP$1");
    s = s.replace(/^([ipcm])(\d)/i, (m, a, b) => a.toUpperCase() + b);
    s = s.replace(/\/([ipcm])(\d)/gi, (m, a, b) => "/" + a.toUpperCase() + b);
    s = s.replace(/^(M\d)\/(\d)$/, "$1/M$2");
    return s;
  }
  const colOfPos = (p) => ({ dP4: "dp4", P4: "P4", M1: "M1", M2: "M2", M3: "M3" })[p] || null;
  const isNum = (v) => v !== "" && v !== null && v !== undefined && !isNaN(Number(v));

  function collectTeeth(cfg, wide, longs, log) {
    const recs = [];
    for (const bone of ["mandible", "tooth", "maxilla"]) {
      const t = longs[bone];
      if (!t || !t.length || !("齒位" in t[0])) continue;
      for (const r of t) {
        let jaw = { upper: "上顎", lower: "下顎" }[String(r.上下顎 || "").toLowerCase()] || "";
        if (!jaw) jaw = jawFrom(cfg, "", r.骨骼);
        recs.push({ 流水號: r.流水號, 骨骼: r.骨骼, 上下顎: jaw, 齒位: normPos(r.齒位), 側別: r.側別 || "",
          磨耗: String(r.磨耗 || "").trim(), 來源: `長表_${bone}` });
      }
    }
    for (const [pc, sc, wmc] of [["齒位", "stage", "WM"], ["齒位.1", "stage.1", "WM.1"]]) {
      for (const r of wide) {
        if (!(pc in r) || r[pc] === "") continue;
        let stage = String(r[sc] || "").trim();
        const wm = String(r[wmc] || "").trim();
        if (!stage && wm && !isNum(wm)) {
          stage = wm;
          log.push({ 類型: "磨耗放在 WM 欄", 流水號: r.流水號, 原表列號: r._列號, 內容: `${pc}=${r[pc]}：WM 欄「${wm}」視為磨耗` });
        }
        recs.push({ 流水號: r.流水號, 骨骼: r.骨骼, 上下顎: jawFrom(cfg, String(r.備註 || ""), r.骨骼), 齒位: normPos(r[pc]),
          側別: normalizeSide(r.側), 磨耗: stage, 來源: "原表齒位欄" });
      }
    }
    return recs;
  }

  function age(rows, cfg, sp, longs) {
    const log = [];
    const wide = rows.filter((r) => r._sp === sp);
    let rec = collectTeeth(cfg, wide, longs, log).filter((r) => r.磨耗 && r.齒位);
    const seen = new Set();
    rec = rec.filter((r) => { const k = [r.流水號, r.上下顎, r.齒位, r.側別, r.磨耗, r.來源].join("|"); if (seen.has(k)) return false; seen.add(k); return true; });
    for (const [, d] of groupBy(rec, (r) => r.流水號)) {
      const known = uniq(d.map((r) => r.上下顎).filter(Boolean));
      if (known.length === 1) d.forEach((r) => { if (!r.上下顎) r.上下顎 = known[0]; });
    }
    const rowNo = new Map(); for (const r of rows) if (!rowNo.has(r.流水號)) rowNo.set(r.流水號, r._列號);
    const out = [];
    for (const [, d] of groupBy(rec, (r) => r.流水號 + "\u0001" + r.上下顎)) {
      const row = { 流水號: d[0].流水號, 骨骼: uniq(d.map((r) => r.骨骼)).join("、"), 上下顎: d[0].上下顎 };
      MAIN_TEETH.forEach((c) => (row[c] = ""));
      const other = [], conflicts = [];
      for (const [pos, dd] of groupBy(d, (r) => r.齒位)) {
        const vals = []; const low = new Set();
        for (const x of dd) if (!low.has(x.磨耗.toLowerCase())) { low.add(x.磨耗.toLowerCase()); vals.push(x.磨耗); }
        const c = colOfPos(pos);
        if (c) {
          row[c] = vals.join("; ");
          if (vals.length > 1) conflicts.push(`${pos} 有多個磨耗值（${dd.map((x) => `${x.磨耗}[${x.來源}]`).join("、")}）`);
        } else other.push(`${pos}:${vals.join("/")}`);
      }
      row.其他齒位 = other.join("; ");
      row.側別 = uniq(d.map((r) => r.側別)).filter((s) => s && s !== "-").join("、");
      row.來源 = uniq(d.map((r) => r.來源)).join("、");
      row.檢查 = conflicts.join("；");
      row.原表列號 = rowNo.get(row.流水號) ?? "";
      out.push(row);
    }
    const jo = { 下顎: 0, 上顎: 1, "": 2 };
    out.sort((a, b) => jo[a.上下顎] - jo[b.上下顎] || String(a.流水號).localeCompare(String(b.流水號)));
    const got = new Set(rec.map((r) => r.流水號));
    const jawbones = new Set(["tooth", "mandible", "maxilla", "premaxilla", "skull", "cranium"]);
    const missing = wide.filter((r) => jawbones.has(normalizeElement(cfg, r.骨骼)) && isWearNote(String(r.備註 || "")) && !got.has(r.流水號))
      .map((r) => ({ 原表列號: r._列號, 流水號: r.流水號, 骨骼: r.骨骼, 側: r.側, 備註: r.備註 }));
    return { table: out, records: rec, missing, log };
  }

  // 磨耗等級排序（Grant 系統）：C → V → E → H → U → a…n；其他依字母
  const WEAR_ORDER = ["in crypt", "crypt", "cr", "c?", "unerupt", "unerupted", "v", "erupting", "er", "e?", "h", "1/2", "u", "unworn", "no wear",
    "a", "b", "c", "d", "e", "f", "g", "h1", "j", "k", "l", "m", "n"];
  function wearRank(w) {
    let s = String(w).trim();
    const up = { C: "crypt", V: "v", E: "erupting", H: "h", U: "u" };
    s = up[s] || s.toLowerCase();
    const i = WEAR_ORDER.indexOf(s);
    return i >= 0 ? i : 100;
  }


  // ---------------------------------------------------------------- Lemoine et al. 2014 年齡組
  // Table 1：0 未萌出；1 齒囊穿孔；2 齒囊中可見；3 齒冠礦化完成；4 萌出穿過骨；5 萌出一半；6 完全萌出無磨耗；
  //          7–19 = Grant TWS a、b、c、d、e、f、g、h、j、k、l、m、n；S（脫落）以 20 表示
  // Table 3：各年齡組 dP4、P4、M1、M2、M3 的分數範圍；「上顎/下顎」不同時寫成 "上/下"
  const LEMOINE = {
    Specific: {
      order: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
      ages: { 1: "≤1 mo", 2: "3–5 mos", 3: "6–8 mos", 4: "8–12 mos", 5: "12–16 mos", 6: "18–30 mos", 7: "30–52 mos", 8: "52–72 mos", 9: "72–96 mos", 10: ">96 mos" },
      t: {
        1: ["U-7", "U", "U-2", "U", "U"], 2: ["8-10", "U-3", "3-6", "U-2", "U"], 3: ["9-11", "U-3", "7-9", "2-3", "U-2"],
        4: ["11-S/11-15", "U-7", "9-11", "4-7", "U-3"], 5: ["S", "8-10", "9-12", "7-9", "2-4/2-5"], 6: ["S", "8-11", "10-12", "8-10", "4-8"],
        7: ["S", "8-12", "13-14", "8-11", "5-9"], 8: ["S", "10-13/9-13", "14-16", "10-13", "7-11"], 9: ["S", "11-14", "15-19", "12-16", "10-12"],
        10: ["S", "13-14", "18-19", "16-19", "12-15"],
      },
    },
    "Simplified-A": {
      order: ["A", "B", "C", "D", "E", "F", "G"],
      ages: { A: "≤1 mo", B: "3–8 mos", C: "8–12 mos", D: "12–16 mos", E: "18–52 mos", F: "52–96 mos", G: ">96 mos" },
      t: {
        A: ["U-7", "U", "U-2", "U", "U"], B: ["8-11", "U-3", "3-9", "U-3", "U-2"], C: ["11-S/11-15", "U-7", "9-11", "4-7", "U-3"],
        D: ["S", "8-10", "9-12", "7-9", "2-4/2-5"], E: ["S", "8-12", "10-14", "8-11", "4-9"], F: ["S", "10-14/9-14", "14-19", "10-16", "7-12"],
        G: ["S", "13-14", "18-19", "16-19", "12-15"],
      },
    },
    "Simplified-B": {
      order: ["I", "II", "III", "IV"],
      ages: { I: "0–12 mos", II: "12–52 mos", III: "52–96 mos", IV: ">96 mos" },
      t: {
        I: ["U-S/U-15", "U-7", "U-11", "U-7", "U-3"], II: ["S", "8-12", "9-14", "7-11", "2-9"],
        III: ["S", "10-14/9-14", "14-19", "10-16", "7-12"], IV: ["S", "13-14", "18-19", "16-19", "12-15"],
      },
    },
  };
  const LEM_TEETH = ["dp4", "P4", "M1", "M2", "M3"];
  const SYSTEMS = Object.keys(LEMOINE);
  const tokScore = (x) => (x === "U" ? 0 : x === "S" ? 20 : parseInt(x, 10));
  function rangeOf(txt) { const [a, b] = txt.split("-"); return [tokScore(a), tokScore(b ?? a)]; }
  // 預先解析：LEM[sys].r[cls][tooth] = {上顎:[lo,hi], 下顎:[lo,hi]}
  for (const sys of SYSTEMS) {
    const L = LEMOINE[sys]; L.r = {};
    for (const c of L.order) {
      L.r[c] = {};
      L.t[c].forEach((txt, i) => { const [mx, md] = txt.split("/"); L.r[c][LEM_TEETH[i]] = { 上顎: rangeOf(mx), 下顎: rangeOf(md ?? mx) }; });
    }
  }

  // 磨耗寫法 → Lemoine 分數（預設判讀；使用者可在網頁修改）
  const LETTER = { a: 7, b: 8, c: 9, d: 10, e: 11, f: 12, g: 13, h: 14, j: 15, k: 16, l: 17, m: 18, n: 19 };
  const WORDS = [
    [/^(u|unworn|unwear|no ?wear|unworn\.?)$/i, "6", "U：完全萌出、無磨耗"],
    [/^(in ?crypt|crypt|cr|c\?)$/i, "1-3", "齒囊中"],
    [/^(unerupt|unerupted|not erupted)$/i, "0-3", "未萌出（形成中）"],
    [/^(erupting|erupt|er|e\?)$/i, "4-5", "萌出中"],
    [/^(1\/2|½|half|half erupted)$/i, "5", "萌出一半"],
    [/^little ?\/ ?no wear$/i, "6-7", "幾乎無磨耗", true],
    [/^(slight|light|little) wear$/i, "7-8", "輕度磨耗（a–b）", true],
    [/^moderate wear$/i, "10-12", "中度磨耗（d–f）", true],
    [/^heavy wear$/i, "13-16", "重度磨耗（g–k）", true],
    [/^in wear$/i, "7-19", "已磨耗（等級不明）", true],
  ];
  function parseWearOne(s) {
    s = s.trim();
    if (!s) return null;
    for (const [re, expr, note, flag] of WORDS) if (re.test(s)) return { expr, note, flag: !!flag };
    if (/^[a-hj-n]$/.test(s)) return { expr: String(LETTER[s]), note: `Grant ${s}` };
    if (/^[a-hj-n]\d$/.test(s)) return { expr: String(LETTER[s[0]]), note: `Grant ${s[0]}（去掉 ${s[1]}）`, flag: true };
    const UP = { U: ["6", "U：未磨耗"], V: ["2", "V：齒囊中可見"], C: ["1-3", "C：齒囊中（也可能是磨耗 c）"], E: ["4-5", "E：萌出中（也可能是磨耗 e）"], H: ["5", "H：萌出一半"] };
    if (UP[s]) return { expr: UP[s][0], note: UP[s][1], flag: s === "C" || s === "E" };
    if (s === "v") return { expr: "2", note: "v：視為 V（齒囊中可見）", flag: true };
    if (/^[A-HJ-N]$/.test(s)) return { expr: String(LETTER[s.toLowerCase()]), note: `大寫，視為 Grant ${s.toLowerCase()}`, flag: true };
    return null;
  }
  /** 回傳 {expr, note, flag}；expr 空字串＝無法判讀 */
  function defaultWearScore(raw) {
    let s = String(raw ?? "").trim();
    if (!s) return { expr: "", note: "" };
    const q = /[?？]$/.test(s); if (q) s = s.replace(/[?？]+$/, "").trim();
    let r = parseWearOne(s);
    if (!r) {
      const m = /^(.+?)\s*[-~–／\/]\s*(.+)$/.exec(s);    // 例：f-g、d-e、cr-v
      if (m) {
        const a = parseWearOne(m[1]), b = parseWearOne(m[2]);
        if (a && b) {
          const sa = scoresOf(a.expr), sb = scoresOf(b.expr);
          r = { expr: `${Math.min(...sa, ...sb)}-${Math.max(...sa, ...sb)}`, note: `${a.note} 至 ${b.note}` };
        }
      }
    }
    if (!r) return { expr: "", note: "無法判讀，請填分數", flag: true };
    if (q) { r.flag = true; r.note += "（原寫法帶問號）"; }
    return r;
  }
  function scoresOf(expr) {
    const out = new Set();
    for (const part of String(expr ?? "").split(/[,，\s]+/).filter(Boolean)) {
      const m = /^(\d+|U|S)(?:\s*-\s*(\d+|U|S))?\+?$/i.exec(part.trim());
      if (!m) continue;
      const a = tokScore(m[1].toUpperCase()), b = m[2] ? tokScore(m[2].toUpperCase()) : a;
      for (let x = Math.min(a, b); x <= Math.max(a, b); x++) out.add(x);
    }
    return [...out];
  }
  function toothClasses(sys, tooth, jaw, scores) {
    const L = LEMOINE[sys];
    return L.order.filter((c) => {
      const r = L.r[c][tooth];
      const rs = jaw === "上顎" ? [r.上顎] : jaw === "下顎" ? [r.下顎] : [r.上顎, r.下顎];
      return scores.some((x) => rs.some(([lo, hi]) => x >= lo && x <= hi));
    });
  }
  /** 一列（一個流水號＋上下顎）判定年齡組：Lemoine et al. 2014 §3.2，各齒可能組別的眾數（唯一）即為年齡組 */
  function lemoineAssign(row, sys, scoreOfRaw) {
    const votes = new Map(), used = [];
    for (const t of LEM_TEETH) {
      const vals = String(row[t] || "").split(/;\s*/).filter(Boolean);
      if (!vals.length) continue;
      const sc = [...new Set(vals.flatMap((v) => scoresOf(scoreOfRaw(v))))];
      if (!sc.length) continue;
      const cls = toothClasses(sys, t, row.上下顎, sc);
      used.push({ t, cls });
      cls.forEach((c) => votes.set(c, (votes.get(c) || 0) + 1));
    }
    if (!used.length) return { cls: null, note: "無可判讀的齒位" };
    const order = LEMOINE[sys].order;
    const max = Math.max(0, ...votes.values());
    if (!max) return { cls: null, note: "各齒分數不在任何年齡組範圍", used };
    const top = order.filter((c) => votes.get(c) === max);
    if (top.length > 1) return { cls: null, note: `可能 ${top.join("/")}`, used };
    return { cls: top[0], note: max < used.length ? "牙齒間不完全一致（取眾數）" : "", used };
  }
  function lemoineSummary(assigned, sys) {
    const L = LEMOINE[sys];
    const n = assigned.length;
    let cum = 0;
    const rows = L.order.map((c) => {
      const k = assigned.filter((x) => x === c).length;
      cum += k;
      return { 年齡組: c, 年齡估計: L.ages[c], 件數: k, 死亡率: n ? k / n : 0, 存活率: n ? 1 - cum / n : 0 };
    });
    return { rows, n };
  }

  // ---------------------------------------------------------------- 表面痕
  const MARK_ITEMS = ["切割", "燒炙", "啃咬"];
  function normMark(v) {
    let s = String(v ?? "").trim();
    if (["", "-", "—", "nan"].includes(s)) return "";
    s = s.replace(/\s*[\r\n]+\s*/g, "+");
    return s === "v" || s === "V" ? "v" : s;
  }
  /** mapping: {原始(已正規化)寫法: 歸入類別}；歸入為空字串 → 視為無紀錄 */
  function marks(rows, sp, item, mapping = {}) {
    const rs = rows.filter((r) => r._sp === sp);
    const raw = new Map();
    for (const r of rs) {
      const v = normMark(r[item]);
      if (!v) continue;
      const e = raw.get(v) || { 原始寫法: v, 筆數: 0, 數量加總: 0 };
      e.筆數 += 1; e.數量加總 += r._qty; raw.set(v, e);
    }
    const cat = (v) => (v in mapping ? mapping[v] : v);
    const catTot = new Map();
    for (const r of rs) { const v = normMark(r[item]); if (!v) continue; const c = cat(v); if (c) catTot.set(c, (catTot.get(c) || 0) + r._qty); }
    const cols = [...catTot].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    const byEl = groupBy(rs, (r) => r._el);
    const t = [...byEl.values()].map((xs) => {
      const row = { 骨骼部位: xs[0]._el, _ri: xs[0]._regionIdx, _oi: xs[0]._elIdx };
      cols.forEach((c) => (row[c] = 0));
      for (const r of xs) { const v = normMark(r[item]); if (!v) continue; const c = cat(v); if (c) row[c] += r._qty; }
      row.有紀錄合計 = sum(cols, (c) => row[c]);
      row.總數 = sum(xs, (r) => r._qty);
      row.無紀錄 = row.總數 - row.有紀錄合計;
      row.有紀錄百分比 = row.總數 ? row.有紀錄合計 / row.總數 : 0;
      return row;
    });
    t.sort((a, b) => a._ri - b._ri || a._oi - b._oi || a.骨骼部位.localeCompare(b.骨骼部位));
    const tot = { 骨骼部位: "合計" };
    cols.concat(["有紀錄合計", "總數", "無紀錄"]).forEach((c) => (tot[c] = sum(t, (x) => x[c])));
    tot.有紀錄百分比 = tot.總數 ? tot.有紀錄合計 / tot.總數 : 0;
    return { table: t, total: tot, cols, rawValues: [...raw.values()].sort((a, b) => b.數量加總 - a.數量加總) };
  }

  // ---------------------------------------------------------------- 臼齒測量
  const MOLAR_ITEMS = { M1: ["GL", "WA", "WP"], M2: ["GL", "WA", "WP"], M3: ["GL", "WA", "WM", "WP"] };
  const ALL_MI = ["GL", "WA", "WM", "WP"];
  function cleanVal(v) {
    const s = String(v ?? "").trim();
    if (["", "-", "—", "x", "X", "NA", "na"].includes(s)) return [null, ""];
    if (isNum(s)) return [Number(s), ""];
    const m = /(\d+(?:\.\d+)?)/.exec(s);
    if (m && !/crad|unworn|^[a-z]$/i.test(s)) return [Number(m[1]), `原值「${s}」`];
    return [null, `非數值「${s}」略過`];
  }

  function molars(rows, cfg, sp, longs) {
    const wide = rows.filter((r) => r._sp === sp);
    const recs = [];
    for (const suf of ["", ".1"]) {
      const pc = "齒位" + suf;
      for (const r of wide) {
        if (!(pc in r) || r[pc] === "") continue;
        const rec = { 流水號: r.流水號, 骨骼: r.骨骼, 上下顎: jawFrom(cfg, String(r.備註 || ""), r.骨骼), 側別: normalizeSide(r.側),
          齒位: normPos(r[pc]), 磨耗: String(r["stage" + suf] || "").trim(), 來源: "原表齒位欄", 檢查: [],
          坑號: r.坑號 || "", 層位: r.層位 || "", 文化層: r.文化層 || "", 原表列號: r._列號 };
        for (const it of ALL_MI) {
          let [v, note] = cleanVal(r[it + suf]);
          rec[it] = v;
          if (note) {
            if (it === "WM" && !rec.磨耗 && note.startsWith("非數值")) {
              rec.磨耗 = String(r[it + suf]).trim(); note = `WM 欄「${rec.磨耗}」視為磨耗`;
            }
            rec.檢查.push(`${it}：${note}`);
          }
        }
        recs.push(rec);
      }
    }
    const have = new Map(recs.map((r) => [r.流水號 + "|" + r.齒位, r]));
    const other = [];
    const ctx = new Map(); for (const r of rows) if (!ctx.has(r.流水號)) ctx.set(r.流水號, r);
    for (const bone of ["tooth", "mandible", "maxilla"]) {
      const t = longs[bone];
      if (!t || !t.length) continue;
      const rs = t.filter((r) => r.測量項目);
      for (const [, d] of groupBy(rs, (r) => [r.流水號, r.齒位 || "", r.上下顎 || "", r.側別 || ""].join("\u0001"))) {
        const r0 = d[0];
        const pos = normPos(r0.齒位 || "");
        const meas = {}; d.forEach((x) => (meas[String(x.測量項目).toUpperCase()] = Number(x.測量值)));
        const std = Object.fromEntries(Object.entries(meas).filter(([k]) => ALL_MI.includes(k)));
        const oth = Object.entries(meas).filter(([k]) => !ALL_MI.includes(k));
        const c = ctx.get(r0.流水號) || {};
        const base = { 流水號: r0.流水號, 骨骼: bone, 上下顎: { upper: "上顎", lower: "下顎" }[String(r0.上下顎 || "").toLowerCase()] || jawFrom(cfg, "", bone),
          側別: r0.側別 || "", 齒位: pos, 磨耗: uniq(d.map((x) => x.磨耗 || "").filter(Boolean)).join("; "), 來源: `長表_${bone}`,
          坑號: c.坑號 || "", 層位: c.層位 || "", 文化層: c.文化層 || "", 原表列號: c._列號 ?? "" };
        if (oth.length && (pos in MOLAR_ITEMS || pos === "" || pos.includes("/") || pos.includes("?")))
          other.push({ ...base, 測量: oth.map(([k, v]) => `${k}=${v}`).join("、") });
        if (!Object.keys(std).length) continue;
        const k = r0.流水號 + "|" + pos;
        if (have.has(k)) {
          const ex = have.get(k); const filled = [];
          for (const [it, v] of Object.entries(std)) {
            if (isNaN(v)) continue;
            if (ex[it] === null || ex[it] === undefined) { ex[it] = v; filled.push(`${it}=${v}`); }
            else if (Math.abs(ex[it] - v) > 0.005) ex.檢查.push(`長表數值不同：${it} 原表=${ex[it]}、長表=${v}`);
          }
          if (filled.length) { ex.檢查.push("由長表補入：" + filled.join("、")); ex.來源 = "原表齒位欄＋長表"; }
          continue;
        }
        const rec = { ...base, 檢查: [] };
        ALL_MI.forEach((it) => (rec[it] = it in std && !isNaN(std[it]) ? std[it] : null));
        recs.push(rec); have.set(k, rec);
      }
    }
    // 疑似離群
    for (const pos of Object.keys(MOLAR_ITEMS)) for (const jaw of ["下顎", "上顎"]) for (const it of ALL_MI) {
      const g = recs.filter((r) => r.齒位 === pos && r.上下顎 === jaw && r[it] !== null && r[it] !== undefined);
      if (g.length < 5) continue;
      const v = g.map((r) => r[it]).sort((a, b) => a - b);
      const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
      for (const r of g) { const ratio = r[it] / med; if (ratio < 0.75 || ratio > 1.25) { r.檢查.push(`${it} 疑似離群（中位數 ${med.toFixed(2)} 的 ${ratio.toFixed(2)} 倍）`); r._outlier = true; } }
    }
    recs.forEach((r) => (r.檢查 = r.檢查.join("；")));
    const jo = { 下顎: 0, 上顎: 1, "": 2 };
    recs.sort((a, b) => jo[a.上下顎] - jo[b.上下顎] || String(a.流水號).localeCompare(String(b.流水號)));
    return { records: recs, other };
  }

  function describe(vals) {
    const v = vals.filter((x) => x !== null && x !== undefined && !isNaN(x));
    if (!v.length) return null;
    const n = v.length, mean = sum(v) / n;
    const sd = n > 1 ? Math.sqrt(sum(v, (x) => (x - mean) ** 2) / (n - 1)) : null;
    return { n, 平均: mean, 標準差: sd, 最小: Math.min(...v), 最大: Math.max(...v) };
  }

  return {
    parseCSV, fromMatrix, FIELDS, TAXON_LEVELS, detectFields, applyFields, isKnownElement, lookupElement, toCSV, groupBy, sum, uniq, qtyOf, makeConfig, normalizeElement, elementInfo, normalizeSide, zonesOf,
    defaultSpeciesGroups, groupsFromCSV, groupsToCSV, resolveSpecies, prepare, fauna, mni, mniDefault, chromatic,
    elements, sex, age, marks, molars, describe, normPos, normMark, wearRank,
    LEMOINE, SYSTEMS, defaultWearScore, scoresOf, toothClasses, lemoineAssign, lemoineSummary,
    MAIN_TEETH, MARK_ITEMS, MOLAR_ITEMS, ALL_MI, SEX_ROWS, REGION_ORDER, NON_TAXON, DEFAULT_ELEMENTS, DEFAULT_ALIASES,
  };
})();
if (typeof module !== "undefined") module.exports = Core;
