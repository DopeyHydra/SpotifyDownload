// Duplikatsuche: findet identische Dateien (Prüfsumme) und denselben Song in verschiedenen Dateien (Tags/Dateiname).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { FFMPEG } = require('./tools');
const { normalize, coreTitle, primaryArtist } = require('./youtube');

const FFPROBE = path.join(path.dirname(FFMPEG), path.basename(FFMPEG).replace(/ffmpeg/i, 'ffprobe'));
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.alac', '.webm', '.mp4']);

// Cache für Tag-Infos (bleibt erhalten, solange das Programm läuft) – Schlüssel: Pfad + Größe + Änderungszeit
const probeCache = new Map();

async function walk(root, out, isCancelled) {
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (isCancelled()) return;
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('$') && e.name !== 'System Volume Information') await walk(p, out, isCancelled);
    } else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(p);
    }
  }
}

function probe(file) {
  return new Promise((resolve) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,bit_rate:format_tags', '-of', 'json', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve({}));
    p.on('close', () => {
      try {
        const f = JSON.parse(out).format || {};
        const tags = {};
        for (const [k, v] of Object.entries(f.tags || {})) tags[k.toLowerCase()] = v;
        resolve({
          duration: f.duration ? Math.round(Number(f.duration)) : null,
          bitrate: f.bit_rate ? Math.round(Number(f.bit_rate) / 1000) : null,
          title: tags.title || '',
          artist: tags.artist || tags.album_artist || '',
        });
      } catch {
        resolve({});
      }
    });
  });
}

function hashFile(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', () => resolve(null));
  });
}

// "01 - Icona Pop - I Love It (Official Audio)" → { artist: "Icona Pop", title: "I Love It" }
function fromFilename(file) {
  const base = path.basename(file, path.extname(file))
    .replace(/^\s*\d{1,3}\s*[-._)]\s*/, '')
    .replace(/\s*[([](official|offizielles|lyrics?|audio|video|music video|hd|hq|4k|visualizer)[^)\]]*[)\]]/gi, '')
    .trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

function songKey(artist, title) {
  const t = normalize(coreTitle(title).replace(/\s*[([](remaster(ed)?|\d{4} remaster)[^)\]]*[)\]]/gi, ''));
  if (!t) return null;
  const a = normalize(primaryArtist(artist));
  return `${a || '?'}|${t}`;
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * roots: Ordnerliste. bySong: auch gleiche Songs in unterschiedlichen Dateien finden.
 * onProgress({ phase, done, total }). Liefert { groups, stats, files: Set<Pfad> }.
 */
