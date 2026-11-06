// Zwei Seiten – Cronjob: Quellen abrufen, bündeln, Karten schreiben (Gemini, Ersatz Groq), prüfen, feed.json schreiben.
// Aufruf: node scripts/update.mjs   (DATA_DIR=Ordner des data-Branches, Standard ./data)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

const DATA = process.env.DATA_DIR || "data";
const MAX_AI = +(process.env.MAX_AI_PER_RUN || 6);          // höchstens so viele volle KI-Karten pro Lauf
const MAX_SHORT = +(process.env.MAX_SHORT_PER_RUN || 100);  // Kurzfassungen pro Lauf (in Sammelaufrufen à 20)
const MAX_IMG = +(process.env.MAX_IMG_PER_RUN || 50);       // Bildsuchen pro Lauf
const MAX_AGE_H = 48;                                       // ältere Meldungen beim Abruf ignorieren
const KEEP_DAYS = 30;                                       // Karten so lange im Feed halten
const MAX_ITEMS = 300;                                      // Karten in feed.json (Rest in archive.json)
const MAX_ARCHIVE = 1500;                                   // Karten in archive.json
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
const clean = (s) => text(s).replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&(rsquo|lsquo);/g, "’").replace(/&(rdquo|ldquo);/g, "”").replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&hellip;/g, "…").replace(/\s+/g, " ").trim();
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
    const maxAge = src.kind === "experte" ? 21 * 24 : src.kind === "meinung" ? 5 * 24 : MAX_AGE_H;   // Fachbeiträge bleiben länger relevant
    if (NOW - ts > maxAge * 3600e3) return;
    out.push({ id: hash(url), url, title, teaser: clean(teaser).slice(0, 700), ts, src: src.id });
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
    for (const it of items) {
      if (state.seen[it.id]) continue;
      if (src.kind === "meinung" || src.kind === "experte") { (state.opinions ||= {})[it.id] = { id: it.id, url: it.url, title: it.title, teaser: it.teaser, ts: it.ts, src: it.src }; state.seen[it.id] = NOW; }
      else fresh.push(it);
    }
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
const isQuatsch = (c) => false; // Quatsch entscheidet nur noch die KI (plus Wortfilter)
const NOT_FUNNY = /\b(tot|tote|toten|getötet|stirbt|starb|gestorben|leiche|verletzt|mord|ermordet|tötung|vergewalt|missbrauch|sexuell|unfall|verunglückt|absturz|brand|feuer|explosion|anklage|angeklagt|verurteilt|prozess|haft|gefängnis|krieg|terror|anschlag|schüsse|waffe|messer|opfer|krank|krebs|tumor|suizid|selbstmord|kind(er)? (vermisst|entführt)|entführ|katastrophe|flut|erdbeben|dead|killed|dies|died|murder|rape|abuse|crash|injur|shooting|war\b|terror|victim|cancer|suicide|convicted|charged|sentenced|trial)/i;
const funnyOK = (t) => !NOT_FUNNY.test(t || "");
const eligible = (c) => true;  // auch Einzelmeldungen; Gewichtung über score()
const region = (c) => { const n = {}; for (const x of c.items) { const r = SRC[x.src]?.region || "welt"; n[r] = (n[r] || 0) + 1; } return Object.entries(n).sort((a, b) => b[1] - a[1])[0][0]; };

/* ---------- 4. KI ---------- */
const GEMINI = process.env.GEMINI_API_KEY, GROQ = process.env.GROQ_API_KEY;
let geminiModel = process.env.GEMINI_MODEL || null, aiDown = false;

