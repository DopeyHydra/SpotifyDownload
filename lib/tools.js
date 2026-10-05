// Stellt sicher, dass yt-dlp.exe und ffmpeg.exe im Ordner bin/ vorhanden sind.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { BIN_DIR: BIN } = require('./paths');
const YTDLP = path.join(BIN, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const FFMPEG = path.join(BIN, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_URL = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

let status = { ready: false, message: 'Prüfe Werkzeuge …' };

async function download(url, dest, label) {
  status.message = `Lade ${label} herunter …`;
  console.log(status.message);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let done = 0;
  for await (const chunk of res.body) {
    out.write(chunk);
    done += chunk.length;
    if (total) status.message = `Lade ${label} herunter … ${Math.round((done / total) * 100)} %`;
  }
  await new Promise((r) => out.end(r));
  fs.renameSync(tmp, dest);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `${cmd} exit ${code}`))));
  });
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    } else if (e.name.toLowerCase() === name) return p;
  }
  return null;
}

async function ensureTools() {
  try {
    fs.mkdirSync(BIN, { recursive: true });
    if (!fs.existsSync(YTDLP)) {
      await download(YTDLP_URL, YTDLP, 'yt-dlp');
    } else {
      // Im Hintergrund aktualisieren – YouTube ändert sich oft.
      run(YTDLP, ['-U']).catch(() => {});
    }
    if (!fs.existsSync(FFMPEG)) {
      const zip = path.join(BIN, 'ffmpeg.zip');
      await download(FFMPEG_URL, zip, 'ffmpeg');
      status.message = 'Entpacke ffmpeg …';
      const tmpDir = path.join(BIN, 'ffmpeg-tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      // Windows-eigenes bsdtar verwenden (GNU-tar aus Git Bash versteht keine "C:"-Pfade)
      const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      await run(fs.existsSync(sysTar) ? sysTar : 'tar', ['-xf', zip, '-C', tmpDir]);
      for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
        const f = findFile(tmpDir, exe);
        if (f) fs.copyFileSync(f, path.join(BIN, exe));
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(zip, { force: true });
      if (!fs.existsSync(FFMPEG)) throw new Error('ffmpeg.exe nicht im Archiv gefunden');
    }
    status = { ready: true, message: 'Bereit' };
  } catch (e) {
    status = { ready: false, message: 'Fehler beim Einrichten: ' + e.message };
    console.error(status.message);
  }
}

module.exports = { ensureTools, getStatus: () => status, YTDLP, FFMPEG, BIN, run };
