// Zwei Seiten – Cronjob: Quellen abrufen, bündeln, Karten schreiben (Gemini, Ersatz Groq), prüfen, feed.json schreiben.
// Aufruf: node scripts/update.mjs   (DATA_DIR=Ordner des data-Branches, Standard ./data)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

const DATA = process.env.DATA_DIR || "data";
const MAX_AI = +(process.env.MAX_AI_PER_RUN || 5);          // höchstens so viele KI-Karten pro Lauf
const MAX_AGE_H = 48;                                       // ältere Meldungen beim Abruf ignorieren
const KEEP_DAYS = 30;                                       // Karten so lange im Feed halten
const MAX_ITEMS = 250;                                      // Obergrenze im Feed
const NOW = Date.now();
const FIXTURES = process.env.FIXTURES || "";                 // Test: Ordner mit <id>.xml/<id>.json statt Netz

const log = (...a) => console.log(...a);
const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const writeJSON = (p, o) => writeFileSync(p, JSON.stringify(o, null, 1));
const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();

mkdirSync(DATA, { recursive: true });
const { sources: SOURCES } = JSON.parse(readFileSync(new URL("./sources.json", import.meta.url), "utf8"));
const SRC = Object.fromEntries(SOURCES.map((s) => [s.id, s]));
const state = readJSON(`${DATA}/state.json`, { seen: {}, cards: {} });
const feed = readJSON(`${DATA}/feed.json`, { items: [] });
const status = { run: iso(NOW), sources: {}, ai: { provider: null, model: null, written: 0, failed: 0, note: "" } };

/* ---------- 1. Abrufen ---------- */
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#t", trimValues: true });
const text = (v) => (v == null ? "" : typeof v === "object" ? (v["#t"] ?? v["@href"] ?? "") : String(v));
const clean = (s) => text(s).replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

async function get(src) {
  if (FIXTURES) {
    const f = `${FIXTURES}/${src.id}.${src.type === "tagesschau" ? "json" : "xml"}`;
    if (!existsSync(f)) throw new Error("keine Testdatei");
    return readFileSync(f, "utf8");
  }
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(src.url, { signal: ctl.signal, headers: { "User-Agent": "ZweiSeitenBot/1.0 (+https://github.com/A28J09J02/zwei-seiten)", Accept: "application/rss+xml, application/xml, application/json, */*" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

function parse(src, body) {
  const out = [];
  const push = (title, teaser, url, date) => {
    title = clean(title); url = text(url).trim(); if (!title || !url) return;
    const d = Date.parse(date); const ts = isNaN(d) ? NOW : Math.min(d, NOW);
    if (NOW - ts > MAX_AGE_H * 3600e3) return;
    out.push({ id: hash(url), url, title, teaser: clean(teaser).slice(0, 420), ts, src: src.id });
  };
  if (src.type === "tagesschau") {
    const j = JSON.parse(body);
    for (const n of arr(j.news)) {
      if (n.type && n.type !== "story") continue;
      push(n.topline ? `${n.topline}: ${n.title}` : n.title, n.firstSentence || "", n.shareURL || n.detailsweb, n.date);
    }
    return out;
  }
  const j = xml.parse(body);
  const items = [...arr(j?.rss?.channel?.item), ...arr(j?.["rdf:RDF"]?.item), ...arr(j?.feed?.entry)];
  for (const it of items) {
    const link = it.link ? (Array.isArray(it.link) ? (it.link.find((l) => l["@rel"] !== "self") || it.link[0]) : it.link) : it.guid;
    push(it.title, it.description || it.summary || it["content:encoded"] || "", text(link), text(it.pubDate || it["dc:date"] || it.updated || it.published));
  }
  return out;
}

const fresh = [];
await Promise.all(SOURCES.map(async (src) => {
  try {
    const items = parse(src, await get(src));
    status.sources[src.id] = { ok: true, items: items.length };
    for (const it of items) if (!state.seen[it.id]) { fresh.push(it); }
  } catch (e) {
    status.sources[src.id] = { ok: false, error: String(e.message || e).slice(0, 120) };
  }
}));
log(`Abgerufen: ${Object.values(status.sources).filter((s) => s.ok).length}/${SOURCES.length} Quellen, ${fresh.length} neue Meldungen`);

/* ---------- 2. Bündeln ---------- */
const STOP = new Set(("aber alle allem als also auch auf aus bei beim bis das dass dem den der des die dies diese dieser doch durch eine einem einen einer eines etwa für gegen hat hatte haben hier ihre ihren immer jetzt kann kein keine mehr mit nach neue neuen nicht noch nun nur oder ohne sein sich sie sind soll sollen über um und uns unter vom von vor war was weil wenn werden wie will wird wir zum zur zwei drei jahr jahre jahren prozent sagt sagte heute neues erste ersten "
  + "about after again also amid been before being could does from have here into just last more most must news over said says than that their them then there these they this those under were what when which while will with would year years your first new week today told amid live update updates video watch").split(" "));
const tok = (s) => [...new Set(s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ß ]+/g, " ").split(" ").filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)))];
const sim = (a, b) => { const B = new Set(b); let n = 0; for (const w of a) if (B.has(w)) n++; return { n, r: n / Math.max(1, Math.min(a.length, b.length)) }; };
const close = (a, b) => { const s = sim(a, b); return (s.n >= 3 && s.r >= 0.25) || s.n >= 5; };