// Liste geeigneter Flash-Modelle, neueste zuerst; "lite" nur als letzte Reserve.
let geminiModels = null;
const busy = new Set();
async function pickGemini() {
  if (geminiModels) return geminiModels;
  let names = [];
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${GEMINI}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    names = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace("models/", ""))
      .filter((n) => /^gemini-[\d.]+-flash/.test(n) && !/image|tts|live|audio|embed|exp|preview|thinking/.test(n));
  } catch {}
  const ver = (n) => +((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const lite = (n) => /lite/.test(n) ? 1 : 0;
  names.sort((a, b) => lite(a) - lite(b) || ver(b) - ver(a) || a.length - b.length);
  geminiModels = [...new Set([...(geminiModel ? [geminiModel] : []), ...names, "gemini-2.5-flash", "gemini-2.5-flash-lite"])];
  log("Gemini-Modelle:", geminiModels.join(", "));
  return geminiModels;
}

async function callGemini(prompt) {
  let last = null, limited = 0;
  const models = (await pickGemini()).filter((m) => !busy.has(m));
  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(90000),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.3 } }),
      });
      if (r.ok) {
        const j = await r.json();
        return { text: j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "", provider: "gemini", model };
      }
      last = new Error(`Gemini ${model} HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      if (r.status === 429) limited++;
      if (r.status === 401 || r.status === 403) throw last;   // Schlüssel ungültig: andere Modelle helfen nicht
      busy.add(model);                                         // überlastet/Limit/nicht vorhanden: für diesen Lauf überspringen
    } catch (e) {
      if (String(e.message).includes("HTTP 40") && !String(e.message).includes("HTTP 404")) throw e;
      last = e; busy.add(model);
    }
  }
  if (limited && limited === models.length) throw Object.assign(new Error("Gemini-Limit erreicht"), { limit: true });
  if (!models.length || busy.size >= (geminiModels || []).length) ai.geminiOff = true;
  throw last || new Error("kein Gemini-Modell verfügbar");
}

async function callGroq(prompt) {
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ}` }, signal: AbortSignal.timeout(90000),
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
  return `Du bist Redakteur der Nachrichten-App "Zwei Seiten". Unten stehen Meldungen verschiedener Medien zum selben Ereignis, teils auf Englisch. Schreibe daraus EINE Karte komplett auf Deutsch als JSON.

STRENGE REGELN
- Alles auf Deutsch, auch wenn die Meldungen englisch sind. Namen bleiben, Ämter und Begriffe werden übersetzt.
- Verwende ausschließlich Fakten aus den Meldungen unten. Nichts aus eigenem Wissen ergänzen, keine Zahlen schätzen, keine Namen erfinden.
- Jede Aussage bekommt den Schlüssel der Meldung, aus der sie stammt (z. B. "s2"). Nur Schlüssel von unten verwenden.
- Komplett eigene Worte, keine Sätze aus den Meldungen übernehmen, keine wörtlichen Zitate über 8 Wörter. Keine Wertung.
- typ "debatte" NUR wenn die Meldungen erkennbar Positionen verschiedener politischer Lager enthalten (Parteien, Verbände, Regierung, Opposition). Positionen nur Akteuren zuschreiben, die laut Meldung genau das vertreten. Links/Mitte/rechts nach den Akteuren, nicht nach dem Medium. Alle drei Seiten gleich lang und gleich stark. Ist eine Seite nicht belegbar, nimm typ "meldung".
- typ "quatsch" NUR wenn die Meldung wirklich lustig, kurios und völlig harmlos ist, zum Lachen oder Schmunzeln (z. B. Tiere in absurden Situationen, skurrile Rekorde, verrückte Missgeschicke ohne Schaden). NIEMALS bei Tod, Verletzten, Verbrechen, Gewalt, Prozessen, Unfällen, Krankheit, Katastrophen, Politik oder Promi-Skandalen.
- Sonst typ "meldung".
- cat: eine aus [${CATS}]. icon: eines aus [${ICONS}].
- title: höchstens 70 Zeichen, bei debatte als Frage. lead: 2–3 neutrale Sätze, zusammen höchstens 380 Zeichen.
- long: ausführliche Fassung in 3–5 Absätzen (je 2–4 Sätze): was passiert ist, Hintergrund, wer was sagt, wie es weitergeht – aber NUR mit Fakten aus den Meldungen. Wenn die Meldungen wenig hergeben, lieber 2 Absätze als erfinden.
- bild: englischer Suchbegriff (2–4 Wörter) für ein passendes Foto eines ORTES, GEBÄUDES, GEGENSTANDS oder SYMBOLS (z. B. "Reichstag building Berlin", "Wall Street sign", "wind turbines"). NIEMALS eine Person, kein Name einer Person, kein Logo, keine Parteisymbole, keine Opfer, keine Unglücksorte. Lieber allgemein (z. B. "German parliament plenary hall") als zu speziell. Wenn nichts Neutrales passt: "".

JSON-FORMAT
{"typ":"meldung|debatte|quatsch","cat":"…","icon":"…","bild":"…","title":"…","lead":"…",
 "facts":[["Kurzes Label","Wert","s1"]]  (0–3 Einträge, nur echte Zahlen/Daten aus den Meldungen),
 "long":["Absatz","Absatz","Absatz"],
 "points":[["Ein kurzer Satz.","s1"]]  (bei meldung/quatsch 3–4 Einträge, bei debatte weglassen),
 "L":{"who":"Vertreten u. a. von …","thesis":"kurzer Satz","a":[["Stichwort","Ein kurzer Satz.","s1"]],"long":["Absatz","Absatz"]},
 "M":{…gleich…},"R":{…gleich…}  (nur bei debatte; je 3 Einträge in a, je 2 Absätze in long)}

MELDUNGEN
${lines}`;
}

