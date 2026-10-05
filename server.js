// Spotify → YouTube Downloader – lokaler Webserver (ohne externe Abhängigkeiten)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const paths = require('./lib/paths');
const tools = require('./lib/tools');
const { parseTxt } = require('./lib/parse');
const spotify = require('./lib/spotify');
const yt = require('./lib/youtube');
const updater = require('./lib/updater');
const dups = require('./lib/duplicates');

const PORT = Number(process.env.PORT) || 3456;
const CONFIG_FILE = path.join(paths.APP_DIR, 'config.json');

// Gepackte Version hat kein Konsolenfenster → Ausgaben in app.log schreiben
if (paths.IS_PACKAGED) {
  const logFile = path.join(paths.APP_DIR, 'app.log');
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1e6) fs.rmSync(logFile);
  } catch {}
  const log = (lvl) => (...a) => {
    try {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${lvl} ${a.join(' ')}\n`);
    } catch {}
  };
  console.log = log('INFO');
  console.warn = log('WARN');
  console.error = log('ERROR');
  process.on('uncaughtException', (e) => console.error(e.stack || e));
}

const DEFAULT_CONFIG = {
  outputDir: paths.defaultDownloadDir(),
  format: 'mp3',
  quality: '320K',
  concurrency: 2,
  source: 'ytmusic',
  subfolder: true,
  askOnUncertain: true,
  spotifyClientId: '',
  spotifyClientSecret: '',
  dupFolders: [],
  dupBySong: true,
};

let config = { ...DEFAULT_CONFIG };
try {
  config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
} catch {}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ---------- Live-Updates (Server-Sent Events) ----------

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- Download-Warteschlange ----------

const jobs = new Map(); // id -> job
let nextId = 1;
let running = 0;

function publicJob(j) {
  const { kill, ...rest } = j;
  return rest;
}

function update(job, patch) {
  Object.assign(job, patch);
  broadcast('job', publicJob(job));
}

function pump() {
  if (!tools.getStatus().ready) return;
  while (running < Math.max(1, Number(config.concurrency) || 1)) {
    const job = [...jobs.values()].find((j) => j.status === 'queued');
    if (!job) return;
    running++;
    processJob(job)
      .catch((e) => {
        // Fehlgeschlagene Quelle merken, damit sie bei der nächsten Auswahl nicht wieder genommen wird
        const failedIds = job.videoId && !job.failedIds?.includes(job.videoId) ? [...(job.failedIds || []), job.videoId] : job.failedIds;
        update(job, { status: 'error', error: e.message, failedIds });
      })
      .finally(() => {
        running--;
        job.kill = null;
        pump();
      });
  }
}

async function processJob(job) {
  const t = job.track;
  const dir = config.subfolder && job.listName ? path.join(config.outputDir, yt.safeName(job.listName)) : config.outputDir;
  const base = yt.trackBaseName(t);
  const target = path.join(dir, `${base}.${config.format}`);
  if (fs.existsSync(target)) return update(job, { status: 'exists', progress: 100, file: target });

  let videoId = t.videoId;
  if (!videoId) {
    update(job, { status: 'searching' });
    const failed = new Set(job.failedIds || []);
    const candidates = (await yt.searchCandidates(t, config)).filter((c) => !failed.has(c.id));
    if (job.status === 'cancelled') return;
    job.candidates = candidates.slice(0, 8);
    const best = candidates[0];
    if (!best || (best.score < yt.MIN_SCORE && config.askOnUncertain && !job.auto)) {
      // Nicht eindeutig gefunden → Nutzer wählt aus Spotify-/YouTube-Vorschlägen
      return update(job, { status: 'review', candidates: candidates.slice(0, 8), match: null });
    }
    videoId = best.id;
    update(job, { match: { id: best.id, title: best.title, channel: best.channel, url: best.url, score: best.score, source: best.source } });
  } else if (!job.match) {
    update(job, { match: { id: videoId, title: t.videoTitle || videoId, url: `https://www.youtube.com/watch?v=${videoId}` } });
  }

  update(job, { status: 'downloading', progress: 0, videoId });
  const dl = yt.downloadAudio({ videoId, dir, base, format: config.format, quality: config.quality }, (ev) => {
    if (ev.type === 'progress' && Math.abs(ev.value - (job.progress || 0)) >= 2) update(job, { progress: ev.value });
    if (ev.type === 'stage' && job.status !== 'converting') update(job, { status: 'converting', progress: 100 });
  });
  job.kill = dl.kill;
  let file;
  try {
    file = await dl.promise;
  } catch (e) {
    if (job.status === 'cancelled') return;
    throw e;
  }
  update(job, { status: 'converting' });
  await yt.writeTags(file, t, job.trackNo);
  update(job, { status: 'done', progress: 100, file });
}