for (const it of fresh) { it.tok = tok(`${it.title} ${it.teaser.split(" ").slice(0, 25).join(" ")}`); it.lang = SRC[it.src].lang; }

// erst an bestehende Karten anhängen, dann neue Bündel bilden
const cards = state.cards;
const clusters = [];
for (const it of fresh) {
  const card = Object.values(cards).find((c) => c.lang === it.lang && NOW - c.updated < 36 * 3600e3 && close(it.tok, c.tok));
  if (card) { if (!card.items.some((x) => x.id === it.id)) { card.items.push(slim(it)); card.newSince = (card.newSince || 0) + 1; } continue; }
  const cl = clusters.find((c) => c.lang === it.lang && close(it.tok, c.tok));
  if (cl) { cl.items.push(slim(it)); cl.tok = [...new Set([...cl.tok, ...it.tok])].slice(0, 60); }
  else clusters.push({ lang: it.lang, tok: it.tok.slice(0, 60), items: [slim(it)] });
}
function slim(it) { return { id: it.id, url: it.url, title: it.title, teaser: it.teaser, ts: it.ts, src: it.src }; }
for (const it of fresh) state.seen[it.id] = NOW;

for (const cl of clusters) {
  const id = hash(cl.items.map((x) => x.id).sort().join());
  cards[id] = { id, lang: cl.lang, tok: cl.tok, items: cl.items, created: NOW, updated: NOW, gen: null, newSince: cl.items.length };
}

/* ---------- 3. Gewichten ---------- */
function score(c) {
  const srcs = new Set(c.items.map((x) => x.src)), leans = new Set([...srcs].map((s) => SRC[s]?.lean));
  const boost = c.items.some((x) => SRC[x.src]?.boost) ? 3 : 0;
  const ageH = (NOW - Math.max(...c.items.map((x) => x.ts))) / 3600e3;
  return srcs.size * 2 + leans.size + boost - Math.min(6, ageH / 4);
}
const isQuatsch = (c) => c.items.every((x) => SRC[x.src]?.kind === "quatsch");
const eligible = (c) => isQuatsch(c) || new Set(c.items.map((x) => x.src)).size >= 2 || c.items.some((x) => SRC[x.src]?.boost);
const region = (c) => { const n = {}; for (const x of c.items) { const r = SRC[x.src]?.region || "welt"; n[r] = (n[r] || 0) + 1; } return Object.entries(n).sort((a, b) => b[1] - a[1])[0][0]; };

/* ---------- 4. KI ---------- */
const GEMINI = process.env.GEMINI_API_KEY, GROQ = process.env.GROQ_API_KEY;
let geminiModel = process.env.GEMINI_MODEL || null, aiDown = false;

async function pickGemini() {
  if (geminiModel) return geminiModel;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${GEMINI}`);
    const j = await r.json();
    const names = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace("models/", ""))
      .filter((n) => /flash/.test(n) && !/lite|image|tts|live|audio|embed|exp|preview|thinking/.test(n));
    const ver = (n) => +((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
    names.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
    geminiModel = names[0] || "gemini-2.5-flash";
  } catch { geminiModel = "gemini-2.5-flash"; }
  return geminiModel;
}

async function callGemini(prompt) {
  const model = await pickGemini();
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.3 } }),
  });
  if (r.status === 429) throw Object.assign(new Error("Gemini-Limit erreicht"), { limit: true });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { text: j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "", provider: "gemini", model };
}

async function callGroq(prompt) {
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ}` },
    body: JSON.stringify({ model, temperature: 0.3, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }),
  });
  if (r.status === 429) throw Object.assign(new Error("Groq-Limit erreicht"), { limit: true });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { text: j.choices?.[0]?.message?.content || "", provider: "groq", model };
}

