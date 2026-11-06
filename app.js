/* Zwei Seiten – App. Lädt data/feed.json (vom Cronjob erzeugt) und baut daraus einen endlosen Feed. Alles Persönliche bleibt im localStorage. */
"use strict";
const ICONS = {
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  euro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5a4 4 0 100 7"/><path d="M7.5 11h6M7.5 13.5h6"/></svg>',
  speed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 17a8 8 0 1116 0"/><path d="M12 17l4-5"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/></svg>',
  house: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  border: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M4 9h5M15 15h5"/><path d="M7 7l2 2-2 2M17 13l-2 2 2 2"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19l7-7"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 20V4M4 20h16"/><path d="M8 15l3-4 3 2 5-6"/></svg>',
  scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 4v16M7 20h10M5 7h14"/><path d="M5 7l-2.5 6a2.5 2.5 0 005 0zM19 7l-2.5 6a2.5 2.5 0 005 0z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z"/><path d="M8 11h2l1-2 2 4 1-2h2"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M13 3L5 14h6l-1 7 8-11h-6z"/></svg>',
  school: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2 9 2 12 0v-5"/></svg>',
  news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10M7 12h10M7 15h6"/></svg>',
  smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8 14c1 1.5 2.4 2.2 4 2.2s3-.7 4-2.2"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.4"/></svg>'
};
const SIDES = { L: { cls: "pl", name: "Eher links" }, M: { cls: "pm", name: "Mitte" }, R: { cls: "pr", name: "Eher rechts" } };
const REGION = { de: "Deutschland", us: "USA", welt: "Welt" };
const LBL = ["Klar links", "Eher links", "Mitte", "Eher rechts", "Klar rechts"];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = (id) => document.getElementById(id);

/* ---------- Zustand (nur auf diesem Gerät) ---------- */
let st = { interest: {}, votes: {}, seen: {}, onboarded: false, lastVisit: 0 };
try { const raw = JSON.parse(localStorage.getItem("zs-state") || "null"); if (raw) st = Object.assign(st, raw); } catch (e) {}
const saveSt = () => { try { localStorage.setItem("zs-state", JSON.stringify(st)); } catch (e) {} };
const prevVisit = st.lastVisit || 0;
const bump = (k, n) => { if (!k) return; st.interest[k] = Math.round(((st.interest[k] || 0) + n) * 10) / 10; saveSt(); };
const markVisit = () => { st.lastVisit = Date.now(); const cut = Date.now() - 35 * 864e5; for (const [k, t] of Object.entries(st.seen)) if (t < cut) delete st.seen[k]; saveSt(); };
document.addEventListener("visibilitychange", () => { if (document.hidden) markVisit(); else maybeRefresh(); });
window.addEventListener("pagehide", markVisit);

let ITEMS = [], GENERATED = null, AI = null, loadedAt = 0, filter = "alle";

/* ---------- Hilfen ---------- */
const ago = (iso) => { const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000); if (m < 60) return `vor ${Math.max(1, Math.round(m))} Min.`; const h = m / 60; if (h < 24) return `vor ${Math.round(h)} Std.`; const d = Math.round(h / 24); return d === 1 ? "gestern" : `vor ${d} Tagen`; };
const day = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }); };
const srcName = (it, k) => it.sources?.[k]?.o || "Quelle";
const ageH = (it) => (Date.now() - Date.parse(it.upd)) / 3600e3;
const isNew = (it) => prevVisit && Date.parse(it.created || it.upd) > prevVisit && !st.seen[it.id];
const label = (it) => it.editorial ? "Redaktionell recherchiert" : it.ai ? "Automatisch zusammengefasst" : "Schlagzeilen ohne KI-Zusammenfassung";

function inFilter(it) {
  if (filter === "quatsch") return it.typ === "quatsch";
  if (it.typ === "quatsch") return false;
  if (filter === "debatte") return it.typ === "debatte";
  if (filter in REGION) return it.region === filter;
  return true;
}

/* ---------- Algorithmus ---------- */
const newsScore = (it) => it.prio * (ageH(it) < 72 ? 2 : 0.6) + (ageH(it) < 6 ? 2 : ageH(it) < 24 ? 1 : 0) + (it.typ === "debatte" ? 0.5 : 0);
const userScore = (it) => (st.interest[it.cat] || 0) * 1.4 + (st.interest["r:" + it.region] || 0) * 0.6 + (st.interest["t:" + it.typ] || 0) * 0.4;

