# Spotify → YouTube Downloader

Sucht Songs aus Spotify-Playlists, Alben, TXT-Listen oder einzelnen Eingaben auf YouTube (Music) und lädt sie als MP3/M4A mit Cover und Tags herunter.

## Start

`start.bat` doppelklicken (oder `npm start`). Der Browser öffnet sich auf http://localhost:3456.
Beim ersten Start werden `yt-dlp` und `ffmpeg` automatisch nach `bin/` heruntergeladen. Einzige Voraussetzung ist Node.js ≥ 18.

## Quellen

| Tab | Was |
| --- | --- |
| TXT importieren | Tab-getrennte Liste: `# · Bild · Trackname · Interpret · Album · Genre · BPM · Wertung · Dauer · Tonart · Datum Hinzufügung` (mit oder ohne Kopfzeile, auch mit Leerzeichen statt Tabs). Drag & Drop, mehrere Dateien möglich. |
| Spotify-Link | Playlist, Album oder Track. Ohne API-Zugang höchstens 100 Titel pro Playlist. |
| Playlists finden | Sucht Playlists auf YouTube und, mit API-Zugang, auch auf Spotify. Ein Klick lädt die Playlist. |
| YouTube-Playlist | Lädt die Videos einer Playlist direkt herunter. |
| Einzelne Songs | Eine Zeile pro Song (`Interpret - Titel`) oder ein YouTube-Link. |

## Treffer-Suche

- **Automatisch wird nur YouTube Music durchsucht.** Ein Treffer wird nur übernommen, wenn Titel, Interpret und Dauer zum gesuchten Song passen. Remix-, Live-, Cover- und „Sped up“-Versionen werden ausgeschlossen, wenn das Original sie nicht enthält.
- **Passt nichts**, wird der beste normale YouTube-Eintrag nur **vorgeschlagen**. Der Download steht dann auf „Auswahl nötig“. Mit **Vorschlag laden** bestätigst du ihn, mit **Andere wählen** suchst du selbst, auch über Spotify-Vorschläge oder einen eigenen YouTube-Link.
- **Dateiname, Tags und Cover** kommen immer vom tatsächlich heruntergeladenen Song, also Interpret, Titel, Album und Jahr von YouTube Music bzw. aus dem Videotitel. Weicht das von der Liste ab, zeigt die Download-Liste beides an.

## Duplikate finden

Oben auf **🔁 Duplikate** umschalten, einen oder mehrere Ordner hinzufügen und auf **Duplikate suchen** klicken. Die Unterordner werden mitdurchsucht.

- **Identische Dateien** werden über eine Prüfsumme erkannt, auch bei anderem Dateinamen.
- **Derselbe Song in unterschiedlichen Dateien** wird über Interpret und Titel aus den Tags oder dem Dateinamen erkannt, z. B. MP3 und M4A oder unterschiedliche Bitraten. Remixes und Live-Versionen bleiben eigene Songs. Abschaltbar.
- Pro Gruppe stehen alle Dateien mit Pfad ab dem durchsuchten Ordner, Format, Bitrate, Dauer, Größe und Datum. Die beste Qualität ist mit ★ markiert.
- Mit ▶ kannst du probehören, mit 📂 die Datei im Explorer anzeigen.
- Gelöscht wird nur, was du selbst markierst, und zwar in den **Papierkorb**. „Alle außer ★ markieren“ hilft beim Vormarkieren.

## Einstellungen (⚙)

- **Download-Ordner**: frei wählbar per „Durchsuchen …“ oder „Ändern …“ im Download-Bereich, optional mit Unterordner pro Playlist
- Format MP3 (128–320 kbit/s) oder M4A, Anzahl gleichzeitiger Downloads
- **Spotify-API (optional)**: Client ID und Secret von https://developer.spotify.com/dashboard. Damit funktionieren die Spotify-Playlistsuche, die Spotify-Vorschläge und Playlists mit mehr als 100 Titeln.

## Installer bauen

```
npm install
npm run build
```

Das erzeugt `dist/SpotifyDownloader-Setup-<version>.exe`. Voraussetzungen: [Inno Setup 6](https://jrsoftware.org/isinfo.php) (`winget install JRSoftware.InnoSetup`) und einmal `npm start`, damit `bin/` mit yt-dlp und ffmpeg gefüllt ist.
Die Version kommt aus `package.json`.

Bitte nur Inhalte herunterladen, für die du die Rechte hast.
