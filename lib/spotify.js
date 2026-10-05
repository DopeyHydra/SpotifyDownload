// Spotify: Playlists/Alben/Tracks lesen und Playlists suchen.
// Ohne Zugangsdaten über die öffentliche Embed-Seite (max. 100 Titel),
// mit Client-ID/Secret über die offizielle Web-API (vollständig + Suche).

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
};

function parseSpotifyUrl(input) {
  const s = input.trim();
  let m = s.match(/spotify:(playlist|album|track|artist):([A-Za-z0-9]+)/);
  if (!m) m = s.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:embed\/)?(playlist|album|track|artist)\/([A-Za-z0-9]+)/);
  return m ? { type: m[1], id: m[2] } : null;
}

// ---------- Embed (ohne Zugangsdaten) ----------

async function embedEntity(type, id) {
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, { headers: UA });
  if (!res.ok) throw new Error(`Spotify antwortet mit HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) throw new Error('Spotify-Seite konnte nicht gelesen werden');
  const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error('Keine Daten gefunden (privat oder nicht verfügbar?)');
  return entity;
}

async function fromEmbed(type, id) {
  const e = await embedEntity(type, id);
  const cover = e.coverArt?.sources?.[0]?.url || e.visualIdentity?.image?.[0]?.url || '';
  if (type === 'track') {
    return {
      name: e.name,
      cover,
      truncated: false,
      tracks: [{ title: e.name, artist: (e.artists || []).map((a) => a.name).join(', '), album: '', duration: Math.round(e.duration / 1000), spotifyId: e.id }],
    };
  }
  const list = e.trackList || [];
  return {
    name: e.name || e.title,
    cover,
    truncated: list.length >= 100,
    tracks: list.map((t) => ({
      title: t.title,
      artist: t.subtitle,
      album: type === 'album' ? e.name : '',
      duration: t.duration ? Math.round(t.duration / 1000) : null,
      spotifyId: (t.uri || '').split(':').pop(),
    })),
  };
}

// ---------- Offizielle Web-API (optional) ----------

let token = null;

async function getToken(cfg) {
  if (!cfg.spotifyClientId || !cfg.spotifyClientSecret) return null;
  if (token && token.expires > Date.now() + 60000) return token.value;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cfg.spotifyClientId}:${cfg.spotifyClientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('Spotify-Zugangsdaten ungültig (HTTP ' + res.status + ')');
  const j = await res.json();
  token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return token.value;
}

async function api(cfg, url) {
  const t = await getToken(cfg);
  const res = await fetch(url.startsWith('http') ? url : 'https://api.spotify.com/v1' + url, { headers: { Authorization: 'Bearer ' + t } });
  if (!res.ok) {
    const err = new Error(`Spotify-API: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function apiTrack(t, albumName) {
  return {
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: albumName ?? t.album?.name ?? '',
    duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
    spotifyId: t.id,
  };
}

async function fromApi(cfg, type, id) {
  if (type === 'track') {
    const t = await api(cfg, `/tracks/${id}`);
    return { name: t.name, cover: t.album?.images?.[0]?.url || '', truncated: false, tracks: [apiTrack(t)] };
  }
  if (type === 'album') {
    const a = await api(cfg, `/albums/${id}`);
    const tracks = [];
    let page = a.tracks;
    while (page) {
      tracks.push(...page.items.map((t) => apiTrack(t, a.name)));
      page = page.next ? await api(cfg, page.next) : null;
    }
    return { name: a.name, cover: a.images?.[0]?.url || '', truncated: false, tracks };
  }
  const p = await api(cfg, `/playlists/${id}?fields=name,images`);
  const tracks = [];
  let next;
  try {
    next = await api(cfg, `/playlists/${id}/items?limit=50`);
  } catch (e) {
    if (e.status !== 404) throw e;
    next = await api(cfg, `/playlists/${id}/tracks?limit=50`);
  }
  while (next) {
    for (const it of next.items || []) {
      const t = it.item || it.track;
      if (t && t.type !== 'episode' && t.name) tracks.push(apiTrack(t));
    }
    next = next.next ? await api(cfg, next.next) : null;
  }
  return { name: p.name, cover: p.images?.[0]?.url || '', truncated: false, tracks };
}

async function loadSpotify(cfg, input) {
  const ref = parseSpotifyUrl(input);
  if (!ref) throw new Error('Kein gültiger Spotify-Link (Playlist, Album oder Track)');
  if (ref.type === 'artist') throw new Error('Künstler-Links werden nicht unterstützt – bitte Album oder Playlist verwenden');
  if (cfg.spotifyClientId && cfg.spotifyClientSecret) {
    try {
      return await fromApi(cfg, ref.type, ref.id);
    } catch (e) {
      console.warn('API fehlgeschlagen, nutze Embed:', e.message);
    }
  }
  return fromEmbed(ref.type, ref.id);
}

async function searchPlaylists(cfg, q) {
  if (!cfg.spotifyClientId || !cfg.spotifyClientSecret) return { available: false, results: [] };
  const j = await api(cfg, `/search?type=playlist&limit=10&q=${encodeURIComponent(q)}`);
  const results = (j.playlists?.items || []).filter(Boolean).map((p) => ({
    source: 'spotify',
    url: p.external_urls?.spotify || `https://open.spotify.com/playlist/${p.id}`,
    title: p.name,
    owner: p.owner?.display_name || '',
    count: p.tracks?.total ?? p.items?.total ?? null,
    thumb: p.images?.[0]?.url || '',
  }));
  return { available: true, results };
}

// Song-Vorschläge, wenn ein Titel nicht eindeutig gefunden wurde
async function searchTracks(cfg, q) {
  if (!cfg.spotifyClientId || !cfg.spotifyClientSecret) return { available: false, results: [] };
  const j = await api(cfg, `/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
  const results = (j.tracks?.items || []).filter(Boolean).map((t) => ({
    ...apiTrack(t),
    cover: t.album?.images?.at(-1)?.url || t.album?.images?.[0]?.url || '',
    url: t.external_urls?.spotify || '',
  }));
  return { available: true, results };
}

module.exports = { loadSpotify, searchPlaylists, searchTracks, parseSpotifyUrl };
