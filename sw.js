/* 離線快取：第一次連網開啟時下載全部檔案，之後完全離線運作。
   發布新版本時請修改 VERSION，平板下次連網開啟時會提示更新。
   新增或刪除 img 裡的圖檔時，也要更新下面的 IMGS 清單。 */
const VERSION = "v0.08-8";
const CACHE = "faunarec-" + VERSION;
const CORE = ["./", "index.html", "taxa.json", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
const IMGS = ["img/axis.png", "img/bird_carpometacarpus.png", "img/bird_coracoid.png", "img/bird_femur.png", "img/bird_humerus.png", "img/bird_pelvis.png", "img/bird_radius.png", "img/bird_scapula.png", "img/bird_sternum.png", "img/bird_tarsometatarsus.png", "img/bird_tibiotarsus.png", "img/bird_ulna.png", "img/bmeas6.png", "img/bmeas7.png", "img/bowFig.jpg", "img/cervid_mandible.png", "img/lemFig.jpg", "img/lemTab.jpg", "img/sacrum.png", "img/vdd28.png", "img/vdd29.png", "img/vdd30.png", "img/vdd36.png", "img/vdd40.png", "img/vdd42.png", "img/vdd43.png", "img/vdd44.png", "img/vdd45.png", "img/vdd46.png", "img/vdd47.png", "img/vdd48.png", "img/vdd50.png", "img/vp10.png", "img/vp11.png", "img/vp12.png", "img/vp13.png", "img/vp14.png", "img/vp17.png", "img/vp18.png", "img/vp19.png", "img/vp20.png", "img/vp23.png", "img/vp24.png", "img/vp25.png", "img/vp3.png", "img/vp38.png", "img/vp4.png", "img/vp40.png", "img/vp43.png", "img/vp44.png", "img/vp45.png", "img/vp46.png", "img/vp47.png", "img/vp48.png", "img/vp49.png", "img/vp5.png", "img/vp50.png", "img/vp51.png", "img/vp52.png", "img/vp53.png", "img/vp54.png", "img/vp55.png", "img/vp56.png", "img/vp57.png", "img/vp58.png", "img/vp59.png", "img/vp6.png", "img/vp60.png", "img/vp61.png", "img/vp62.png", "img/vp63.png", "img/vp64.png", "img/vp65.png", "img/vp66.png", "img/vp67.png", "img/vp68.png", "img/vp69.png", "img/vp7.png", "img/vp70.png", "img/vp71.png", "img/vp8.png", "img/vp9.png", "img/zoneB8.png", "img/zoneB8_carpometacarpus.png", "img/zoneB8_coracoid.png", "img/zoneB8_furcula.png", "img/zoneB8_humerus.png", "img/zoneB8_radius.png", "img/zoneB8_scapula.png", "img/zoneB8_sternum.png", "img/zoneB8_ulna.png", "img/zoneB9.png", "img/zoneB9_femur.png", "img/zoneB9_pelvis.png", "img/zoneB9_synsacrum.png", "img/zoneB9_tarsometatarsus.png", "img/zoneB9_tibiometatarsus.png", "img/zoneM.jpg", "img/zoneM_Astragalus.png", "img/zoneM_atlas.png", "img/zoneM_Calcanues.png", "img/zoneM_Centrotarsale.png", "img/zoneM_cervical.png", "img/zoneM_femur.png", "img/zoneM_fibula.png", "img/zoneM_horn.png", "img/zoneM_humerus.png", "img/zoneM_lumbar.png", "img/zoneM_MC.png", "img/zoneM_MC3.png", "img/zoneM_MC4.png", "img/zoneM_MT.png", "img/zoneM_MT3.png", "img/zoneM_MT4.png", "img/zoneM_occipital.png", "img/zoneM_pelvis.jpg", "img/zoneM_PH1.png", "img/zoneM_PH2.png", "img/zoneM_radius.png", "img/zoneM_rib.png", "img/zoneM_sacrum.png", "img/zoneM_scapula.png", "img/zoneM_thoracic.png", "img/zoneM_tibia.png", "img/zoneM_ulna.png"];

/* 3D 資料（app/3d）：有上傳時一併下載 3D 程式與所有模型，沒有時略過（試用版）。
   models.json、zones.json、index.json 每次先試著從網路取得最新版；
   記錄工具每次連網開啟時會通知這裡補下載新設定好 zone 的模型，所以只更新 zone 設定時不必改 VERSION */
const FRESH = /\/3d\/models\/(.+\/)?(index|models|zones|share)\.json$/;
async function cache3D(c, onlyMissing) {
  try {
    const idx = await (await fetch("3d/models/index.json", { cache: "no-cache" })).json();
    const list = ["3d/zone3d.js", "3d/lib/three.module.min.js", "3d/lib/OrbitControls.js", "3d/lib/PLYLoader.js", "3d/models/index.json"];
    try { if ((await fetch("3d/models/share.json", { cache: "no-cache" })).ok) list.push("3d/models/share.json"); } catch (e) { /* 沒有共用對照表 */ }
    for (const s of idx.species || []) {
      const b = "3d/models/" + encodeURIComponent(s.name) + "/";
      const ms = await (await fetch(b + "models.json", { cache: "no-cache" })).json();
      let zs = {}; try { zs = (await (await fetch(b + "zones.json", { cache: "no-cache" })).json()).models || {}; } catch (e) { /* 還沒有設定 */ }
      // 只下載已設定 zone 的模型（還沒設定的模型記錄工具用不到）
      list.push(b + "models.json", b + "zones.json", ...ms.filter((m) => zs[m.id] && zs[m.id].faces === m.faces).map((m) => "3d/models/" + m.file.split("/").map(encodeURIComponent).join("/")));
    }
    const need = onlyMissing ? (await Promise.all(list.map(async (u) => ((await c.match(u)) ? null : u)))).filter(Boolean) : list;
    if (need.length) await c.addAll(need);
  } catch (e) { /* 沒有 3D 資料 */ }
}
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => { await c.addAll(CORE.concat(IMGS)); await cache3D(c); }));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("faunarec-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
  if (e.data === "sync3D") e.waitUntil(caches.open(CACHE).then((c) => cache3D(c, true)));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (FRESH.test(new URL(e.request.url).pathname)) {
    e.respondWith(fetch(e.request, { cache: "no-cache" }).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || Response.error())));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).catch(() => (e.request.mode === "navigate" ? caches.match("index.html") : Response.error()))));
});