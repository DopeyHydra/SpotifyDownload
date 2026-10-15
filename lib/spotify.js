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

let token = null; // App-Token (Client-ID/Secret)
let userToken = null; // Benutzer-Token (nach "Mit Spotify anmelden")
const pendingLogins = new Map(); // state -> { verifier, redirect }
let persist = () => {}; // speichert Konfigurationsänderungen (vom Server gesetzt)

function setPersist(fn) {
  persist = fn;
}

function basicAuth(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.spotifyClientId}:${cfg.spotifyClientSecret}`).toString('base64');
}

async function tokenRequest(cfg, body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: basicAuth(cfg), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Spotify-Anmeldung fehlgeschlagen: ${j.error_description || j.error || 'HTTP ' + res.status}`);
    err.status = res.status;
    err.code = j.error;
    throw err;
  }
  return j;
}

async function getToken(cfg) {
  if (!cfg.spotifyClientId || !cfg.spotifyClientSecret) return null;
  if (token && token.expires > Date.now() + 60000) return token.value;
  const j = await tokenRequest(cfg, { grant_type: 'client_credentials' }).catch((e) => {
    throw new Error('Spotify-Zugangsdaten ungültig (' + e.message + ')');
  });
  token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return token.value;
}

// Benutzer-Token aus dem gespeicherten Refresh-Token (nötig für Playlist-Inhalte)
async function getUserToken(cfg) {
  if (!cfg.spotifyRefreshToken || !cfg.spotifyClientId || !cfg.spotifyClientSecret) return null;
  if (userToken && userToken.expires > Date.now() + 60000) return userToken.value;
  try {
    const j = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: cfg.spotifyRefreshToken });
    userToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
    if (j.refresh_token && j.refresh_token !== cfg.spotifyRefreshToken) persist({ spotifyRefreshToken: j.refresh_token });
    return userToken.value;
  } catch (e) {
    if (e.code === 'invalid_grant') {
      // Anmeldung widerrufen oder abgelaufen → abmelden
      persist({ spotifyRefreshToken: '', spotifyUser: '' });
      userToken = null;
    }
    throw e;
  }
}

// ---------- "Mit Spotify anmelden" (Authorization Code + PKCE) ----------

function loginUrl(cfg, redirect) {
  if (!cfg.spotifyClientId || !cfg.spotifyClientSecret) throw new Error('Bitte zuerst Client ID und Client Secret eintragen und speichern');
  const crypto = require('crypto');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  pendingLogins.set(state, { verifier, redirect, created: Date.now() });
  for (const [k, v] of pendingLogins) if (Date.now() - v.created > 15 * 60000) pendingLogins.delete(k);
  const q = new URLSearchParams({
    client_id: cfg.spotifyClientId,
    response_type: 'code',
    redirect_uri: redirect,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: 'playlist-read-private playlist-read-collaborative',
  });
  return `https://accounts.spotify.com/authorize?${q}`;
}

// Verarbeitet die Rückleitung von Spotify. Liefert den Anzeigenamen des Kontos.
async function handleCallback(cfg, params) {
  if (params.get('error')) throw new Error(params.get('error') === 'access_denied' ? 'Anmeldung abgebrochen' : params.get('error'));
  const login = pendingLogins.get(params.get('state'));
  if (!login) throw new Error('Anmeldung abgelaufen – bitte erneut versuchen');
  pendingLogins.delete(params.get('state'));
  const j = await tokenRequest(cfg, {
    grant_type: 'authorization_code',
    code: params.get('code'),
    redirect_uri: login.redirect,
    code_verifier: login.verifier,
  });
  userToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  const me = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + j.access_token } })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  const name = me.display_name || me.id || 'Spotify-Konto';
  persist({ spotifyRefreshToken: j.refresh_token, spotifyUser: name });
  return name;
}

function logout() {
  userToken = null;
  persist({ spotifyRefreshToken: '', spotifyUser: '' });
}

async function api(cfg, url, { user = false } = {}) {
  const t = user ? await getUserToken(cfg) : await getToken(cfg);
  const res = await fetch(url.startsWith('http') ? url : 'https://api.spotify.com/v1' + url, { headers: { Authorization: 'Bearer ' + t } });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const err = new Error(`Spotify-API: HTTP ${res.status}${j.error?.message ? ' – ' + j.error.message : ''}`);
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
  // Playlist-Inhalte gibt Spotify nur noch mit Benutzer-Anmeldung heraus
  const user = !!cfg.spotifyRefreshToken;
  if (!user) {
    const err = new Error('Für Playlists mit mehr als 100 Titeln bitte in den Einstellungen „Mit Spotify anmelden“ – Client ID/Secret allein reichen bei Spotify nicht mehr.');
    err.hint = true;
    throw err;
  }
  const p = await api(cfg, `/playlists/${id}?fields=name,images`, { user });
  const tracks = [];
  let next = await api(cfg, `/playlists/${id}/items?limit=50`, { user });
  while (next) {
    for (const it of next.items || []) {
      const t = it.item || it.track;
      if (t && t.type !== 'episode' && t.name) tracks.push(apiTrack(t));
    }
    next = next.next ? await api(cfg, next.next, { user }) : null;
  }
  return { name: p.name, cover: p.images?.[0]?.url || '', truncated: false, tracks };
}

function explainApiError(e, type) {
  if (e.hint) return e.message;
  if (e.status === 404 && type === 'playlist') {
    return 'Spotify sperrt den Zugriff auf Spotify-eigene Playlists (z. B. „Today’s Top Hits“, „This Is …“, Mixe) für eigene Apps – es werden nur die ersten 100 Titel gelesen. Tipp: Playlist in Spotify kopieren („Zu anderer Playlist hinzufügen“) und den Link der Kopie verwenden.';
  }
  if (e.status === 403 && type === 'playlist') {
    return 'Spotify verweigert den Zugriff auf diese Playlist (nur eigene oder gemeinsame Playlists). Tipp: Playlist in Spotify in eine eigene Playlist kopieren und deren Link verwenden.';
  }
  return `Spotify-API nicht nutzbar (${e.message}) – es werden nur die ersten 100 Titel gelesen.`;
}

async function loadSpotify(cfg, input) {
  const ref = parseSpotifyUrl(input);
  if (!ref) throw new Error('Kein gültiger Spotify-Link (Playlist, Album oder Track)');
  if (ref.type === 'artist') throw new Error('Künstler-Links werden nicht unterstützt – bitte Album oder Playlist verwenden');
  let apiNote = null;
  if (cfg.spotifyClientId && cfg.spotifyClientSecret) {
    try {
      return await fromApi(cfg, ref.type, ref.id);
    } catch (e) {
      console.warn('API fehlgeschlagen, nutze Embed:', e.message);
      apiNote = explainApiError(e, ref.type);
    }
  }
  const res = await fromEmbed(ref.type, ref.id);
  return { ...res, apiNote: res.truncated ? apiNote : null };
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

module.exports = { loadSpotify, searchPlaylists, searchTracks, parseSpotifyUrl, loginUrl, handleCallback, logout, setPersist };