function promptShort(list) {
  const blocks = list.map((c) => `### ${c.id}\n` + c.items.slice(0, 6).map((x, i) => `[s${i + 1}] ${SRC[x.src].name}: ${x.title} — ${x.teaser.slice(0, 400)}`).join("\n")).join("\n\n");
  return `Du bist Redakteur einer deutschen Nachrichten-App. Unten stehen mehrere Ereignisse (jeweils mit ### und einer ID), teils auf Englisch. Schreibe für JEDES Ereignis eine Karte komplett auf Deutsch.

REGELN
- Nur Fakten aus den Meldungen, nichts ergänzen. Komplett eigene Worte, keine Sätze übernehmen. Neutral, ohne Wertung.
- title: höchstens 70 Zeichen. lead: 2–3 Sätze, höchstens 350 Zeichen.
- points: 1–3 weitere Fakten als kurze Sätze, jeweils mit dem Schlüssel der Meldung ([s1], [s2] …), aus der sie stammen. Keine Wiederholung des leads. Wenn nichts Weiteres drinsteht: [].
- cat: eine aus [${CATS}]. icon: eines aus [${ICONS}]. quatsch: true NUR wenn die Meldung wirklich lustig, kurios und völlig harmlos ist (zum Lachen). Niemals bei Tod, Verletzten, Verbrechen, Gewalt, Prozessen, Unfällen, Krankheit, Katastrophen, Politik oder Promi-Skandalen.
- bild: englischer Suchbegriff (2–4 Wörter) für ein Foto eines Ortes, Gebäudes, Gegenstands oder Symbols. NIEMALS Personen, Logos, Parteisymbole, Opfer oder Unglücksorte. Sonst "".

- witzig: 0–10, wie lustig die Meldung für normale Leser ist (10 = zum Lachen, 0 = ernst). Promi-News, Film-, Serien- und Sportmeldungen sind NICHT witzig.

Antworte als JSON-Objekt: {"<ID>":{"title":"…","lead":"…","points":[["Satz.","s1"]],"cat":"…","icon":"…","bild":"…","quatsch":false,"witzig":0}, …}

EREIGNISSE
${blocks}`;
}

