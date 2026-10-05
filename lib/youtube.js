// YouTube: Suche, Treffer-Bewertung, Playlists und Download über yt-dlp.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { YTDLP, FFMPEG, BIN } = require('./tools');

const ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

function ytdlpJson(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, ['--ignore-config', '--no-warnings', ...args], { windowsHide: true, env: ENV });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error((err.match(/ERROR: (.*)/) || [])[1] || err.trim() || 'yt-dlp lieferte keine Daten'));
      }
    });
  });
}

// ---------- Treffer-Bewertung ----------

const UNWANTED = ['live', 'cover', 'karaoke', 'instrumental', 'remix', 'sped up', 'speed up', 'slowed', 'reverb', 'nightcore',
  '8d', 'acoustic', 'akustik', 'bass boosted', 'reaction', 'tutorial', 'lesson', 'piano version', 'extended', 'club edit',
  'radio edit', 'mashup', 'loop', '1 hour', '10 hours', 'clean', 'tiktok', 'concert', 'unplugged', 'demo',
  'version', 'edit', 'mix', 'techno', 'rework', 'bootleg', 'flip', 'vip', 'dub'];

function normalize(s) {
  return (s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`´]/g, '')
    .replace(/[^a-z0-9À-ɏЀ-ӿ぀-ヿ一-鿿]+/g, ' ')
    .trim();
}

function tokens(s) {
  return normalize(s).split(' ').filter(Boolean);
}

// "I Love It (feat. Charli XCX) - Remastered 2011" -> "I Love It"
function coreTitle(title) {
  return title
    .replace(/\s*[([]\s*(feat|ft|with|featuring)\.?\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mono|stereo|mix).*$/i, '')
    .trim();
}

function fraction(needle, haystack) {
  const n = tokens(needle);
  if (!n.length) return 0;
  const h = new Set(tokens(haystack));
  return n.filter((t) => h.has(t)).length / n.length;
}

function primaryArtist(artist) {
  return (artist || '').split(/,|&| x | feat\.? | ft\.? /i)[0].trim();
}

function scoreCandidate(track, c) {
  const hay = `${c.title} ${c.channel || ''}`;
  let score = fraction(coreTitle(track.title), c.title) * 1.0;
  score += c.source === 'ytmusic' ? 0.5 : fraction(primaryArtist(track.artist), hay) * 0.6;

  const want = normalize(`${track.title} ${track.album || ''}`);
  const got = ` ${normalize(c.title)} `;
  for (const w of UNWANTED) {
    if (got.includes(` ${w} `) && !` ${want} `.includes(` ${w} `)) score -= 0.5;
  }

  if (track.duration && c.duration) {
    const diff = Math.abs(track.duration - c.duration);
    if (diff <= 3) score += 0.35;
    else if (diff <= 10) score += 0.15;
    else if (diff > 90) score -= 1;
    else if (diff > 30) score -= 0.4;
  }
  if (/ - topic$/i.test(c.channel || '')) score += 0.25;
  if (c.source === 'ytmusic') score += 0.6 - c.rank * 0.05;
  if (/official audio|audio oficial|offizielles audio/i.test(c.title)) score += 0.1;
  return Math.round(score * 100) / 100;
}

function buildQuery(track) {
  return `${track.artist ? primaryArtist(track.artist) + ' - ' : ''}${coreTitle(track.title) || track.title}`;
}

// Unterhalb dieser Punktzahl gilt ein Treffer als unsicher → Nutzer wählt selbst.
const MIN_SCORE = 1.4;

async function searchCandidates(track, cfg, query) {
  const q = query || buildQuery(track);
  const tasks = [
    ytdlpJson(['--flat-playlist', '-J', `ytsearch8:${q}`])
      .then((j) => (j.entries || []).map((e, i) => ({
        source: 'youtube', rank: i, id: e.id, title: e.title, channel: e.channel || e.uploader || '', duration: e.duration || null,
      })))
      .catch(() => []),
  ];
  if (cfg.source !== 'youtube') {
    tasks.push(
      ytdlpJson(['--flat-playlist', '-J', '--playlist-end', '5', `https://music.youtube.com/search?q=${encodeURIComponent(q)}#songs`])
        .then((j) => (j.entries || []).map((e, i) => ({
          source: 'ytmusic', rank: i, id: e.id, title: e.title, channel: 'YouTube Music', duration: e.duration || null,
        })))
        .catch(() => []),
    );
  }
  const lists = await Promise.all(tasks);
  const byId = new Map();
  for (const c of lists.flat()) {
    if (!c.id) continue;
    const prev = byId.get(c.id);
    if (prev) {
      // Gleiches Video in beiden Suchen: Infos zusammenführen
      prev.duration = prev.duration || c.duration;
      if (c.source === 'ytmusic') Object.assign(prev, { source: 'ytmusic', rank: c.rank });
      continue;
    }
    byId.set(c.id, c);
  }
  const candidates = [...byId.values()].map((c) => ({ ...c, url: `https://www.youtube.com/watch?v=${c.id}`, score: scoreCandidate(track, c) }));
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ---------- Playlists ----------