async function ai(prompt) {
  let err;
  if (GEMINI && !ai.geminiOff) { try { return await callGemini(prompt); } catch (e) { err = e; if (e.limit) ai.geminiOff = true; log("Gemini:", e.message); } }
  if (GROQ && !ai.groqOff) { try { return await callGroq(prompt); } catch (e) { err = e; if (e.limit) ai.groqOff = true; log("Groq:", e.message); } }
  if ((!GEMINI || ai.geminiOff) && (!GROQ || ai.groqOff)) aiDown = true;
  throw err || new Error("keine KI verfügbar");
}

const CATS = "Politik, Wirtschaft, Soziales, Migration, Sicherheit, Außenpolitik, Klima, Gesundheit, Bildung, Justiz, Verkehr, Wohnen, Rente, Technik, Wissenschaft, Sport, Kultur, Unglück, Quatsch";
const ICONS = "shield, euro, speed, house, clock, border, globe, leaf, chart, scale, heart, bolt, school, news";

function promptFor(c) {
  const lines = c.items.slice(0, 14).map((x, i) => { const s = SRC[x.src]; return `[s${i + 1}] ${s.name} (Grundtendenz ${s.lean}, ${new Date(x.ts).toISOString().slice(0, 16)}): ${x.title} — ${x.teaser}`; }).join("\n");
  return `Du bist Redakteur der Nachrichten-App "Zwei Seiten". Unten stehen Meldungen verschiedener Medien zum selben Ereignis. Schreibe daraus EINE Karte auf Deutsch als JSON.

STRENGE REGELN
- Verwende ausschließlich Fakten aus den Meldungen unten. Nichts aus eigenem Wissen ergänzen, keine Zahlen schätzen, keine Namen erfinden.
- Jede Aussage bekommt den Schlüssel der Meldung, aus der sie stammt (z. B. "s2"). Nur Schlüssel von unten verwenden.
- Eigene Worte, keine wörtlichen Zitate über 10 Wörter. Keine Wertung.
- typ "debatte" NUR wenn die Meldungen erkennbar Positionen verschiedener politischer Lager enthalten (Parteien, Verbände, Regierung, Opposition). Positionen nur Akteuren zuschreiben, die laut Meldung genau das vertreten. Links/Mitte/rechts nach den Akteuren, nicht nach dem Medium. Alle drei Seiten gleich lang und gleich stark. Ist eine Seite nicht belegbar, nimm typ "meldung".
- typ "quatsch" nur für kuriose, harmlose Meldungen zum Schmunzeln (keine Unglücke, keine Opfer).
- Sonst typ "meldung".
- cat: eine aus [${CATS}]. icon: eines aus [${ICONS}].
- title: höchstens 80 Zeichen, bei debatte als Frage. lead: 2–3 neutrale Sätze.

JSON-FORMAT
{"typ":"meldung|debatte|quatsch","cat":"…","icon":"…","title":"…","lead":"…",
 "facts":[["Kurzes Label","Wert","s1"]]  (0–3 Einträge, nur echte Zahlen/Daten aus den Meldungen),
 "points":[["Ein Satz.","s1"]]  (bei meldung/quatsch 2–4 Einträge, bei debatte weglassen),
 "L":{"who":"Vertreten u. a. von …","thesis":"kurzer Satz","a":[["Stichwort","Ein Satz.","s1"]],"long":["Absatz","Absatz"]},
 "M":{…gleich…},"R":{…gleich…}  (nur bei debatte; je 2–3 Einträge in a, je 2 Absätze in long)}

MELDUNGEN
${lines}`;
}

function validate(card, n) {
  const keys = new Set(Array.from({ length: n }, (_, i) => `s${i + 1}`));
  const okKey = (k) => keys.has(k);
  if (!card || !["meldung", "debatte", "quatsch"].includes(card.typ)) return "typ fehlt";
  if (!card.title || card.title.length > 110 || !card.lead) return "titel/lead";
  card.facts = (card.facts || []).filter((f) => Array.isArray(f) && f.length === 3 && okKey(f[2])).slice(0, 3);
  if (card.typ === "debatte") {
    const lens = [];
    for (const k of ["L", "M", "R"]) {
      const s = card[k];
      if (!s || !s.thesis || !s.who || !Array.isArray(s.a) || s.a.length < 2 || !Array.isArray(s.long) || !s.long.length) return `seite ${k} unvollständig`;
      if (!s.a.every((a) => Array.isArray(a) && a.length === 3 && okKey(a[2]))) return `seite ${k} ohne gültige quelle`;
      lens.push(JSON.stringify(s.a).length + s.long.join("").length);
    }
    if (Math.max(...lens) / Math.max(1, Math.min(...lens)) > 2) return "seiten ungleich lang";
    delete card.points;
  } else {
    card.points = (card.points || []).filter((p) => Array.isArray(p) && p.length === 2 && okKey(p[1]));
    if (!card.points.length) return "keine belegten punkte";
    delete card.L; delete card.M; delete card.R;
  }
  return null;
}

