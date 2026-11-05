// SoundCloud: Links laden, suchen und Metadaten für den Download bestimmen (alles über yt-dlp).
const fs = require('fs');
const os = require('os');
const path = require('path');
const yt = require('./youtube');

function isSoundcloudUrl(s) {
  return /^https?:\/\/([a-z0-9-]+\.)?soundcloud\.com\//i.test(String(s || '').trim());
}

function bestCover(e) {
  const thumbs = e.thumbnails || [];
  return thumbs.find((t) => t.id === 'original')?.url || thumbs.find((t) => t.id === 't500x500')?.url || e.thumbnail || '';
}

// Titel stehen oft als "Interpret - Song (Edit) [FREE DL]" im Feld – sonst ist der Uploader der Interpret
function metaFrom(e) {
  const clean = String(e.title || '')
    .replace(/\s*[([]\s*free\s*(dl|download)[^)\]]*[)\]]/gi, '')
    .replace(/\s+free\s+(dl|download)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/([([])\s+/g, '$1')
    .replace(/\s+([)\]])/g, '$1')
    .trim();
  const m = clean.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return {
    title: m ? m[2].trim() : clean,
    artist: m ? m[1].trim() : e.uploader || '',
    album: '',
    year: null,
    cover: bestCover(e),
  };
}

function toTrack(e) {
  const meta = metaFrom(e);
  return {
    title: meta.title,
    artist: meta.artist,
    album: '',
    duration: e.duration ? Math.round(e.duration) : null,
    sourceUrl: e.webpage_url || e.url,
    videoTitle: e.title,
  };
}

// Link zu Track, Set/Playlist, Album, Nutzerseite oder Likes laden
async function loadRaw(url) {
  let j = await yt.ytdlpJson(['--flat-playlist', '-J', url], 180000);
  let skipped = 0;
  // Sets liefern flach nur Links ohne Titel → vollständig auslesen.
  // DRM-Titel kommen dabei als leere Einträge zurück und werden übersprungen (-i).
  if (j.entries?.some((e) => e && !e.title)) {
    j = await yt.ytdlpJson(['-i', '-J', '--sleep-requests', '0.25', url], 30 * 60000);
    skipped = j.entries.filter((e) => !e).length;
  }
  const entries = (j.entries || [j]).filter(Boolean);
  const tracks = [];
  for (const e of entries.slice(0, 2000)) {
    const u = e.webpage_url || e.url || '';
    if (/\/sets\//.test(u) && u !== url) {
      // Set-Übersicht eines Profils: jedes Set einzeln laden
      const sub = await loadRaw(u).catch(() => null);
      if (sub) {
        tracks.push(...sub.tracks);
        skipped += sub.skipped;
      }
    } else if (e.title) tracks.push(toTrack(e));
  }
  return { name: j.entries ? j.title : 'SoundCloud', tracks, skipped };
}

async function load(url) {
  const { name, tracks, skipped } = await loadRaw(url);
  const seen = new Set();
  const unique = tracks.filter((t) => !seen.has(t.sourceUrl) && seen.add(t.sourceUrl));
  if (!unique.length) throw new Error(skipped ? 'Alle Titel sind kopiergeschützt (DRM) und können nicht geladen werden.' : 'Keine Titel gefunden');
  return {
    name,
    cover: '',
    truncated: skipped > 0,
    apiNote: skipped ? `${skipped} kopiergeschützte Titel (DRM) wurden übersprungen. Sie lassen sich nicht von SoundCloud laden.` : null,
    tracks: unique,
  };
}

async function search(q, limit = 20) {
  const j = await yt.ytdlpJson(['--flat-playlist', '-J', `scsearch${limit}:${q}`]);
  return (j.entries || []).filter((e) => e && e.title);
}

// Vorschläge für die Auswahl – nie automatisch. Die ID ist die Seiten-URL.
async function suggestions(track, q) {
  const query = q || `${yt.primaryArtist(track.artist)} ${yt.coreTitle(track.title)}`.trim();
  const base = yt.coreTitle(track.title).split(/\s+[-–([]/)[0];
  return (await search(query, 8))
    .filter((e) => q || yt.fraction(base, e.title) >= 0.6)
    .slice(0, 5)
    .map((e) => {
      const c = { source: 'soundcloud', id: e.webpage_url, url: e.webpage_url, title: e.title, channel: e.uploader || '', duration: e.duration ? Math.round(e.duration) : null, cover: bestCover(e), auto: false };
      return { ...c, score: yt.scoreCandidate(track, c) };
    });
}

// Vollständige Infos eines Tracks; als Datei gespeichert, damit der Download sie wiederverwendet
async function getInfo(url) {
  const j = await yt.ytdlpJson(['-J', '--no-playlist', url], 60000);
  if ((j.formats || []).length && j.formats.every((f) => /preview/i.test(f.format_id || ''))) {
    throw new Error('Von diesem SoundCloud-Titel gibt es nur eine 30-Sekunden-Vorschau (SoundCloud Go+). Bitte eine andere Quelle wählen.');
  }
  const infoFile = path.join(os.tmpdir(), `spotify-downloader-${j.id}-${Date.now()}.info.json`);
  fs.writeFileSync(infoFile, JSON.stringify(j));
  return { id: j.id, title: j.title || '', channel: j.uploader || '', duration: j.duration || null, infoFile, meta: metaFrom(j) };
}

module.exports = { isSoundcloudUrl, load, search, suggestions, getInfo, toTrack };