async function scan(roots, { bySong = true } = {}, onProgress = () => {}, isCancelled = () => false) {
  const uniqueRoots = [...new Set(roots.map((r) => path.resolve(r)))].filter((r) => fs.existsSync(r));
  if (!uniqueRoots.length) throw new Error('Keiner der Ordner existiert');

  onProgress({ phase: 'Dateien suchen', done: 0, total: 0 });
  const files = [];
  for (const r of uniqueRoots) await walk(r, files, isCancelled);
  const allFiles = [...new Set(files)];

  const infos = new Map();
  let done = 0;
  await pool(allFiles, 8, async (file) => {
    if (isCancelled()) return;
    let st;
    try {
      st = await fs.promises.stat(file);
    } catch {
      return;
    }
    const cacheKey = `${file}|${st.size}|${st.mtimeMs}`;
    let meta = bySong ? probeCache.get(cacheKey) : {};
    if (bySong && !meta) {
      meta = await probe(file);
      probeCache.set(cacheKey, meta);
    }
    const root = uniqueRoots.filter((r) => file.startsWith(r.endsWith(path.sep) ? r : r + path.sep)).sort((a, b) => b.length - a.length)[0];
    const fallback = fromFilename(file);
    infos.set(file, {
      path: file,
      root,
      rel: path.join(path.basename(root) || root.replace(/[\\/]+$/, ''), path.relative(root, file)),
      size: st.size,
      mtime: st.mtimeMs,
      ext: path.extname(file).slice(1).toLowerCase(),
      duration: meta.duration || null,
      bitrate: meta.bitrate || null,
      artist: meta.artist || fallback.artist,
      title: meta.title || fallback.title,
    });
    if (++done % 20 === 0 || done === allFiles.length) onProgress({ phase: 'Dateien lesen', done, total: allFiles.length });
  });
  if (isCancelled()) throw new Error('Abgebrochen');

  // 1) Identische Dateien: gleiche Größe → Prüfsumme
  const bySize = new Map();
  for (const f of infos.values()) bySize.set(f.size, [...(bySize.get(f.size) || []), f]);
  const candidates = [...bySize.values()].filter((g) => g.length > 1).flat();
  done = 0;
  await pool(candidates, 4, async (f) => {
    if (isCancelled()) return;
    f.hash = await hashFile(f.path);
    if (++done % 10 === 0 || done === candidates.length) onProgress({ phase: 'Inhalte vergleichen', done, total: candidates.length });
  });
  if (isCancelled()) throw new Error('Abgebrochen');

  // Union-Find: Dateien landen in einer Gruppe, wenn sie identisch sind oder (optional) derselbe Song
  const parent = new Map([...infos.keys()].map((k) => [k, k]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const union = (a, b) => parent.set(find(a), find(b));
  const link = (map) => {
    for (const list of map.values()) for (let i = 1; i < list.length; i++) union(list[0], list[i]);
  };
  const byHash = new Map();
  for (const f of infos.values()) if (f.hash) byHash.set(f.hash, [...(byHash.get(f.hash) || []), f.path]);
  link(byHash);
  if (bySong) {
    const byKey = new Map();
    for (const f of infos.values()) {
      const k = songKey(f.artist, f.title);
      if (k) byKey.set(k, [...(byKey.get(k) || []), f.path]);
    }
    link(byKey);
  }

  const grouped = new Map();
  for (const f of infos.values()) {
    const r = find(f.path);
    grouped.set(r, [...(grouped.get(r) || []), f]);
  }

  const groups = [...grouped.values()]
    .filter((g) => g.length > 1)
    .map((g, i) => {
      // Beste Qualität zuerst: höhere Bitrate, verlustfreie Formate, größere Datei
      const lossless = (f) => ['flac', 'wav', 'aiff', 'aif', 'alac'].includes(f.ext);
      g.sort((a, b) => lossless(b) - lossless(a) || (b.bitrate || 0) - (a.bitrate || 0) || b.size - a.size);
      const identical = g.every((f) => f.hash && f.hash === g[0].hash);
      const durations = g.map((f) => f.duration).filter(Boolean);
      const durationMismatch = durations.length > 1 && Math.max(...durations) - Math.min(...durations) > 5;
      const label = g.find((f) => f.artist)?.artist ? `${g.find((f) => f.artist).artist} – ${g[0].title}` : g[0].title;
      return { id: i + 1, label, identical, durationMismatch, files: g.map(({ hash, root, ...f }) => ({ ...f, hash: hash || null })) };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'de'));

  const wasted = groups.reduce((sum, g) => sum + g.files.slice(1).reduce((s, f) => s + f.size, 0), 0);
  return {
    groups,
    stats: { scanned: infos.size, groups: groups.length, duplicates: groups.reduce((s, g) => s + g.files.length - 1, 0), wasted },
    files: new Set(groups.flatMap((g) => g.files.map((f) => f.path))),
  };
}

// Verschiebt Dateien in den Papierkorb (Windows). Liefert { deleted: [], failed: [{path, error}] }.
function moveToRecycleBin(paths) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      const failed = paths.map((p) => ({ path: p, error: 'Papierkorb nur unter Windows' }));
      return resolve({ deleted: [], failed });
    }
    const ps = `
      [Console]::InputEncoding = [Text.Encoding]::UTF8
      [Console]::OutputEncoding = [Text.Encoding]::UTF8
      Add-Type -AssemblyName Microsoft.VisualBasic
      $paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
      $res = foreach ($p in $paths) {
        try {
          [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
          [pscustomobject]@{ path = $p; ok = $true; error = '' }
        } catch {
          [pscustomobject]@{ path = $p; ok = $false; error = $_.Exception.Message }
        }
      }
      ConvertTo-Json -InputObject @($res) -Compress`;
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      try {
        const res = JSON.parse(out.trim() || '[]');
        resolve({ deleted: res.filter((r) => r.ok).map((r) => r.path), failed: res.filter((r) => !r.ok).map(({ path: pa, error }) => ({ path: pa, error })) });
      } catch {
        resolve({ deleted: [], failed: paths.map((pa) => ({ path: pa, error: err.trim() || 'Löschen fehlgeschlagen' })) });
      }
    });
    p.stdin.end(JSON.stringify(paths));
  });
}

module.exports = { scan, moveToRecycleBin, songKey, fromFilename };