function buildRound(round) {
  const pool = ITEMS.filter((it) => inFilter(it) && (round === 0 ? !st.seen[it.id] : !!st.seen[it.id]));
  const byNews = [...pool].sort((a, b) => newsScore(b) - newsScore(a) || Date.parse(b.upd) - Date.parse(a.upd));
  const out = [], used = new Set();
  const take = (it, reason) => { out.push({ it, reason }); used.add(it.id); };
  if (round === 0) byNews.slice(0, 2).forEach((it) => take(it, "top"));
  while (used.size < pool.length) {
    if (out.length % 3 === 2) { take(byNews.find((x) => !used.has(x.id)), round ? "seen" : "news"); continue; }
    const rest = pool.filter((x) => !used.has(x.id));
    const best = rest.map((it) => ({ it, s: userScore(it) + newsScore(it) * 0.8 + Math.random() })).sort((a, b) => b.s - a.s)[0].it;
    take(best, round ? "seen" : userScore(best) > 1 ? "fy" : "news");
  }
  return out;
}
const REASON = { top: ["Wichtig jetzt", ""], news: ["Aktuell", ""], fy: ["Für dich", "fy"], seen: ["Schon gesehen", "again"] };

/* ---------- Karten ---------- */
function whyHTML(it, reason) {
  const r = REASON[reason];
  const badge = it.typ === "quatsch" ? `<b class="qu">Quatsch</b>` : isNew(it) && reason !== "seen" ? `<b class="new">Neu</b>` : `<b class="${r[1]}">${r[0]}</b>`;
  const txt = reason === "fy" ? `Weil dich ${esc(it.cat)} interessiert` : `${esc(REGION[it.region] || "")} · ${esc(it.cat || "")} · ${ago(it.upd)}`;
  return `<div class="why">${badge}<span>${txt}</span></div>`;
}
function headPanel(it, reason) {
  const icon = ICONS[it.icon] || (it.typ === "quatsch" ? ICONS.smile : ICONS.news);
  const facts = (it.facts || []).length ? `<ul class="facts">${it.facts.map((f) => `<li><span>${esc(f[0])}</span><b>${esc(f[1])}</b></li>`).join("")}</ul>` : "";
  const points = it.typ !== "debatte" && (it.points || []).length ? `<ul class="points">${it.points.map((p) => `<li>${esc(p[0])}<small>Quelle: ${esc(srcName(it, p[1]))}</small></li>`).join("")}</ul>` : "";
  const n = Object.keys(it.sources || {}).length;
  return `<section class="panel">${whyHTML(it, reason)}
   <div class="art" aria-hidden="true"><i></i><i></i><i></i>${icon}</div>
   <h2>${esc(it.title)}</h2>${it.lead ? `<p class="lead">${esc(it.lead)}</p>` : ""}${facts}${points}
   <button class="more" data-side="S">${n} ${n === 1 ? "Quelle" : "Quellen"} ansehen</button>
   <p class="ailabel">${label(it)} · Stand ${day(it.upd)}</p></section>`;
}
function sidePanel(it, k) {
  const d = it[k], s = SIDES[k];
  return `<section class="panel ${s.cls}"><div class="side"><i class="dot"></i><span>${s.name}</span></div>
   <p class="who">${esc(d.who)}</p><div class="thesis">${esc(d.thesis)}</div>
   <ul class="args">${(d.a || []).map((a) => `<li><b>${esc(a[0])}</b>${esc(a[1])}<small>Quelle: ${esc(srcName(it, a[2]))}</small></li>`).join("")}</ul>
   <button class="more" data-side="${k}">Ganzen Beitrag lesen</button></section>`;
}
function topicHTML(it, reason) {
  if (it.typ !== "debatte") {
    return `<article class="topic single ${it.typ}" data-id="${esc(it.id)}"><div class="pan">${headPanel(it, reason)}</div><div class="hint"><span>${esc(it.typ === "quatsch" ? "Zum Abschalten" : "Meldung")}</span><span>Weiter ↓</span></div></article>`;
  }
  const v = st.votes[it.id];
  return `<article class="topic" data-id="${esc(it.id)}">
   <nav class="tabs"><button class="on" data-p="0">Thema</button><button class="l" data-p="1">Links</button><button class="m" data-p="2">Mitte</button><button class="r" data-p="3">Rechts</button><button data-p="4">Du</button></nav>
   <div class="pan">${headPanel(it, reason)}${sidePanel(it, "L")}${sidePanel(it, "M")}${sidePanel(it, "R")}
    <section class="panel"><div class="cat">Deine Meinung</div><h2>${esc(it.title)}</h2>
     <p class="lead">Du hast alle drei Seiten gesehen. Wo stehst du?</p>
     <div class="scale">${LBL.map((l, j) => `<button data-v="${j}" class="${v === j ? "on" : ""}">${l.replace(" ", "<br>")}</button>`).join("")}</div>
     <div class="legend"><span>links</span><span>rechts</span></div>
     <p class="note">Deine Wahl bleibt auf diesem Gerät. Eine gemeinsame Auswertung aller Stimmen kommt später.</p></section>
   </div><div class="hint"><span>← Seiten wischen</span><span>Weiter ↓</span></div></article>`;
}

