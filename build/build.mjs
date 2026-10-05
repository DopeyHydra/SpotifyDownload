// Baut dist/app/SpotifyDownloader.exe (Node Single Executable) und den Installer dist/SpotifyDownloader-Setup-x.y.z.exe
// Aufruf: npm run build
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const OUT = path.join(BUILD, 'out');
const DIST = path.join(ROOT, 'dist');
const APP = path.join(DIST, 'app');
const EXE = path.join(APP, 'SpotifyDownloader.exe');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// Nur für Tests: andere Versionsnummer erzwingen (BUILD_VERSION=1.0.9 npm run build)
if (process.env.BUILD_VERSION) pkg.version = process.env.BUILD_VERSION;

const step = (msg) => console.log(`\n▶ ${msg}`);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT });

fs.rmSync(DIST, { recursive: true, force: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(APP, 'bin'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

step('Icon erzeugen');
run(process.execPath, [path.join(BUILD, 'make-icon.js')]);

step('Code bündeln (esbuild)');
await (await import('esbuild')).build({
  entryPoints: [path.join(ROOT, 'server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: path.join(OUT, 'app.cjs'),
  define: { 'process.env.APP_VERSION': JSON.stringify(pkg.version) },
  logLevel: 'warning',
});

step('SEA-Blob erzeugen');
const assets = {};
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) assets[`public/${f}`] = path.join(ROOT, 'public', f);
const seaConfig = {
  main: path.join(OUT, 'app.cjs'),
  output: path.join(OUT, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets,
};
fs.writeFileSync(path.join(OUT, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
run(process.execPath, ['--experimental-sea-config', path.join(OUT, 'sea-config.json')]);

step('exe erstellen');
fs.copyFileSync(process.execPath, EXE);
const { rcedit } = await import('rcedit');
await rcedit(EXE, {
  icon: path.join(BUILD, 'icon.ico'),
  'file-version': pkg.version,
  'product-version': pkg.version,
  'version-string': {
    ProductName: 'Spotify Downloader',
    FileDescription: 'Spotify Downloader',
    CompanyName: 'Spotify Downloader',
    OriginalFilename: 'SpotifyDownloader.exe',
    InternalName: 'SpotifyDownloader',
    LegalCopyright: '',
  },
});
run(process.execPath, [
  require.resolve('postject/dist/cli.js'),
  EXE, 'NODE_SEA_BLOB', path.join(OUT, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);

// PE-Subsystem auf "Windows GUI" setzen → kein Konsolenfenster beim Start
const buf = fs.readFileSync(EXE);
const pe = buf.readUInt32LE(0x3c);
if (buf.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Kein gültiges PE-Format');
const subsystemOffset = pe + 4 + 20 + 68;
buf.writeUInt16LE(2, subsystemOffset);
fs.writeFileSync(EXE, buf);

step('yt-dlp und ffmpeg beilegen');
for (const f of ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe']) {
  const src = path.join(ROOT, 'bin', f);
  if (!fs.existsSync(src)) throw new Error(`${src} fehlt – einmal "npm start" ausführen, damit die Werkzeuge geladen werden`);
  fs.copyFileSync(src, path.join(APP, 'bin', f));
}
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(APP, 'README.md'));

step('Prüfen, dass keine Zugangsdaten im Paket landen');
{
  let secrets = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    secrets = [cfg.spotifyClientId, cfg.spotifyClientSecret].filter((v) => v && v.length >= 8);
  } catch {}
  const scan = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scan(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of [...scan(APP), path.join(OUT, 'app.cjs')]) {
    if (path.basename(f).toLowerCase() === 'config.json') throw new Error(`config.json darf nicht ins Paket: ${f}`);
    const data = fs.readFileSync(f);
    for (const s of secrets) {
      if (data.includes(Buffer.from(s)) || data.includes(Buffer.from(s, 'utf16le'))) {
        throw new Error(`Spotify-Zugangsdaten in ${f} gefunden – Build abgebrochen`);
      }
    }
  }
  console.log(`ok (${secrets.length ? 'lokale Zugangsdaten gesucht, nicht gefunden' : 'keine lokalen Zugangsdaten vorhanden'})`);
}

step('Installer bauen (Inno Setup)');
const iscc = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
  path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
].find((p) => fs.existsSync(p));
if (!iscc) throw new Error('Inno Setup nicht gefunden: winget install JRSoftware.InnoSetup');
run(iscc, ['/Q', `/DAppVersion=${pkg.version}`, path.join(BUILD, 'installer.iss')]);

const setup = path.join(DIST, `SpotifyDownloader-Setup-${pkg.version}.exe`);
console.log(`\n✔ Fertig: ${setup} (${(fs.statSync(setup).size / 1e6).toFixed(1)} MB)`);

