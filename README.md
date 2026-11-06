# Zwei Seiten

Nachrichten-App zum Durchwischen wie TikTok: Meldungen aus Deutschland, den USA und der Welt, bei Debatten aus linker, mittiger und rechter Sicht, immer mit Quellen. Läuft als Web-App auf GitHub Pages und lässt sich zum Homescreen hinzufügen.

## So funktioniert es

1. Der Workflow `.github/workflows/news.yml` läuft alle 30 Minuten (und bei jedem Push auf `main`).
2. `scripts/update.mjs` holt alle Quellen aus `scripts/sources.json`, bündelt Meldungen zum selben Ereignis, gewichtet sie und lässt die KI für neue Ereignisse eine Karte schreiben (höchstens 5 pro Lauf). Jede Karte wird automatisch geprüft; was durchfällt, wird als einfache Schlagzeilen-Karte gezeigt.
3. Ergebnis und Zustand landen im Branch `data` (wird jedes Mal überschrieben, damit das Repo klein bleibt). Die Seite wird über GitHub Pages ausgeliefert.
4. Die App (`index.html`, `app.js`, `style.css`) lädt `data/feed.json`. Interessen, gesehene Karten und Abstimmungen bleiben nur im Browser.

## KI-Schlüssel

Ohne Schlüssel läuft alles, aber nur mit Schlagzeilen-Karten.

- **Gemini (Haupt-KI, kostenlos):** Auf <https://aistudio.google.com> mit dem Google-Konto anmelden → „Get API key“ → Schlüssel erstellen. Dann im Repo: *Settings → Secrets and variables → Actions → New repository secret*, Name `GEMINI_API_KEY`.
- **Groq (Ersatz, kostenlos):** Auf <https://console.groq.com> Schlüssel erstellen, als Secret `GROQ_API_KEY` hinterlegen.
- Fotos: nur frei lizenzierte Bilder von Wikimedia Commons (CC0, gemeinfrei, CC BY, CC BY-SA), keine Personen, mit Urheber und Lizenz an jedem Bild. Sie werden im Daten-Branch gespeichert und von der eigenen Seite ausgeliefert.
- Optional: Variable `GEMINI_MODEL` (z. B. `gemini-2.5-flash`), sonst sucht das Skript das neueste Flash-Modell selbst.

## Quellen ändern

`scripts/sources.json` bearbeiten. `lean` ist die Grundtendenz des Mediums und sorgt nur für Vielfalt; ob eine Position links, Mitte oder rechts ist, entscheidet die KI anhand der Akteure. Welche Quellen funktionieren, steht nach jedem Lauf in `data/status.json` (auch unter `<seite>/data/status.json`).

## Lokal testen

```bash
npm ci
DATA_DIR=data node scripts/update.mjs      # echte Quellen
python3 -m http.server                     # App unter http://localhost:8000
```

## Grenzen

- Inhalte der Tagesschau-API sind nur für private Nutzung freigegeben. Vor einer öffentlichen Bewerbung der App die Bedingungen aller Quellen prüfen.
- KI-Karten können Fehler enthalten. Jede Karte zeigt, ob sie automatisch zusammengefasst wurde, und verlinkt die Originale.