/* ---------- Bottom-Sheet ---------- */
const sheet = $("sheet"), scrim = $("scrim"), body = $("sheet-body"), sside = $("sheet-side");
let lastFocus = null, onClose = null;
function showSheet(cls, sideHTML, html, cb) { lastFocus = document.activeElement; onClose = cb || null; sside.className = "side " + cls; sside.innerHTML = sideHTML; body.innerHTML = html; sheet.className = "sheet " + cls; scrim.hidden = false; sheet.hidden = false; body.scrollTop = 0; $("close").focus(); }
function closeSheet() { sheet.hidden = true; scrim.hidden = true; const cb = onClose; onClose = null; if (cb) cb(); else if (lastFocus) lastFocus.focus(); }
$("close").onclick = closeSheet; scrim.onclick = closeSheet;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
function srcList(it, keys) {
  return `<h4>Quellen</h4><ol class="srcs">${keys.filter((k) => it.sources?.[k]).map((k) => { const s = it.sources[k]; return `<li><div><a href="${esc(s.u)}" target="_blank" rel="noopener">${esc(s.t)}</a><span>${esc(s.o)}${s.d ? " · " + esc(day(s.d)) : ""}</span></div></li>`; }).join("")}</ol>`;
}
function openArticle(it, k) {
  if (k === "S") {
    showSheet("", "<span>Quellen</span>", `<h3 id="sheet-title">${esc(it.title)}</h3><p class="lead">${it.ai ? "Diese Karte wurde automatisch aus den folgenden Meldungen zusammengefasst. Für Details tippe auf den Originalartikel." : "Die Inhalte stammen aus diesen Quellen. Für Details tippe auf den Originalartikel."}</p>${srcList(it, Object.keys(it.sources || {}))}`);
    return;
  }
  const d = it[k], s = SIDES[k]; bump(it.cat, 2);
  showSheet(s.cls, `<i class="dot"></i><span>${s.name}</span>`, `<h3 id="sheet-title">${esc(d.thesis)}</h3><p class="who">${esc(d.who)}</p>${(d.long || []).map((p) => `<p>${esc(p)}</p>`).join("")}${srcList(it, [...new Set((d.a || []).map((a) => a[2]))])}<p class="note">${label(it)}. Die Positionen werden so wiedergegeben, wie ihre Vertreter sie begründen, nicht als Bewertung.</p>`);
}

