// Veröffentlicht dist/SpotifyDownloader-Setup-<version>.exe als GitHub-Release v<version>.
// Aufruf: npm run release -- "Kurze Beschreibung der Änderungen"
// Token: Umgebungsvariable GH_TOKEN oder die von git gespeicherte GitHub-Anmeldung.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'DopeyHydra/SpotifyDownload';
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const FILE = path.join(ROOT, 'dist', `SpotifyDownloader-Setup-${version}.exe`);
const notes = process.argv.slice(2).join(' ').trim();

if (!fs.existsSync(FILE)) throw new Error(`${FILE} fehlt – zuerst "npm run build" ausführen`);

const token =
  process.env.GH_TOKEN ||
  (execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n' }).toString().match(/^password=(.*)$/m) || [])[1];
if (!token) throw new Error('Kein GitHub-Token gefunden (GH_TOKEN setzen oder einmal "git push" ausführen)');
const H = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'SpotifyDownloader-release' };

const body = `## Spotify Downloader ${version}

${notes ? notes + '\n\n' : ''}### Installation / Update
- **Neu:** SpotifyDownloader-Setup-${version}.exe herunterladen und ausführen (keine Adminrechte nötig). Bei „Der Computer wurde durch Windows geschützt“: **Weitere Informationen → Trotzdem ausführen**.
- **Bereits installiert (ab 1.1.0):** Das Programm zeigt oben „Neue Version verfügbar“ an. Ein Klick auf **Jetzt aktualisieren** genügt.`;

let r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, { headers: H });
let rel;
if (r.ok) {
  rel = await r.json();
  console.log('Release existiert bereits:', rel.html_url);
} else {
  r = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: `v${version}`, target_commitish: 'main', name: `Spotify Downloader ${version}`, body, make_latest: 'true' }),
  });
  if (!r.ok) throw new Error(`Release anlegen: HTTP ${r.status} ${await r.text()}`);
  rel = await r.json();
  console.log('Release angelegt:', rel.html_url);
}

const name = path.basename(FILE);
for (const a of rel.assets || []) if (a.name === name) await fetch(a.url, { method: 'DELETE', headers: H });
const data = fs.readFileSync(FILE);
console.log(`Lade ${name} hoch (${(data.length / 1e6).toFixed(1)} MB) …`);
r = await fetch(rel.upload_url.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(name)}`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/vnd.microsoft.portable-executable', 'Content-Length': String(data.length) },
  body: data,
});
if (!r.ok) throw new Error(`Upload: HTTP ${r.status} ${await r.text()}`);
const asset = await r.json();
if (asset.size !== data.length) throw new Error('Hochgeladene Größe stimmt nicht');
console.log('✔ Veröffentlicht:', asset.browser_download_url);
