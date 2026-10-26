// Suche direkt über die Such-Schnittstelle von YouTube Music (wie music.youtube.com selbst).
// Liefert Titel, Interpreten, Album, Dauer und Cover – ohne Video-Abrufe, die YouTubes Bot-Schutz zählt.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const SONGS_FILTER = 'EgWKAQIIAWoKEAoQCRADEAQQBQ%3D%3D';

function pageType(run) {
  return run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
}

function toSeconds(t) {
  return t ? t.split(':').reduce((a, v) => a * 60 + Number(v), 0) : null;
}

function parseItem(it) {
  const cols = (it.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
  const title = (cols[0] || []).map((r) => r.text).join('').trim();
  const runs = cols[1] || [];
  // Interpreten: verlinkte Künstler, sonst alles vor dem ersten " • "
  let artists = runs.filter((r) => pageType(r) === 'MUSIC_PAGE_TYPE_ARTIST').map((r) => r.text);
  if (!artists.length) {
    const firstSeg = runs.map((r) => r.text).join('').split(' • ')[0];
    artists = firstSeg ? firstSeg.split(/,\s*|\s+&\s+/).filter(Boolean) : [];
  }
  const album = runs.find((r) => pageType(r) === 'MUSIC_PAGE_TYPE_ALBUM')?.text || '';
  const durationText = runs.map((r) => r.text).find((t) => /^\d+:\d{2}(:\d{2})?$/.test(t.trim()));
  const id =
    it.playlistItemData?.videoId ||
    it.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  const thumb = it.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.at(-1)?.url || '';
  // Google-Bild-URLs lassen sich in beliebiger Größe abrufen (…=w120-h120… → 1200 px)
  const cover = thumb.replace(/=w\d+-h\d+[^&]*$/, '=w1200-h1200-l90-rj');
  return id && title ? { id, title, artist: artists.join(', '), album, duration: toSeconds(durationText), cover } : null;
}

async function searchSongs(query, limit = 10) {
  const res = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: 'https://music.youtube.com', Referer: 'https://music.youtube.com/' },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20251020.01.00', hl: 'de', gl: 'DE' } },
      query,
      params: SONGS_FILTER,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`YouTube-Music-Suche: HTTP ${res.status}`);
  const j = await res.json();
  const items = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.musicResponsiveListItemRenderer) items.push(o.musicResponsiveListItemRenderer);
    else for (const v of Object.values(o)) walk(v);
  };
  walk(j);
  return items.map(parseItem).filter(Boolean).slice(0, limit);
}

module.exports = { searchSongs };