/* ---------- Interessen ---------- */
function cats() { return [...new Set(ITEMS.filter((i) => i.typ !== "quatsch").map((i) => i.cat).filter(Boolean))]; }
function chipsHTML(list, sel) { return `<div class="chips">${list.map((c) => `<button data-cat="${esc(c)}" class="${sel.has(c) ? "on" : ""}" aria-pressed="${sel.has(c)}">${esc(c)}</button>`).join("")}</div>`; }
function wireChips(sel) { body.querySelectorAll(".chips button").forEach((b) => (b.onclick = () => { const c = b.dataset.cat; sel.has(c) ? sel.delete(c) : sel.add(c); b.classList.toggle("on"); b.setAttribute("aria-pressed", sel.has(c)); })); }
function onboarding() {
  const sel = new Set(), list = [...new Set(["Politik", "Wirtschaft", "Außenpolitik", "Klima", "Migration", "Soziales", "Technik", "Sport", ...cats()])].slice(0, 16);
  showSheet("", "<span>Willkommen</span>", `<h3 id="sheet-title">Was interessiert dich?</h3><p class="lead">Wähle ein paar Themen. Die wichtigsten Nachrichten kommen trotzdem immer zuerst, und jede dritte Karte ist etwas allgemein Wichtiges.</p>${chipsHTML(list, sel)}<button class="btn" id="go">Feed starten</button>`, () => { st.onboarded = true; saveSt(); });
  wireChips(sel);
  $("go").onclick = () => { sel.forEach((c) => bump(c, 3)); st.onboarded = true; saveSt(); closeSheet(); resetFeed(); };
}
function forYou() {
  const keys = Object.keys(st.interest).sort((a, b) => st.interest[b] - st.interest[a]).slice(0, 12);
  const max = Math.max(1, ...keys.map((k) => st.interest[k]));
  const name = (k) => k.startsWith("r:") ? REGION[k.slice(2)] || k : k.startsWith("t:") ? k.slice(2) : k;
  const rows = keys.length ? keys.map((k) => `<div class="ibar"><b>${esc(name(k))}</b><div><i style="width:${Math.round(st.interest[k] / max * 100)}%"></i></div><span>${st.interest[k]}</span></div>`).join("") : `<p class="note">Noch keine Interessen. Lies ein paar Karten, dann lernt der Feed dazu.</p>`;
  const ai = AI && AI.provider ? `KI: ${esc(AI.provider)} (${esc(AI.model || "")})` : "Ohne KI-Schlüssel: nur Schlagzeilen";
  showSheet("", "<span>Für dich</span>", `<h3 id="sheet-title">So entsteht dein Feed</h3><p class="lead">Zuerst kommen die zwei wichtigsten aktuellen Meldungen. Danach sortiert die App nach deinen Interessen, aber jede dritte Karte ist wieder allgemein wichtig, damit du nicht in einer Blase landest.</p><h4>Deine Interessen</h4>${rows}<p class="note">Punkte gibt es für Lesezeit, Seitenwechsel, gelesene Beiträge und Abstimmungen. Alles bleibt nur auf diesem Gerät.</p><p class="note">Nachrichten zuletzt aktualisiert: ${GENERATED ? ago(GENERATED) : "unbekannt"} · ${ITEMS.length} Karten · ${ai}</p><button class="btn" id="reset">Interessen zurücksetzen</button>`);
  $("reset").onclick = () => { st.interest = {}; saveSt(); closeSheet(); };
}
$("foryou").onclick = forYou;

/* ---------- Feed ---------- */
const feed = $("feed");
let round = 0, queue = [], finished = false;
const dwell = new Map();
const io = new IntersectionObserver((es) => es.forEach((e) => {
  const el = e.target, it = el._it;
  if (e.isIntersecting) { dwell.set(el, Date.now()); if (el === feed.lastElementChild) appendMore(3); }
  else if (dwell.has(el)) {
    const sec = (Date.now() - dwell.get(el)) / 1000; dwell.delete(el);
    if (it && sec > 1.5 && !st.seen[it.id]) { st.seen[it.id] = Date.now(); saveSt(); }
    if (it && sec > 6) { const n = Math.min(2, sec / 15); bump(it.cat, n); bump("r:" + it.region, n / 2); }
  }
}), { root: feed, threshold: 0.6 });