function validate(card, n) {
  const keys = new Set(Array.from({ length: n }, (_, i) => `s${i + 1}`));
  const okKey = (k) => keys.has(k);
  if (!card || !["meldung", "debatte", "quatsch"].includes(card.typ)) return "typ fehlt";
  if (!card.title || card.title.length > 110 || !card.lead) return "titel/lead";
  card.facts = (card.facts || []).filter((f) => Array.isArray(f) && f.length === 3 && okKey(f[2])).slice(0, 3);
  card.bild = typeof card.bild === "string" ? card.bild.slice(0, 60) : "";
  card.long = Array.isArray(card.long) ? card.long.filter((x) => typeof x === "string" && x.length > 20).slice(0, 5) : [];
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
    card.points = (card.points || []).filter((p) => Array.isArray(p) && p.length === 2 && okKey(p[1])).slice(0, 4);
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

/* Bilder: nur frei lizenzierte Fotos von Wikimedia Commons, mit Urheberangabe */
const FREE = /^(cc0|public domain|pd|cc[ -]by(-sa)?([ -][\d.]+)?)/i;
const PERSONISH = /portrait|porträt|accepting|_with_|\b(18|19)\d\d\b|mr\.|mrs\.|selfie|headshot/i;
const NOT_FREE = /\bnc\b|non-?commercial|\bnd\b|noderivs|fair use/i;
async function commonsImage(term) {
  if (!term || FIXTURES) return null;
  try {
    const u = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${encodeURIComponent(term + " filetype:bitmap")}&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=900`;
    const r = await fetch(u, { headers: { "User-Agent": "ZweiSeitenBot/1.0 (https://github.com/A28J09J02/zwei-seiten)" }, signal: AbortSignal.timeout(15000) });
    const pages = Object.values((await r.json())?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    for (const p of pages) {
      const ii = p.imageinfo?.[0], m = ii?.extmetadata || {};
      const lic = (m.LicenseShortName?.value || "").trim();
      if (!ii?.thumburl || !FREE.test(lic) || NOT_FREE.test(lic)) continue;
      if (ii.width < 600 || ii.width < ii.height) continue;                       // nur Querformat in brauchbarer Größe
      if (/logo|emblem|coat[_ ]of[_ ]arms|wappen|seal[_ ]of|flag[_ ]of|insignia|signet/i.test(p.title || "")) continue; // keine Logos/Wappen (Marken, irreführend)
      if (PERSONISH.test(p.title || "")) continue;                                  // historische Aufnahmen/Porträts vermeiden
      const words = term.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
      if (words.length && !words.some((w) => (p.title || "").toLowerCase().includes(w.replace(/s$/, "")))) continue; // Dateiname muss zum Suchbegriff passen
      const cats = (m.Categories?.value || "").toLowerCase();
      if (/portrait|people|men of|women of|politicians|births|deaths/.test(cats)) continue; // keine Personenfotos
      const artist = (m.Artist?.value || "unbekannt").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
      // Bild selbst speichern und von der eigenen Seite ausliefern (keine Weitergabe von Nutzerdaten an Dritte)
      const ir = await fetch(ii.thumburl, { headers: { "User-Agent": "ZweiSeitenBot/1.0 (https://github.com/A28J09J02/zwei-seiten)" }, signal: AbortSignal.timeout(20000) });
      if (!ir.ok) continue;
      const buf = Buffer.from(await ir.arrayBuffer()); if (buf.length > 600000) continue;
      const ext = /\.png$/i.test(ii.thumburl) ? "png" : "jpg", name = `${hash(ii.thumburl)}.${ext}`;
      mkdirSync(`${DATA}/img`, { recursive: true }); writeFileSync(`${DATA}/img/${name}`, buf);
      return { src: `data/img/${name}`, page: ii.descriptionurl, artist, license: lic, licenseUrl: m.LicenseUrl?.value || "" };
    }
  } catch {}
  return null;
}

function rawCard(c) {
  const pref = ["tagesschau", "ntv", "tagesspiegel", "zeit", "spiegel", "faz", "bbc-world", "dw", "cbs", "thehill", "npr"];
  const items = [...c.items].sort((a, b) => (pref.indexOf(a.src) + 99) % 99 - (pref.indexOf(b.src) + 99) % 99);
  const main = items.find((x) => SRC[x.src].lang === "de") || items[0];
  return { typ: isQuatsch(c) ? "quatsch" : "meldung", cat: isQuatsch(c) ? "Quatsch" : "Aktuell", icon: "news", title: main.title, lead: "", points: [], facts: [], lang: SRC[main.src].lang };
}

const hasAI = !!(GEMINI || GROQ);
const isFresh = (c) => NOW - c.created < 24 * 3600e3;
const pending = Object.values(cards).filter((c) => eligible(c) && (c.gen === null || c.gen === "raw" || (c.gen === "short" && (c.newSince > 0 || hasAI)) || (c.gen === "ai" && c.newSince >= 2 && isFresh(c))))
  .sort((a, b) => score(b) - score(a));

const finish = (c, card, gen) => { c.gen = gen; c.newSince = 0; c.updated = NOW; c.card = { ...card, sources: sourcesOf(c), region: region(c), prio: 0, ai: gen === "ai" }; };

let imgBudget = MAX_IMG;
// a) volle KI-Karten für die wichtigsten Ereignisse
let aiBudget = hasAI ? MAX_AI : 0;
for (const c of pending) {
  if (aiBudget <= 0 || aiDown) break;
  if (c.gen === "short" && !isFresh(c)) continue;      // ältere Kurzkarten nicht mehr aufwerten
  aiBudget--;
  try {
    const res = await ai(promptFor(c));
    status.ai.provider = res.provider; status.ai.model = res.model;
    const parsed = JSON.parse(res.text.replace(/^```(json)?|```$/g, "").trim());
    const err = validate(parsed, Math.min(14, c.items.length));
    if (!err && parsed.typ === "quatsch" && !funnyOK(`${parsed.title} ${parsed.lead}`)) { parsed.typ = "meldung"; if (/quatsch/i.test(parsed.cat)) parsed.cat = "Aktuell"; }
    if (err) { status.ai.failed++; log(`Verworfen (${err}): ${c.items[0].title}`); }
    else {
      const noImg = /unglück|kriminal/i.test(parsed.cat || "") || parsed.typ === "quatsch";
      const img = noImg ? null : (imgBudget--, await commonsImage(parsed.bild)); delete parsed.bild;
      if (img) parsed.img = img;
      finish(c, parsed, "ai"); status.ai.written++;
    }
    await sleep(4500);
  } catch (e) { status.ai.failed++; status.ai.note = String(e.message).slice(0, 160); }
}

// b) deutsche Kurzfassung in Sammelaufrufen für alles, was noch keine KI-Karte hat
const needShort = pending.filter((c) => c.gen !== "ai" && (c.gen !== "short" || c.newSince > 0)).slice(0, MAX_SHORT);
for (let i = 0; i < needShort.length && hasAI && !aiDown; i += 12) {
  const batch = needShort.slice(i, i + 12);
  try {
    const res = await ai(promptShort(batch));
    const out = JSON.parse(res.text.replace(/^```(json)?|```$/g, "").trim());
    for (const c of batch) {
      const s = out[c.id];
      if (!s || !s.title || !s.lead || s.title.length > 110) continue;
      const n = Math.min(6, c.items.length), okKey = (k) => /^s\d+$/.test(k) && +k.slice(1) <= n;
      const pts = (Array.isArray(s.points) ? s.points : []).filter((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && okKey(p[1])).slice(0, 3);
      const funny = s.quatsch === true && +s.witzig >= 7 && funnyOK(`${s.title} ${s.lead}`) && !/promi|film|serie|streaming|konzert|schauspiel|sänger|nfl|nba|fußball|basketball/i.test(`${s.title} ${s.lead}`);
      const typ = funny ? "quatsch" : "meldung", cat = funny ? "Quatsch" : (/quatsch/i.test(s.cat || "") ? "Aktuell" : s.cat || "Aktuell");
      const card = { typ, cat, icon: s.icon || "news", title: s.title, lead: s.lead.slice(0, 420), points: pts, facts: [], short: true };
      if (imgBudget > 0 && typ !== "quatsch" && !/unglück|kriminal/i.test(cat) && s.bild) { imgBudget--; const img = await commonsImage(String(s.bild).slice(0, 60)); if (img) card.img = img; }
      finish(c, card, "short");
      status.ai.short = (status.ai.short || 0) + 1;
    }
    await sleep(4500);
  } catch (e) { status.ai.note = String(e.message).slice(0, 160); }
}

// c) ohne KI: nur Schlagzeile mit Links (kein fremder Anrisstext)
for (const c of pending) if (!c.card || (c.gen === "raw" && c.newSince > 0)) finish(c, rawCard(c), "raw");
if (!hasAI) status.ai.note = "Kein KI-Schlüssel gesetzt: nur Schlagzeilen.";

// Bestehende Quatsch-Karten nachprüfen: nur wirklich Lustiges bleibt Quatsch
for (const c of Object.values(cards)) {
  const k = c.card; if (!k || k.typ !== "quatsch") continue;
  if (!funnyOK(`${k.title} ${k.lead} ${(k.points || []).map((p) => p[0]).join(" ")}`) || /promi|film|serie|streaming|konzert|schauspiel|sänger|nfl|nba|fußball|basketball/i.test(`${k.title} ${k.lead}`) || k.short === undefined && !k.ai) { k.typ = "meldung"; if (/quatsch/i.test(k.cat || "")) k.cat = "Aktuell"; }
}

/* ---------- 4b. Debatten: strittige Fragen über viele Meldungen und Kommentare hinweg ---------- */
const DEB = (state.debates ||= {});
const DEB_RUN = +(process.env.DEBATES_PER_RUN || 3);
const DEB_DAYS = 21;
const POLCATS = /politik|soziales|migration|sicherheit|außenpolitik|klima|wirtschaft|rente|wohnen|verkehr|bildung|gesundheit|justiz|technik|aktuell/i;
for (const [id, o] of Object.entries(state.opinions || {})) if (NOW - o.ts > (SRC[o.src]?.kind === "experte" ? 21 : 5) * 864e5) delete state.opinions[id];
const sourcesOfItems = (items) => { const out = {}; items.forEach((x, i) => { const s = SRC[x.src]; out[`s${i + 1}`] = { o: s.name, t: x.title, u: x.url, d: iso(x.ts), lean: s.lean, k: s.kind }; }); return out; };
const kindLabel = (s) => s.kind === "experte" ? "Expertenbeitrag" : s.kind === "meinung" ? "Kommentar" : "Meldung";
function promptDebate(frage, items) {
  const lines = items.map((x, i) => { const s = SRC[x.src]; return `[s${i + 1}] ${s.name} (${kindLabel(s)}, Grundtendenz ${s.lean}): ${x.title} — ${x.teaser.slice(0, 500)}`; }).join("\n");
  return `Du bist Redakteur der Nachrichten-App "Zwei Seiten". Baue zur Streitfrage "${frage}" eine Debatten-Karte komplett auf Deutsch als JSON. Grundlage sind NUR die Meldungen und Kommentare unten.

REGELN
- Alles auf Deutsch, eigene Worte, keine Sätze übernehmen, keine Zitate über 8 Wörter.
- Nur Fakten und Positionen, die in den Texten unten stehen. Nichts aus eigenem Wissen ergänzen.
- Drei Seiten: "L" = eher linke Position, "M" = Mitte (z. B. Regierungslinie, Kompromiss, neutrale Fachleute), "R" = eher rechte Position. Jede Position nur Akteuren oder Kommentatoren zuschreiben, die sie laut Text vertreten (in "who" nennen, z. B. "Grüne und Sozialverbände" oder "Kommentar im Spiegel"). Einordnung nach Inhalt und Akteuren, nicht nach dem Medium.
- Alle drei Seiten gleich lang und gleich fair, jeweils mit den stärksten Argumenten ihrer Vertreter. Jede Aussage mit Schlüssel (s1, s2 …).
- Wenn Expertenbeiträge (Forschungsinstitute, Thinktanks, Wissenschaftler) passen, nutze sie und nenne sie in "who". Sonst reichen Kommentare und Meldungen.
- Gibt es in den Texten nicht für alle drei Seiten belegbare Positionen, antworte nur {"typ":"abbruch"}.
- title: die Streitfrage als Frage, höchstens 70 Zeichen. lead: 2–3 neutrale Sätze zum Stand, höchstens 380 Zeichen.
- cat: eine aus [${CATS}]. icon: eines aus [${ICONS}].
- bild: englischer Suchbegriff (2–4 Wörter) für ein Foto eines Ortes, Gebäudes, Gegenstands oder Symbols zum Thema. NIEMALS Personen, Logos oder Parteisymbole. Sonst "".

JSON-FORMAT
{"typ":"debatte","cat":"…","icon":"…","bild":"…","title":"…","lead":"…","facts":[["Label","Wert","s1"]],
 "L":{"who":"Vertreten u. a. von …","thesis":"kurzer Satz","a":[["Stichwort","Ein Satz.","s1"],["…","…","s2"],["…","…","s3"]],"long":["Absatz","Absatz"]},
 "M":{…gleich…},"R":{…gleich…}}

TEXTE
${lines}`;
}
if (hasAI && !aiDown && DEB_RUN > 0) {
  const seenIds = new Set(), pool = [];
  for (const c of Object.values(cards)) {
    if (NOW - c.updated > 72 * 3600e3) continue;
    if (c.card && (c.card.typ === "quatsch" || !POLCATS.test(c.card.cat || ""))) continue;
    for (const x of c.items) if (SRC[x.src] && !seenIds.has(x.id)) { seenIds.add(x.id); pool.push(x); }
  }
  for (const o of Object.values(state.opinions || {})) if (SRC[o.src] && !seenIds.has(o.id)) { seenIds.add(o.id); pool.push(o); }
  const w = (x) => ({ experte: 2, meinung: 1 })[SRC[x.src].kind] || 0;
  pool.sort((a, b) => w(b) - w(a) || b.ts - a.ts);
  const known = Object.values(DEB).map((d) => d.card?.title).filter(Boolean).slice(-150);
  let made = 0;
  const regions = ["de", "us", "welt"], perRegion = Math.ceil(DEB_RUN / 3);
  for (const reg of regions) {
    if (made >= DEB_RUN || aiDown) break;
    const list = pool.filter((x) => (SRC[x.src].region === reg) || (reg === "welt" && SRC[x.src].region !== "de" && SRC[x.src].kind !== "news")).slice(0, 240);
    if (list.length < 8) continue;
    const byKey = new Map(list.map((x, i) => [`m${i + 1}`, x]));
    const plan = `Du planst Debatten für eine Nachrichten-App. Unten stehen aktuelle Meldungen und Kommentare (Schlüssel m1, m2 …). Finde bis zu ${perRegion + 3} WIRKLICH UMSTRITTENE politische oder gesellschaftliche Fragen, bei denen in diesen Texten erkennbar verschiedene Lager (Parteien, Regierung, Opposition, Verbände, Kommentatoren) unterschiedliche Positionen vertreten. Keine reinen Ereignisse ohne Streit, kein Sport, keine Unglücke.
Nicht wiederholen, auch nicht sinngemäß (gibt es schon): ${known.join(" | ") || "–"}
Wähle pro Frage 5–14 passende Schlüssel, möglichst aus Quellen unterschiedlicher Richtung und mit Expertenbeiträgen und Kommentaren für jede Seite.
Antworte als JSON: {"debatten":[{"frage":"…?","texte":["m3","m17"]}]}

TEXTE
${list.map((x, i) => `m${i + 1} [${SRC[x.src].name}, ${SRC[x.src].lean}, ${kindLabel(SRC[x.src])}] ${x.title}`).join("\n")}`;
    let plans = [];
    try { const r = await ai(plan); plans = JSON.parse(r.text.replace(/^```(json)?|```$/g, "").trim()).debatten || []; await sleep(4500); }
    catch (e) { status.ai.note = "Debattenplanung: " + String(e.message).slice(0, 120); continue; }
    let madeHere = 0;
    for (const p of plans) {
      if (madeHere >= perRegion || made >= DEB_RUN || aiDown) break;
      const items = [...new Set((p.texte || []).filter((k) => byKey.has(k)))].map((k) => byKey.get(k)).slice(0, 14);
      if (!p.frage || items.length < 4 || new Set(items.map((x) => SRC[x.src].lean)).size < 2) continue;
      try {
        const r = await ai(promptDebate(p.frage, items)); await sleep(4500);
        const card = JSON.parse(r.text.replace(/^```(json)?|```$/g, "").trim());
        if (card.typ !== "debatte") { status.ai.debFailed = (status.ai.debFailed || 0) + 1; continue; }
        const err = validate(card, items.length);
        if (err) { status.ai.debFailed = (status.ai.debFailed || 0) + 1; log(`Debatte verworfen (${err}): ${p.frage}`); continue; }
        const img = await commonsImage(card.bild); delete card.bild; if (img) card.img = img;
        const id = "deb-" + hash(p.frage + NOW);
        DEB[id] = { id, created: NOW, updated: NOW, items: items.map((x) => ({ ...x, teaser: x.teaser.slice(0, 200) })), card: { ...card, sources: sourcesOfItems(items), region: reg, ai: true } };
        known.push(card.title); made++; madeHere++; status.ai.debates = (status.ai.debates || 0) + 1;
      } catch (e) { status.ai.note = "Debatte: " + String(e.message).slice(0, 120); }
    }
  }
}
/* Fachleute zuordnen: passende Expertenbeiträge je Seite an bestehende Debatten hängen */
const EX_RUN = +(process.env.EXPERT_MATCH_PER_RUN || 6);
if (hasAI && !aiDown && EX_RUN > 0) {
  const experts = Object.values(state.opinions || {}).filter((o) => SRC[o.src]?.kind === "experte").sort((a, b) => b.ts - a.ts).slice(0, 120);
  const todo = Object.values(DEB).filter((d) => !d.exChecked).sort((a, b) => b.created - a.created).slice(0, EX_RUN);
  if (experts.length) for (const d of todo) {
    if (aiDown) break;
    const c = d.card, ek = new Map(experts.map((x, i) => [`e${i + 1}`, x]));
    const prompt = `Debatte: "${c.title}"
Eher links: ${c.L.thesis} (${c.L.who})
Mitte: ${c.M.thesis} (${c.M.who})
Eher rechts: ${c.R.thesis} (${c.R.who})

Unten stehen Beiträge von Fachleuten, Instituten und Thinktanks. Ordne nur Beiträge zu, die DIREKT diese Streitfrage behandeln und laut Titel/Anriss erkennbar die jeweilige Position stützen oder fachlich einordnen. Lieber gar nichts zuordnen als etwas Unpassendes. Höchstens 2 pro Seite.
Antworte als JSON: {"L":["e3"],"M":[],"R":["e9"]}

BEITRÄGE
${experts.map((x, i) => `e${i + 1} [${SRC[x.src].name}, ${SRC[x.src].lean}] ${x.title} — ${x.teaser.slice(0, 220)}`).join("\n")}`;
    try {
      const r = await ai(prompt); await sleep(4500);
      const m = JSON.parse(r.text.replace(/^```(json)?|```$/g, "").trim());
      for (const k of ["L", "M", "R"]) {
        const keys = (Array.isArray(m[k]) ? m[k] : []).filter((x) => ek.has(x)).slice(0, 2);
        c[k].ex = [];
        for (const key of keys) {
          const x = ek.get(key), s = SRC[x.src], sk = `x${hash(x.id).slice(0, 6)}`;
          c.sources[sk] = { o: s.name, t: x.title, u: x.url, d: iso(x.ts), lean: s.lean, k: "experte" };
          c[k].ex.push(sk);
        }
      }
      d.exChecked = NOW; status.ai.expertMatched = (status.ai.expertMatched || 0) + ["L", "M", "R"].reduce((n, k) => n + c[k].ex.length, 0);
    } catch (e) { status.ai.note = "Fachleute: " + String(e.message).slice(0, 120); }
  }
}
for (const [id, d] of Object.entries(DEB)) if (NOW - d.created > DEB_DAYS * 864e5) delete DEB[id];
for (const d of Object.values(DEB)) { const im = d.card?.img; if (im && (PERSONISH.test(decodeURIComponent(im.page || "").replace(/_/g, " ")) || /logo|emblem|coat_of_arms|wappen|flag_of/i.test(decodeURIComponent(im.page || "")))) delete d.card.img; }

// Bilder an bestehenden Karten nachträglich gegen die Regeln prüfen
for (const c of Object.values(cards)) {
  const im = c.card?.img; if (!im) continue;
  if (/logo|emblem|coat_of_arms|wappen|seal_of|flag_of|insignia|signet/i.test(decodeURIComponent(im.page || "")) || PERSONISH.test(decodeURIComponent(im.page || "").replace(/_/g, " ")) || /unglück|kriminal/i.test(c.card.cat || "") || c.card.typ === "quatsch") delete c.card.img;
}

/* ---------- 5. Feed schreiben ---------- */
const keepCut = NOW - KEEP_DAYS * 864e5;
for (const [id, c] of Object.entries(cards)) if (c.updated < keepCut || (!c.card && NOW - c.updated > 36 * 3600e3)) delete cards[id];
for (const c of Object.values(cards)) {
  if (c.items.length > 14) c.items = c.items.slice(0, 14);
  if (NOW - c.updated > 24 * 3600e3) for (const x of c.items) x.teaser = x.teaser.slice(0, 200);
}
for (const [id, t] of Object.entries(state.seen)) if (t < NOW - 4 * 864e5) delete state.seen[id];

const built = Object.values(cards).filter((c) => c.card && (!hasAI || c.gen !== "raw" || c.card.lang === "de")).map((c) => {
  const s = score(c);
  return { id: c.id, ...c.card, prio: c.card.typ === "quatsch" ? 1 : s >= 9 ? 3 : s >= 5 ? 2 : 1, upd: iso(Math.max(...c.items.map((x) => x.ts))), created: iso(c.created), nsrc: new Set(c.items.map((x) => x.src)).size };
});
const seedItems = readJSON(new URL("../seed/feed.json", import.meta.url), { items: [] }).items || [];
const editorial = seedItems.filter((x) => x.editorial && Date.parse(x.created) > keepCut);
// feed.json: das Wichtigste und Neueste; archive.json: alles Weitere fürs endlose Scrollen
const rank = (x) => (x.prio || 1) * 6 - (NOW - Date.parse(x.upd)) / 3600e3;
const debItems = Object.values(DEB).map((d) => ({ id: d.id, ...d.card, prio: NOW - d.created < 24 * 3600e3 ? 3 : 2, upd: iso(Math.max(...d.items.map((x) => x.ts))), created: iso(d.created), nsrc: new Set(d.items.map((x) => x.src)).size }))
  .sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, 150);
debItems.push(...editorial);                       // redaktionelle Debatten gehören immer in den Feed
const all = [...built].sort((a, b) => rank(b) - rank(a));
const nDeb = debItems.length + all.filter((x) => x.typ === "debatte").length;
const items = [...debItems, ...all.slice(0, Math.max(150, MAX_ITEMS - debItems.length))], archive = all.slice(Math.max(150, MAX_ITEMS - debItems.length)).slice(0, MAX_ARCHIVE);
status.debatten = nDeb;

writeJSON(`${DATA}/feed.json`, { generated: iso(NOW), ai: status.ai, archive: archive.length, items });
writeFileSync(`${DATA}/archive.json`, JSON.stringify({ generated: iso(NOW), items: archive }));
// nicht mehr verwendete Bilder löschen
if (existsSync(`${DATA}/img`)) {
  const used = new Set([...Object.values(cards), ...Object.values(DEB)].map((c) => c.card?.img?.src?.split("/").pop()).filter(Boolean));
  for (const f of readdirSync(`${DATA}/img`)) if (!used.has(f)) unlinkSync(`${DATA}/img/${f}`);
}
writeJSON(`${DATA}/state.json`, state);
writeJSON(`${DATA}/status.json`, status);
log(`Feed: ${items.length} Karten (${status.ai.written} neu per KI, ${status.ai.failed} KI-Fehler). ${status.ai.note}`);
