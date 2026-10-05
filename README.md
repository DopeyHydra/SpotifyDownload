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

Jeder Titel wird parallel auf YouTube Music und YouTube gesucht. Die Kandidaten werden bewertet nach Titel, Interpret, Dauer und „Topic“-Kanal. Remix-, Live-, Cover- und „Sped up“-Versionen werden abgewertet, wenn das Original sie nicht enthält.
Ist kein Treffer eindeutig, wird **nichts** heruntergeladen. Der Download steht dann auf **„Auswahl nötig“**, und unter „Auswählen“ erscheinen Spotify- und YouTube-Vorschläge sowie eine eigene Suche. In der Titelliste zeigt „Treffer prüfen“ das vorab an.

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