// ---------- HTTP ----------

function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => {
      b += d;
      if (b.length > 50e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function openBrowser(url) {
  if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function openInExplorer(p) {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const isFile = fs.existsSync(p) && fs.statSync(p).isFile();
  const args = process.platform === 'win32' && isFile ? [`/select,${p}`] : [isFile ? path.dirname(p) : p];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

// Öffnet den Windows-Ordnerauswahldialog und liefert den gewählten Pfad
function pickFolder(initial) {
  if (process.platform !== 'win32') throw new Error('Ordnerauswahl nur unter Windows – bitte Pfad eintippen');
  const ps = `
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    Add-Type -AssemblyName System.Windows.Forms
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = 'Download-Ordner wählen'
    $d.ShowNewFolderButton = $true
    if (Test-Path $env:PICK_INITIAL) { $d.SelectedPath = $env:PICK_INITIAL }
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
    if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath }`;
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true, env: { ...process.env, PICK_INITIAL: initial || '' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => resolve({ path: out.trim() || null }));
  });
}

let dupScan = { running: false, cancelled: false, files: new Set() };

// Spielt eine Datei aus dem Duplikat-Ergebnis ab (mit Range-Unterstützung zum Spulen)
function streamDupFile(req, res, file) {
  if (!dupScan.files.has(file) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  const size = fs.statSync(file).size;
  const types = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm' };
  const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

const routes = {
  'GET /api/status': () => ({ version: paths.VERSION, packaged: paths.IS_PACKAGED, update: updater.getState(), tools: tools.getStatus(), minScore: yt.MIN_SCORE, config: { ...config, spotifyClientSecret: config.spotifyClientSecret ? '••••••' : '' } }),

  'POST /api/config': (body) => {
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (body[k] === undefined) continue;
      if (k === 'spotifyClientSecret' && body[k] === '••••••') continue;
      config[k] = body[k];
    }
    config.concurrency = Math.min(8, Math.max(1, Number(config.concurrency) || 2));
    config.outputDir = path.resolve(String(config.outputDir || DEFAULT_CONFIG.outputDir).trim());
    try {
      fs.mkdirSync(config.outputDir, { recursive: true });
    } catch (e) {
      throw new Error('Download-Ordner kann nicht angelegt werden: ' + e.message);
    }
    saveConfig();
    pump();
    return { ok: true };
  },

  'POST /api/import': (body) => {
    const tracks = parseTxt(body.text || '');
    if (!tracks.length) throw new Error('Keine Titel in der Datei erkannt');
    return { name: body.name || 'Import', tracks };
  },

  'POST /api/spotify': (body) => spotify.loadSpotify(config, body.url || ''),

  'POST /api/youtube-playlist': (body) => {
    if (!/youtu\.?be/.test(body.url || '')) throw new Error('Kein gültiger YouTube-Link');
    return yt.loadPlaylist(body.url);
  },

  'POST /api/playlists': async (body) => {
    const q = (body.q || '').trim();
    if (!q) throw new Error('Bitte Suchbegriff eingeben');
    const [sp, ytr] = await Promise.allSettled([spotify.searchPlaylists(config, q), yt.searchPlaylists(q)]);
    return {
      spotify: sp.status === 'fulfilled' ? sp.value : { available: true, error: sp.reason.message, results: [] },
      youtube: ytr.status === 'fulfilled' ? ytr.value : [],
      youtubeError: ytr.status === 'rejected' ? ytr.reason.message : null,
    };
  },

  'POST /api/match': async (body) => ({ candidates: (await yt.searchCandidates(body.track || {}, config)).slice(0, 10) }),

  'POST /api/download': (body) => {
    const ids = [];
    (body.tracks || []).forEach((t, i) => {
      const job = { id: nextId++, track: t, auto: false, trackNo: t.trackNo || i + 1, listName: body.listName || '', status: 'queued', progress: 0 };
      jobs.set(job.id, job);
      ids.push(job.id);
      broadcast('job', publicJob(job));
    });
    pump();
    return { ids };
  },

  'POST /api/cancel': (body) => {
    for (const j of jobs.values()) {
      if (body.id !== undefined && j.id !== body.id) continue;
      if (['queued', 'searching', 'downloading', 'converting', 'review'].includes(j.status)) {
        j.kill?.();
        update(j, { status: 'cancelled' });
      }
    }
    return { ok: true };
  },

  'POST /api/retry': (body) => {
    for (const j of jobs.values()) {
      if ((body.id === undefined || j.id === body.id) && ['error', 'cancelled'].includes(j.status)) {
        if (body.videoId) {
          j.track = { ...j.track, videoId: body.videoId };
          j.match = null;
        }
        update(j, { status: 'queued', progress: 0, error: null, videoId: null });
      }
    }
    pump();
    return { ok: true };
  },

  // Vorschläge, wenn ein Song nicht eindeutig gefunden wurde
  'POST /api/suggest': async (body) => {
    const t = body.track || {};
    const q = (body.q || '').trim();
    const spQuery = q || [yt.coreTitle(t.title || ''), yt.primaryArtist(t.artist)].filter(Boolean).join(' ');
    const [sp, ytc] = await Promise.allSettled([spotify.searchTracks(config, spQuery), yt.searchCandidates(t, config, q || undefined)]);
    return {
      spotify: sp.status === 'fulfilled' ? sp.value : { available: true, error: sp.reason.message, results: [] },
      youtube: ytc.status === 'fulfilled' ? ytc.value.slice(0, 8) : [],
    };
  },

  // Auswahl für einen Job übernehmen: neuer Spotify-Titel (wird neu gesucht) oder direktes YouTube-Video
  'POST /api/resolve': (body) => {
    const j = jobs.get(body.id);
    if (!j) throw new Error('Download nicht gefunden');
    const track = { ...j.track, ...(body.track || {}) };
    if (body.videoId) Object.assign(track, { videoId: body.videoId, videoTitle: body.videoTitle });
    else delete track.videoId;
    // Nach einer Spotify-Auswahl den besten YouTube-Treffer ohne erneute Rückfrage nehmen
    update(j, { track, auto: true, match: null, videoId: null, status: 'queued', progress: 0, error: null });
    pump();
    return { ok: true };
  },

  'POST /api/pick-folder': () => pickFolder(config.outputDir),

  'POST /api/update/check': async () => {
    const s = await updater.check();
    broadcast('update', s);
    return s;
  },

  'POST /api/update/install': () => {
    updater
      .install((p) => broadcast('update', { ...updater.getState(), progress: p }), shutdown)
      .catch((e) => broadcast('update', { ...updater.getState(), progress: null, error: 'Update fehlgeschlagen: ' + e.message }));
    return { ok: true };
  },

  // ---------- Duplikate ----------
  'POST /api/dups/scan': async (body) => {
    if (dupScan.running) throw new Error('Es läuft bereits eine Suche');
    const folders = (body.folders || []).map((p) => String(p).trim()).filter(Boolean);
    if (!folders.length) throw new Error('Bitte mindestens einen Ordner hinzufügen');
    config.dupFolders = folders;
    config.dupBySong = body.bySong !== false;
    saveConfig();
    dupScan = { running: true, cancelled: false, files: new Set() };
    try {
      const res = await dups.scan(folders, { bySong: config.dupBySong }, (p) => broadcast('dups', p), () => dupScan.cancelled);
      dupScan.files = res.files;
      return { groups: res.groups, stats: res.stats };
    } finally {
      dupScan.running = false;
    }
  },

  'POST /api/dups/cancel': () => {
    dupScan.cancelled = true;
    return { ok: true };
  },

  'POST /api/dups/delete': async (body) => {
    // Nur Dateien aus dem letzten Suchergebnis dürfen gelöscht werden
    const list = (body.paths || []).filter((p) => dupScan.files.has(p));
    if (!list.length) throw new Error('Keine gültigen Dateien ausgewählt');
    const res = await dups.moveToRecycleBin(list);
    for (const p of res.deleted) dupScan.files.delete(p);
    return res;
  },

  'POST /api/quit': () => {
    setTimeout(shutdown, 300);
    return { ok: true };
  },

  'POST /api/clear': () => {
    for (const [id, j] of jobs) if (['done', 'exists', 'cancelled', 'error'].includes(j.status)) jobs.delete(id);
    broadcast('jobs', [...jobs.values()].map(publicJob));
    return { ok: true };
  },

  'POST /api/open': (body) => {
    const p = body.path || config.outputDir;
    fs.mkdirSync(fs.existsSync(p) && fs.statSync(p).isFile() ? path.dirname(p) : p, { recursive: true });
    openInExplorer(p);
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: jobs\ndata: ${JSON.stringify([...jobs.values()].map(publicJob))}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/dups/file') return streamDupFile(req, res, url.searchParams.get('path') || '');

  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, await route(body));
    } catch (e) {
      send(res, 400, { error: e.message });
    }
    return;
  }

  // Statische Dateien
  const name = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const data = name.includes('..') ? null : paths.readPublic(name);
  if (!data) {
    res.writeHead(404);
    return res.end('Nicht gefunden');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(data);
});

function shutdown() {
  for (const j of jobs.values()) j.kill?.();
  broadcast('bye', {});
  process.exit(0);
}

// Gepackte Version beendet sich selbst, wenn kein Browser-Tab mehr offen ist und nichts mehr lädt
if (paths.IS_PACKAGED) {
  let idleSince = Date.now();
  setInterval(() => {
    const busy = [...jobs.values()].some((j) => ['queued', 'searching', 'downloading', 'converting'].includes(j.status));
    if (clients.size || busy) idleSince = Date.now();
    else if (Date.now() - idleSince > 3 * 60 * 1000) shutdown();
  }, 10000).unref();
}

// Status der Werkzeug-Einrichtung regelmäßig an die Oberfläche senden
setInterval(() => broadcast('tools', tools.getStatus()), 1000).unref();

let port = PORT;
let URL_BASE = `http://localhost:${port}`;
let quitAttempts = 0;

// Port belegt: Wer läuft dort?
//  - dieselbe Version derselben Art (installiert/Entwicklung) → nur Browser öffnen und beenden
//  - eine andere installierte Version → diese beenden und den Port übernehmen
//  - Entwicklungsserver, fremdes Programm o. Ä. → auf den nächsten Port ausweichen
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') {
    console.error(e.stack || e);
    process.exit(1);
  }
  let other = null;
  try {
    other = await (await fetch(`http://localhost:${port}/api/status`, { signal: AbortSignal.timeout(3000) })).json();
  } catch {}
  if (other && other.version === paths.VERSION && !!other.packaged === paths.IS_PACKAGED) {
    if (!process.argv.includes('--no-browser')) openBrowser(`http://localhost:${port}`);
    return process.exit(0);
  }
  if (other && other.packaged && paths.IS_PACKAGED && quitAttempts < 3) {
    quitAttempts++;
    console.log(`Beende ältere Version ${other.version} auf Port ${port}`);
    await fetch(`http://localhost:${port}/api/quit`, { method: 'POST', body: '{}' }).catch(() => {});
    return setTimeout(() => server.listen(port, '127.0.0.1'), 1500);
  }
  if (port >= PORT + 10) {
    console.error(`Kein freier Port zwischen ${PORT} und ${port} gefunden.`);
    process.exit(1);
  }
  console.log(`Port ${port} belegt (${other ? 'andere Instanz ' + other.version : 'fremdes Programm'}) – weiche aus`);
  port++;
  server.listen(port, '127.0.0.1');
});

server.listen(port, '127.0.0.1', () => {
  URL_BASE = `http://localhost:${port}`;
  console.log(`Spotify → YouTube Downloader ${paths.VERSION} läuft auf ${URL_BASE}`);
  if (process.argv.includes('--updated')) {
    // Nach einem Update verbindet sich der offene Tab neu – nur falls keiner da ist, Browser öffnen
    setTimeout(() => clients.size || openBrowser(URL_BASE), 8000);
  } else if (!process.argv.includes('--no-browser')) openBrowser(URL_BASE);
  // Beim Start nach Updates sehen (weitere Prüfung nur auf Anfrage über die Einstellungen)
  updater.check().then((s) => broadcast('update', s));
  tools.ensureTools().then(pump);
});