function splitVideoTitle(title, channel) {
  const clean = title
    .replace(/\s*[([](official|offizielles|lyric|lyrics|audio|video|music video|hd|hq|4k|visualizer)[^)\]]*[)\]]/gi, '')
    .trim();
  const m = clean.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: (channel || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim(), title: clean };
}

async function loadPlaylist(url) {
  const j = await ytdlpJson(['--flat-playlist', '-J', url], 180000);
  const entries = j.entries || [j];
  return {
    name: j.title || 'YouTube',
    cover: j.thumbnails?.at(-1)?.url || '',
    truncated: false,
    tracks: entries
      .filter((e) => e.id && e.title && !/^\[(private|deleted)/i.test(e.title))
      .map((e) => {
        const t = splitVideoTitle(e.title, e.channel || e.uploader);
        return { ...t, album: '', duration: e.duration || null, videoId: e.id, videoTitle: e.title };
      }),
  };
}

async function searchPlaylists(q) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAw%253D%253D`;
  const j = await ytdlpJson(['--flat-playlist', '-J', '--playlist-end', '20', url]);
  return (j.entries || []).filter((e) => e.url).map((e) => ({
    source: 'youtube',
    url: e.url,
    title: e.title,
    owner: e.channel || e.uploader || '',
    count: e.playlist_count ?? null,
    thumb: e.thumbnails?.[0]?.url || '',
  }));
}

// ---------- Download ----------

function safeName(s) {
  return (s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 150) || 'Unbenannt';
}

function trackBaseName(track) {
  return safeName(track.artist ? `${track.artist} - ${track.title}` : track.title);
}

// Lädt ein Video als Audiodatei herunter. onEvent({type:'progress'|'stage', ...}). Gibt {promise, kill} zurück.
function downloadAudio({ videoId, dir, base, format, quality }, onEvent) {
  fs.mkdirSync(dir, { recursive: true });
  const outTpl = path.join(dir, base.replace(/%/g, '%%') + '.%(ext)s');
  const args = [
    '--ignore-config', '--no-playlist', '--newline', '--no-warnings',
    '--ffmpeg-location', BIN,
    '-f', 'bestaudio/best',
    '-x', '--audio-format', format, '--audio-quality', format === 'mp3' ? quality : '0',
    '--embed-thumbnail', '--convert-thumbnails', 'jpg',
    // Vorschaubild quadratisch zuschneiden (Albumcover-Optik)
    '--ppa', `ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -qmin 1 -qscale:v 1 -vf crop="'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'"`,
    '--progress-template', 'download:[P] %(progress._percent_str)s',
    '-o', outTpl,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  const p = spawn(YTDLP, args, { windowsHide: true, env: ENV });
  let err = '';
  const onLine = (line) => {
    const m = line.match(/^\[P\]\s*([\d.]+)%/);
    if (m) onEvent({ type: 'progress', value: Number(m[1]) });
    else if (/^\[(ExtractAudio|EmbedThumbnail|ThumbnailsConvertor|Metadata)\]/.test(line)) onEvent({ type: 'stage', value: 'converting' });
  };
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(onLine);
  });
  p.stderr.on('data', (d) => (err += d));
  const promise = new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve(path.join(dir, `${base}.${format}`));
      reject(new Error((err.match(/ERROR: (.*)/) || [])[1] || `yt-dlp beendet mit Code ${code}`));
    });
  });
  const kill = () => {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
    else p.kill('SIGKILL');
  };
  return { promise, kill };
}

// Schreibt Titel/Interpret/Album/Genre in die Datei (Cover bleibt erhalten).
function writeTags(file, track, trackNo) {
  return new Promise((resolve) => {
    const ext = path.extname(file);
    const tmp = file.slice(0, -ext.length) + '.tagging' + ext;
    const meta = { title: track.title, artist: track.artist, album_artist: primaryArtist(track.artist), album: track.album, genre: track.genre, track: trackNo };
    const args = ['-y', '-v', 'error', '-i', file, '-map', '0', '-c', 'copy'];
    if (ext === '.mp3') args.push('-id3v2_version', '3');
    for (const [k, v] of Object.entries(meta)) if (v) args.push('-metadata', `${k}=${v}`);
    args.push(tmp);
    const p = spawn(FFMPEG, args, { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('close', (code) => {
      try {
        if (code === 0) fs.renameSync(tmp, file);
        else fs.rmSync(tmp, { force: true });
      } catch {}
      resolve(code === 0);
    });
  });
}

module.exports = { MIN_SCORE, normalize, primaryArtist, coreTitle, searchCandidates, loadPlaylist, searchPlaylists, downloadAudio, writeTags, trackBaseName, safeName, buildQuery };
