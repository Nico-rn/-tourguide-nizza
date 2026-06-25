// ============================================================
// Bewertungs-Backend
// Express-Webserver + SQLite + E-Mail-Moderation via Gmail
// ============================================================

require('dotenv').config();

const express = require('express');
const { DatabaseSync } = require('node:sqlite'); // SQLite ist in Node 22+ eingebaut
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const planning = require('./planning'); // Scraper für das Föderations-Planning

// ---------- Konfiguration (aus .env) ----------
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// ---------- Datenbank ----------
// SQLite = eine einzige Datei. Liegt in ./data, damit sie per
// Docker-Volume auch nach einem Container-Neustart erhalten bleibt.
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const db = new DatabaseSync(path.join(dataDir, 'reviews.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    text       TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | denied
    token      TEXT    NOT NULL,                    -- Geheimnis fuer Confirm/Deny-Links
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

// ---------- Planning-Kalender (Föderationsseite) ----------
// Wir spiegeln Jörgs Verfügbarkeits-Planning von der Föderationsseite und
// halten es lokal vor. Damit ist die eigene Website schnell und auch dann
// funktionsfähig, wenn die Quelle mal nicht erreichbar ist.
//
// Strategie:
//  - Cache je Quell-Seite (= je Monat) im Speicher, persistiert nach
//    data/planning-cache.json (übersteht Container-Neustarts dank Volume)
//  - wöchentlicher Hintergrund-Refresh holt aktuellen Monat + Nachbarn
//  - Anfragen werden aus dem Cache bedient; ist er veraltet, wird live
//    nachgeladen, bei Fehlern bleibt der letzte gute Stand erhalten
const PLANNING_CACHE_FILE = path.join(dataDir, 'planning-cache.json');
const PLANNING_TTL_MS = 8 * 24 * 60 * 60 * 1000; // 8 Tage (> wöchentlicher Refresh)
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // wöchentlich
// Nur erlaubte Seitennamen der Quelle akzeptieren -> verhindert, dass unser
// Server beliebige fremde URLs abruft (SSRF-Schutz).
const PAGE_RE = /^guide-180(?:-\d{4}\+\d{2}\+\d{2})?\.htm$/;

let planningCache = {}; // { [seitenname]: parsedData }

function loadPlanningCache() {
  try {
    if (fs.existsSync(PLANNING_CACHE_FILE))
      planningCache = JSON.parse(fs.readFileSync(PLANNING_CACHE_FILE, 'utf8'));
  } catch (e) {
    console.warn('Planning-Cache konnte nicht geladen werden:', e.message);
  }
}
function savePlanningCache() {
  try {
    fs.writeFileSync(PLANNING_CACHE_FILE, JSON.stringify(planningCache));
  } catch (e) {
    console.warn('Planning-Cache konnte nicht gespeichert werden:', e.message);
  }
}

const pageFile = (p) => (p ? String(p).split('/').pop() : null);

// Reduziert die internen Daten auf das, was das Frontend braucht
function planningPublicView(d) {
  return {
    ok: d.ok,
    source: d.source,
    monthLabel: d.monthLabel,
    month: d.month,
    year: d.year,
    lastUpdate: d.lastUpdate,
    prevPage: pageFile(d.prevPage),
    nextPage: pageFile(d.nextPage),
    days: d.days,
    fetchedAt: d.fetchedAt,
  };
}

async function refreshPage(page) {
  const data = await planning.getPlanning(page);
  if (data.ok) {
    planningCache[page] = data;
    savePlanningCache();
  }
  return data;
}

// Aktuellen Monat + direkte Nachbarn vorladen (schnelle Navigation)
async function refreshPlanning() {
  try {
    const cur = await refreshPage(planning.DEFAULT_PAGE);
    for (const p of [cur.prevPage, cur.nextPage]) {
      const file = pageFile(p);
      if (file && PAGE_RE.test(file)) {
        try { await refreshPage(file); } catch (_) { /* Nachbar optional */ }
      }
    }
    console.log(
      `Planning aktualisiert: ${cur.monthLabel || '?'} — ${Object.keys(planningCache).length} Monat(e) im Cache.`
    );
  } catch (e) {
    console.warn('Planning-Refresh fehlgeschlagen (letzter Stand bleibt):', e.message);
  }
}

loadPlanningCache();

// ---------- E-Mail (Gmail SMTP) ----------
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

async function sendModerationMail(review) {
  const confirmUrl = `${BASE_URL}/admin/reviews/${review.id}/confirm?token=${review.token}`;
  const denyUrl = `${BASE_URL}/admin/reviews/${review.id}/deny?token=${review.token}`;

  await transporter.sendMail({
    from: `"Bewertungs-Bot" <${GMAIL_USER}>`,
    to: ADMIN_EMAIL,
    subject: `Neue Bewertung von ${review.name} (${review.rating}/5)`,
    html: `
      <h2>Neue Bewertung wartet auf Freigabe</h2>
      <p><strong>Name:</strong> ${escapeHtml(review.name)}</p>
      <p><strong>Bewertung:</strong> ${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)} (${review.rating}/5)</p>
      <blockquote>${escapeHtml(review.text)}</blockquote>
      <p>
        <a href="${confirmUrl}" style="background:#16a34a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;margin-right:10px;">✔ Freigeben</a>
        <a href="${denyUrl}" style="background:#dc2626;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">✘ Ablehnen</a>
      </p>
    `,
  });
}

// Schutz gegen HTML-Injection in Mail & API-Ausgabe
function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ============================================================
// SEO: drei getrennte Sprach-URLs (/de, /en, /fr)
// ------------------------------------------------------------
// Jede Sprache bekommt eine eigene Adresse mit eigenem <title>,
// eigener Beschreibung und hreflang-Angaben. Erst dadurch kann
// Google die englische, französische und deutsche Fassung
// getrennt indexieren und der passenden Suche zuordnen.
// ============================================================
const LANGS = ['de', 'en', 'fr'];

// Pro Sprache: Suchmaschinen-Titel + Beschreibung mit den
// landesüblichen Suchbegriffen (z. B. "French Riviera" auf Englisch).
const SEO = {
  de: {
    locale: 'de_DE',
    title: "Jörg Daiber – Deutschsprachiger Reiseleiter & Guide an der Côte d'Azur | Nizza, Provence",
    desc: "Lizenzierter deutschsprachiger Reiseleiter (Guide Conférencier) in Nizza. Stadtführungen und Ausflüge an der Côte d'Azur, in der Provence und in ganz Frankreich – auf Deutsch, Englisch und Französisch.",
  },
  en: {
    locale: 'en_US',
    title: "Jörg Daiber – English-Speaking Tour Guide on the French Riviera (Côte d'Azur), Nice & Provence",
    desc: "Licensed tour guide (guide conférencier) based in Nice on the French Riviera (Côte d'Azur). Private city tours and day trips on the Riviera, in Provence and across France – guiding in English, German and French.",
  },
  fr: {
    locale: 'fr_FR',
    title: "Jörg Daiber – Guide Conférencier à Nice | Côte d'Azur, Provence & toute la France",
    desc: "Guide conférencier diplômé basé à Nice. Visites guidées et excursions sur la Côte d'Azur, en Provence et dans toute la France – en français, allemand et anglais.",
  },
};

function escapeAttr(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// index.html einmal einlesen; daraus pro Sprache eine fertige Seite bauen.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

function pageForLang(lang) {
  const seo = SEO[lang];
  const altLinks = LANGS
    .map((l) => `  <link rel="alternate" hreflang="${l}" href="${BASE_URL}/${l}">`)
    .join('\n');
  const head =
    `\n  <link rel="canonical" href="${BASE_URL}/${lang}">\n` +
    altLinks + '\n' +
    `  <link rel="alternate" hreflang="x-default" href="${BASE_URL}/en">\n` +
    `  <meta property="og:type" content="website">\n` +
    `  <meta property="og:locale" content="${seo.locale}">\n` +
    `  <meta property="og:title" content="${escapeAttr(seo.title)}">\n` +
    `  <meta property="og:description" content="${escapeAttr(seo.desc)}">\n` +
    `  <meta property="og:url" content="${BASE_URL}/${lang}">\n` +
    `  <script>window.__LANG__ = ${JSON.stringify(lang)};</script>\n`;

  return INDEX_HTML
    .replace('<html lang="de">', `<html lang="${lang}">`)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeAttr(seo.title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeAttr(seo.desc)}">`)
    .replace('</head>', `${head}</head>`);
}

// Fertige Seiten beim Start vorbereiten (schnell + kein Datei-IO pro Request).
const PAGES = Object.fromEntries(LANGS.map((l) => [l, pageForLang(l)]));

// Beste Sprache aus dem Accept-Language-Header des Browsers ableiten.
function bestLang(req) {
  const h = String(req.headers['accept-language'] || '').toLowerCase();
  for (const l of LANGS) if (h.includes(l)) return l;
  return 'de';
}

// ---------- Webserver ----------
const app = express();
app.use(express.json());

// Sprachseiten MÜSSEN vor express.static stehen, sonst liefert static die
// rohe index.html ohne Sprach-Metadaten aus.
// "/" leitet je nach Browsersprache auf /de, /en oder /fr (302, temporär).
app.get('/', (req, res) => res.redirect(302, '/' + bestLang(req)));
app.get('/index.html', (req, res) => res.redirect(301, '/'));
for (const l of LANGS) {
  app.get('/' + l, (_req, res) => res.type('html').send(PAGES[l]));
}

app.use(express.static('public', { index: false })); // Bilder & Co.; index.html nicht direkt

// GET /api/reviews -> alle freigegebenen Bewertungen (fuer die Website)
app.get('/api/reviews', (req, res) => {
  const rows = db
    .prepare(`SELECT id, name, rating, text, created_at
              FROM reviews WHERE status = 'approved'
              ORDER BY created_at DESC`)
    .all();
  res.json(rows);
});

// POST /api/reviews -> neue Bewertung einreichen (Status: pending)
app.post('/api/reviews', async (req, res) => {
  const { name, rating, text } = req.body || {};

  // Validierung
  const r = Number(rating);
  if (
    typeof name !== 'string' || name.trim().length < 1 || name.length > 100 ||
    typeof text !== 'string' || text.trim().length < 1 || text.length > 2000 ||
    !Number.isInteger(r) || r < 1 || r > 5
  ) {
    return res.status(400).json({ error: 'Ungültige Eingabe.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const info = db
    .prepare(`INSERT INTO reviews (name, rating, text, token) VALUES (?, ?, ?, ?)`)
    .run(name.trim(), r, text.trim(), token);

  const review = { id: info.lastInsertRowid, name: name.trim(), rating: r, text: text.trim(), token };

  // Mail an den Admin. Schlaegt der Versand fehl, bleibt die Bewertung
  // trotzdem als 'pending' in der DB (geht also nicht verloren).
  try {
    await sendModerationMail(review);
  } catch (err) {
    console.error('Mailversand fehlgeschlagen:', err.message);
  }

  res.status(201).json({ message: 'Danke! Deine Bewertung wird geprüft.' });
});

// ---------- Kalender-API ----------
// GET /api/calendar/debug -> komplette geparste Daten inkl. erkannter
// Legenden-Farben. Nur zur Kontrolle nach dem Deploy (Farb-Mapping prüfen).
app.get('/api/calendar/debug', async (req, res) => {
  try {
    const data = await planning.getPlanning(planning.DEFAULT_PAGE);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/calendar/refresh -> Cache manuell neu aufbauen
app.get('/api/calendar/refresh', async (req, res) => {
  await refreshPlanning();
  res.json({ ok: true, months: Object.keys(planningCache) });
});

// GET /api/calendar?page=guide-180-2026+07+01.htm  (oder ?month=YYYY-MM)
// Ohne Parameter: aktueller Monat. Liefert Daten aus dem Cache, lädt bei
// Bedarf live nach und fällt im Fehlerfall auf den letzten guten Stand zurück.
app.get('/api/calendar', async (req, res) => {
  let page = planning.DEFAULT_PAGE;
  if (req.query.page) {
    const file = pageFile(req.query.page);
    if (!PAGE_RE.test(file)) return res.status(400).json({ ok: false, error: 'Ungültige Seite.' });
    page = file;
  } else if (req.query.month) {
    const m = String(req.query.month).match(/^(\d{4})-(\d{2})$/);
    if (m) page = planning.pageForMonth(+m[1], +m[2]);
  }

  const cached = planningCache[page];
  const fresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < PLANNING_TTL_MS;
  if (fresh) return res.json(planningPublicView(cached));

  try {
    const data = await refreshPage(page);
    if (data.ok) return res.json(planningPublicView(data));
    if (cached) return res.json(planningPublicView(cached)); // letzter guter Stand
    return res.json({ ok: false, source: data.source, message: 'Kalender derzeit nicht verfügbar.' });
  } catch (e) {
    if (cached) return res.json(planningPublicView(cached));
    return res
      .status(502)
      .json({ ok: false, source: planning.SOURCE_BASE + page, message: 'Kalenderquelle nicht erreichbar.' });
  }
});

// GET /admin/reviews/:id/confirm|deny?token=... -> Links aus der Mail
app.get('/admin/reviews/:id/:action', (req, res) => {
  const { id, action } = req.params;
  const { token } = req.query;

  if (!['confirm', 'deny'].includes(action)) return res.status(404).send('Unbekannte Aktion.');

  const review = db.prepare(`SELECT * FROM reviews WHERE id = ?`).get(id);
  if (!review || review.token !== token) return res.status(403).send('Ungültiger Link.');
  if (review.status !== 'pending') {
    return res.send(`Diese Bewertung wurde bereits bearbeitet (Status: ${review.status}).`);
  }

  const newStatus = action === 'confirm' ? 'approved' : 'denied';
  db.prepare(`UPDATE reviews SET status = ? WHERE id = ?`).run(newStatus, id);

  res.send(
    newStatus === 'approved'
      ? `✔ Bewertung von "${escapeHtml(review.name)}" wurde freigegeben und ist jetzt auf der Website sichtbar.`
      : `✘ Bewertung von "${escapeHtml(review.name)}" wurde abgelehnt.`
  );
});

app.listen(PORT, () => {
  console.log(`Server läuft auf ${BASE_URL}`);
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !ADMIN_EMAIL) {
    console.warn('WARNUNG: GMAIL_USER / GMAIL_APP_PASSWORD / ADMIN_EMAIL nicht gesetzt — Mailversand wird fehlschlagen.');
  }

  // Planning beim Start einmal holen, danach wöchentlich aktualisieren.
  // Beides in Hintergrund-Promises -> blockiert den Serverstart nie.
  refreshPlanning();
  setInterval(refreshPlanning, REFRESH_INTERVAL_MS);
});