function wire(art, it) {
  art._it = it;
  art.querySelectorAll(".more").forEach((b) => (b.onclick = () => openArticle(it, b.dataset.side)));
  if (it.typ === "debatte") {
    const pan = art.querySelector(".pan"), tabs = [...art.querySelectorAll(".tabs button")], seenSide = new Set();
    tabs.forEach((b) => (b.onclick = () => pan.scrollTo({ left: pan.clientWidth * +b.dataset.p, behavior: "smooth" })));
    pan.addEventListener("scroll", () => { const p = Math.round(pan.scrollLeft / pan.clientWidth); tabs.forEach((b, k) => b.classList.toggle("on", k === p)); if (p >= 1 && p <= 3 && !seenSide.has(p)) { seenSide.add(p); bump(it.cat, 0.5); } }, { passive: true });
    art.querySelectorAll(".scale button").forEach((b) => (b.onclick = () => { const v = +b.dataset.v; if (st.votes[it.id] == null) bump(it.cat, 1); st.votes[it.id] = v; saveSt(); art.querySelectorAll(".scale button").forEach((x) => x.classList.toggle("on", x === b)); }));
  }
  io.observe(art);
}
function infoCard(html, cls = "done") { const el = document.createElement("section"); el.className = cls; el.innerHTML = html; return el; }
function doneCard() {
  const quatsch = ITEMS.some((i) => i.typ === "quatsch") && filter !== "quatsch";
  const el = infoCard(`<div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div><div class="cat">Geschafft</div><h2>Du bist auf dem neuesten Stand.</h2><p class="lead">Neue Meldungen kommen etwa alle 30 Minuten dazu. Wenn du weiterscrollst, siehst du ältere Karten, sortiert nach deinen Interessen.</p>${quatsch ? `<button id="toQuatsch">Zum Quatsch zum Abschalten</button>` : ""}<button id="toTop">Nochmal von oben</button>`);
  el.querySelector("#toTop").onclick = () => feed.scrollTo({ top: 0, behavior: "smooth" });
  const q = el.querySelector("#toQuatsch"); if (q) q.onclick = () => setFilter("quatsch");
  return el;
}
function appendMore(n) {
  for (let k = 0; k < n && !finished; k++) {
    if (!queue.length) {
      if (round === 0) { feed.appendChild(doneCard()); io.observe(feed.lastElementChild); round = 1; queue = buildRound(1); if (!queue.length) finished = true; continue; }
      feed.appendChild(infoCard(`<div class="cat">Ende</div><h2>Das war alles.</h2><p class="lead">Mehr gibt es gerade nicht. Schau später wieder rein.</p>`)); finished = true; break;
    }
    const { it, reason } = queue.shift();
    const wrap = document.createElement("div"); wrap.innerHTML = topicHTML(it, reason);
    const art = wrap.firstElementChild; feed.appendChild(art); wire(art, it);
  }
}
function resetFeed() {
  io.disconnect(); dwell.clear(); feed.innerHTML = ""; feed.scrollTop = 0; round = 0; finished = false; queue = buildRound(0);
  if (!queue.length && !ITEMS.some(inFilter)) { feed.appendChild(infoCard(`<div class="cat">Leer</div><h2>Hier ist gerade nichts.</h2><p class="lead">In diesem Filter gibt es noch keine Karten.</p>`, "status")); return; }
  appendMore(3);
}
function setFilter(f) { filter = f; document.querySelectorAll("#filters button").forEach((b) => b.classList.toggle("on", b.dataset.f === f)); resetFeed(); }
document.querySelectorAll("#filters button").forEach((b) => (b.onclick = () => setFilter(b.dataset.f)));

document.addEventListener("keydown", (e) => {
  if (!sheet.hidden) return;
  const a = [...feed.children][Math.round(feed.scrollTop / feed.clientHeight)]; if (!a || !a.classList.contains("topic")) return;
  const pan = a.querySelector(".pan");
  if (e.key === "ArrowRight") pan.scrollBy({ left: pan.clientWidth, behavior: "smooth" });
  if (e.key === "ArrowLeft") pan.scrollBy({ left: -pan.clientWidth, behavior: "smooth" });
});

/* ---------- Laden ---------- */
async function load() {
  const r = await fetch("data/feed.json", { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  ITEMS = (j.items || []).filter((i) => i && i.id && i.title); GENERATED = j.generated; AI = j.ai; loadedAt = Date.now();
}
async function maybeRefresh() {
  if (Date.now() - loadedAt < 10 * 60e3) return;
  try { const before = GENERATED; await load(); if (GENERATED !== before && feed.scrollTop < feed.clientHeight * 1.5 && sheet.hidden) resetFeed(); } catch (e) {}
}
(async () => {
  try { await load(); resetFeed(); if (!st.onboarded) onboarding(); }
  catch (e) { feed.innerHTML = ""; feed.appendChild(infoCard(`<div class="cat">Keine Verbindung</div><h2>Nachrichten konnten nicht geladen werden.</h2><p class="lead">Prüfe deine Internetverbindung und öffne die App erneut.</p>`, "status")); }
})();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
