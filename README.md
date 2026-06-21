# Bewertungs-Backend

Ein Docker-Container mit Webserver (Express), Datenbank (SQLite) und E-Mail-Moderation: Neue Bewertungen landen als „pending“ in der Datenbank, der Admin bekommt eine Mail mit **Freigeben**/**Ablehnen**-Links. Erst nach Freigabe erscheint die Bewertung auf der Website. Zusätzlich spiegelt der Server Jörgs Verfügbarkeits-Planning von der Föderationsseite (Abschnitt **Verfügbarkeit**).

## Schnellstart (lokal)

```bash
docker compose up --build
```

Website: http://localhost:3000

## Online stellen (kostenlos, Render)

Das Repo enthält eine `render.yaml`. Auf [render.com](https://render.com) mit GitHub anmelden, **New + → Blueprint**, dieses Repo wählen, **Apply**. Render baut das Dockerfile und vergibt eine feste HTTPS-URL. Das Gmail-Passwort ist für eine Demo nicht nötig (nur das Absenden einer Bewertung bräuchte es).

## Dateien

| Datei | Zweck |
|---|---|
| `server.js` | Backend: Webserver, API, DB, Mailversand, Kalender-Endpunkte |
| `planning.js` | Holt & parst das Verfügbarkeits-Planning der Föderationsseite |
| `public/index.html` | Website (DE/EN/FR) inkl. Verfügbarkeitskalender |
| `Dockerfile` | Bauanleitung für das Container-Image |
| `docker-compose.yml` | Startet den Container lokal, Port 3000, Volume für die DB |
| `render.yaml` | Deploy-Konfiguration für Render (kostenlos) |
| `.env` | Geheimnisse (Gmail-Zugang) — niemals committen! |

## API

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/reviews` | Alle freigegebenen Bewertungen (JSON) |
| POST | `/api/reviews` | Neue Bewertung einreichen `{name, rating, text}` |
| GET | `/admin/reviews/:id/confirm?token=…` | Bewertung freigeben (Link aus Mail) |
| GET | `/admin/reviews/:id/deny?token=…` | Bewertung ablehnen (Link aus Mail) |
| GET | `/api/calendar` | Verfügbarkeitskalender (aktueller Monat) als JSON |
| GET | `/api/calendar?page=guide-180-2026+07+01.htm` | Bestimmter Monat (Navigation) |
| GET | `/api/calendar/refresh` | Cache sofort neu aufbauen |
| GET | `/api/calendar/debug` | Roh-Parse inkl. erkannter Legenden-Daten (Kontrolle) |

## Verfügbarkeitskalender

Auf der Website (Abschnitt **Verfügbarkeit**) wird Jörgs Planning von der Föderationsseite gespiegelt:

- **Wöchentliche Aktualisierung**: Der Server holt die Daten beim Start und danach alle 7 Tage automatisch neu. Ändert sich auf der Quelle etwas, ist es nach dem nächsten Lauf auch hier sichtbar. Sofort erzwingen: `GET /api/calendar/refresh`.
- **Robust**: Ist die Quelle mal nicht erreichbar, bleibt der letzte gute Stand aus `data/planning-cache.json` erhalten.
- **Verfügbarkeit** kommt aus den CSS-Klassen der Quelle: `libre` = verfügbar, `occupe` = belegt (plus Font-Awesome-Icons `fa-check` / `fa-times`) — siehe `slotInfo()` in `planning.js`.

### Nach dem ersten Deploy kurz prüfen

```
http://localhost:3000/api/calendar/debug
```

Dort sollte `refColors` das erkannte Schema zeigen (z.B. `{scheme: class, dispo: libre, indispo: occupe}`) und `days[].slots` plausibel `true`/`false` sein. Offline-Tests: `node test-planning.js` und `node test-frontend.js`.

## Hinweise

- **BASE_URL**: Wenn der Server öffentlich läuft (Render/Domain), `BASE_URL` setzen, damit die Mail-Links korrekt zeigen.
- Beim Start erscheint „SQLite is an experimental feature“ — nur eine Warnung, seit Node 22 eingebaut.
- Schlägt der Mailversand fehl, bleibt die Bewertung trotzdem als „pending“ gespeichert.
