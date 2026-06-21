// ============================================================
// planning.js
// Holt & parst das "Planning du guide" von der Föderationsseite
// (guides-provence-cotedazur.com) und liefert es als sauberes JSON.
//
// Warum ein eigenes Modul?
//  - server.js bleibt schlank und lesbar
//  - der Parser lässt sich isoliert offline testen (test-planning.js)
//
// Robustheit ist hier wichtig, weil wir fremdes HTML parsen, das wir
// nicht kontrollieren. Deshalb:
//  - die Verfügbarkeit kommt aus CSS-Klassen der Seite (libre/occupe)
//  - jeder Parsing-Schritt ist tolerant gegenüber kleinen Markup-Änderungen
//  - schlägt etwas fehl, liefert die Funktion einen klaren Fehler statt
//    halb-kaputter Daten (der Server fällt dann auf den letzten guten
//    Stand bzw. einen Link zurück)
// ============================================================

const cheerio = require('cheerio');

const SOURCE_BASE = 'https://www.guides-provence-cotedazur.com/www/';
const DEFAULT_PAGE = 'guide-180.htm'; // zeigt den aktuellen Monat

const MONTHS_FR = {
  janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10,
  novembre: 11, decembre: 12, décembre: 12,
};

// ---------- Low-Level: Seite holen (latin1 -> Unicode) ----------
async function fetchHtml(page) {
  const url = page.startsWith('http') ? page : SOURCE_BASE + page;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'JoergDaiberSite/1.0 (Kalender-Sync)' },
    // 15s Timeout, damit ein hängender Server uns nicht blockiert
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} bei ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Die Seite ist ISO-8859-1 (latin1) kodiert — sonst werden Umlaute/Akzente Müll
  return new TextDecoder('iso-8859-1').decode(buf);
}

// ---------- Slot-Verfügbarkeit ----------
// Die Quelle (Bootstrap + Font Awesome) kodiert Verfügbarkeit über CSS-Klassen:
//   <span class="libre"><i class="fas fa-check"></i> AM</span>   -> verfügbar
//   <span class="occupe"><i class="fas fa-times"></i> PM</span>  -> belegt
// Also nicht über Farben, sondern über die Klasse (libre/occupe). Als zweites
// Signal nutzen wir das Icon (fa-check / fa-times), falls die Klasse mal fehlt.
function slotInfo($, span) {
  const $s = $(span);
  const cls = $s.attr('class') || '';
  const iconCls = $s.find('i').attr('class') || '';
  const text = $s.text().replace(/\s+/g, ' ').trim().toUpperCase(); // "AM" | "PM" | "S."

  let avail = null;
  if (/\blibre\b/.test(cls) || /fa-check/.test(iconCls)) avail = true;
  else if (/\boccup/.test(cls) || /fa-times/.test(iconCls)) avail = false;

  let key = null;
  if (text.startsWith('AM')) key = 'am';
  else if (text.startsWith('PM')) key = 'pm';
  else if (text.startsWith('S')) key = 'soir';
  return { key, avail };
}

// ---------- Haupt-Parser ----------
function parsePlanning(html, page) {
  const $ = cheerio.load(html);
  // Legenden-Schema (nur informativ für den Debug-Endpunkt)
  const ref = {
    scheme: 'class',
    dispo: $('.libre').length ? 'libre' : null,
    indispo: $('.occupe').length ? 'occupe' : null,
  };

  // --- Monat + Jahr aus der Überschrift (z.B. "Juin 2026") ---
  const bodyText = $('body').text().replace(/\s+/g, ' ');
  let month = null, year = null, monthLabel = null;
  const mm = bodyText.match(
    /(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})/i
  );
  if (mm) {
    monthLabel = `${mm[1]} ${mm[2]}`;
    month = MONTHS_FR[mm[1].toLowerCase()];
    year = parseInt(mm[2], 10);
  }

  // --- Stand-Datum ("Dernière mise à jour le 2026-06-10") ---
  let lastUpdate = null;
  const lu = bodyText.match(/jour le\s*:?\s*(\d{4}-\d{2}-\d{2})/i);
  if (lu) lastUpdate = lu[1];

  // --- Prev/Next-Monat-Links (Pfeile << / >>) ---
  const navPages = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/guide-180-(\d{4})\+(\d{2})\+\d{2}\.htm/);
    if (m) {
      const key = m[1] + '-' + m[2];
      if (!navPages.find((p) => p.key === key)) {
        navPages.push({ key, year: +m[1], month: +m[2], page: href.split('#')[0] });
      }
    }
  });
  // Vorheriger = kleiner als aktueller Monat, nächster = größer
  let prevPage = null, nextPage = null;
  if (month && year) {
    const cur = year * 12 + month;
    for (const p of navPages) {
      const v = p.year * 12 + p.month;
      if (v < cur) prevPage = p.page;
      else if (v > cur) nextPage = p.page;
    }
  } else if (navPages.length >= 2) {
    prevPage = navPages[0].page; nextPage = navPages[1].page;
  }

  // --- Planning-Tabelle finden: die Tabelle, die die Tag-Spans (.calJour) enthält ---
  let $table = null;
  $('table').each((_, t) => {
    if (!$table && $(t).find('span.calJour').length > 0) $table = $(t);
  });

  const days = [];
  if ($table && month && year) {
    $table.find('td').each((_, td) => {
      const $td = $(td);
      // Tageszelle erkennt man an <span class="calJour">NN</span>.
      // Wochennummer-Zellen und Fülltage anderer Monate haben das nicht.
      const $cal = $td.find('span.calJour').first();
      if ($cal.length === 0) return;
      const dayNum = parseInt($cal.text().replace(/\D/g, ''), 10);
      if (!Number.isInteger(dayNum)) return;

      const slots = { am: null, pm: null, soir: null };
      let hasSlot = false;
      $td.find('span.libre, span.occupe').each((__, sp) => {
        const { key, avail } = slotInfo($, sp);
        if (key) { slots[key] = avail; hasSlot = true; }
      });
      if (!hasSlot) return; // Tag ohne Slots = anderer Monat -> überspringen

      const dateStr =
        `${year}-${String(month).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      const weekday = new Date(dateStr + 'T12:00:00').getDay(); // 0=So..6=Sa
      days.push({ date: dateStr, day: dayNum, weekday, slots });
    });
  }

  return {
    source: SOURCE_BASE + (page || DEFAULT_PAGE),
    page: page || DEFAULT_PAGE,
    monthLabel, month, year, lastUpdate,
    refColors: ref,           // zur Kontrolle im Debug-Endpunkt
    prevPage, nextPage,
    days,
    fetchedAt: new Date().toISOString(),
    ok: days.length > 0,
  };
}

// ---------- Öffentliche API des Moduls ----------
async function getPlanning(page = DEFAULT_PAGE) {
  const html = await fetchHtml(page);
  return parsePlanning(html, page);
}

// URL für einen bestimmten Monat bauen (für direkte Sprünge)
function pageForMonth(year, month) {
  return `guide-180-${year}+${String(month).padStart(2, '0')}+01.htm`;
}

module.exports = {
  getPlanning,
  parsePlanning, // exportiert für Offline-Tests
  fetchHtml,     // exportiert für den Diagnose-Endpunkt
  pageForMonth,
  DEFAULT_PAGE,
  SOURCE_BASE,
};