function sourcesOf(c) {
  const out = {};
  c.items.slice(0, 14).forEach((x, i) => { const s = SRC[x.src]; out[`s${i + 1}`] = { o: s.name, t: x.title, u: x.url, d: iso(x.ts), lean: s.lean }; });
  return out;
}

function rawCard(c) {
  const pref = ["tagesschau", "ntv", "tagesspiegel", "bbc-world", "dw", "cbs", "thehill", "npr"];
  const items = [...c.items].sort((a, b) => (pref.indexOf(a.src) + 99) % 99 - (pref.indexOf(b.src) + 99) % 99);
  const main = items[0], idx = (x) => `s${c.items.indexOf(x) + 1}`;
  return { typ: isQuatsch(c) ? "quatsch" : "meldung", cat: isQuatsch(c) ? "Quatsch" : "Aktuell", icon: "news", title: main.title, lead: main.teaser || "",
    points: items.slice(1, 4).filter((x) => x.teaser).map((x) => [x.teaser.split(/(?<=[.!?])\s/)[0].slice(0, 220), idx(x)]), facts: [] };
}

const hasAI = !!(GEMINI || GROQ);
const candidates = Object.values(cards).filter((c) => eligible(c) && (c.gen === null || (c.gen === "raw" && (hasAI || c.newSince > 0)) || (c.gen === "ai" && c.newSince >= 2 && NOW - c.created < 24 * 3600e3)))
  .sort((a, b) => score(b) - score(a));
let aiBudget = MAX_AI;
for (const c of candidates) {
  let card = null, gen = "raw";
  if ((GEMINI || GROQ) && !aiDown && aiBudget > 0) {
    aiBudget--;
    try {
      const res = await ai(promptFor(c));
      status.ai.provider = res.provider; status.ai.model = res.model;
      const parsed = JSON.parse(res.text.replace(/^```(json)?|```$/g, "").trim());
      const err = validate(parsed, Math.min(14, c.items.length));
      if (err) { status.ai.failed++; log(`Verworfen (${err}): ${c.items[0].title}`); }
      else { card = parsed; gen = "ai"; status.ai.written++; }
      await sleep(4500);
    } catch (e) { status.ai.failed++; status.ai.note = String(e.message).slice(0, 160); }
  }
  if (!card) { if (c.gen === "ai") { c.newSince = 0; continue; } card = rawCard(c); }
  c.gen = gen; c.newSince = 0; c.updated = NOW;
  c.card = { ...card, sources: sourcesOf(c), region: region(c), prio: 0, ai: gen === "ai" };
}
if (!GEMINI && !GROQ) status.ai.note = "Kein KI-Schlüssel gesetzt: nur Schlagzeilen-Karten.";

/* ---------- 5. Feed schreiben ---------- */
const keepCut = NOW - KEEP_DAYS * 864e5;
for (const [id, c] of Object.entries(cards)) if (c.updated < keepCut || (!c.card && NOW - c.updated > 36 * 3600e3)) delete cards[id];
for (const c of Object.values(cards)) if (c.items.length > 20) c.items = c.items.slice(0, 20);
for (const [id, t] of Object.entries(state.seen)) if (t < NOW - 4 * 864e5) delete state.seen[id];

const built = Object.values(cards).filter((c) => c.card).map((c) => {
  const s = score(c);
  return { id: c.id, ...c.card, prio: c.card.typ === "quatsch" ? 1 : s >= 9 ? 3 : s >= 5 ? 2 : 1, upd: iso(Math.max(...c.items.map((x) => x.ts))), created: iso(c.created), nsrc: new Set(c.items.map((x) => x.src)).size };
});
const editorial = (feed.items || []).filter((x) => x.editorial && Date.parse(x.created) > keepCut);
const items = [...built, ...editorial].sort((a, b) => Date.parse(b.upd) - Date.parse(a.upd)).slice(0, MAX_ITEMS);

writeJSON(`${DATA}/feed.json`, { generated: iso(NOW), ai: status.ai, items });
writeJSON(`${DATA}/state.json`, state);
writeJSON(`${DATA}/status.json`, status);
log(`Feed: ${items.length} Karten (${status.ai.written} neu per KI, ${status.ai.failed} KI-Fehler). ${status.ai.note}`);
