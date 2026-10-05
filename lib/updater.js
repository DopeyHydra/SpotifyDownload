// Selbst-Update über GitHub-Releases: neueste Version prüfen, Installer laden und still ausführen.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { IS_PACKAGED, VERSION } = require('./paths');

const REPO = 'DopeyHydra/SpotifyDownload';
const HEADERS = { 'User-Agent': 'SpotifyDownloader', Accept: 'application/vnd.github+json' };

let state = { current: VERSION, latest: null, available: false, notes: '', url: '', asset: null, checking: false, progress: null, error: null };

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function check() {
  state.checking = true;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: HEADERS });
    if (!res.ok) throw new Error(`GitHub antwortet mit HTTP ${res.status}`);
    const rel = await res.json();
    const asset = (rel.assets || []).find((a) => /setup.*\.exe$/i.test(a.name));
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    Object.assign(state, {
      latest,
      available: !!asset && newer(latest, VERSION),
      notes: rel.body || '',
      url: rel.html_url,
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
      error: null,
    });
  } catch (e) {
    state.error = e.message;
  } finally {
    state.checking = false;
  }
  return getState();
}

function getState() {
  const { asset, ...rest } = state;
  return { ...rest, packaged: IS_PACKAGED, size: asset?.size || null };
}

// Lädt den Installer herunter, startet ihn still und beendet danach das Programm.
// Der Installer startet die neue Version anschließend selbst (Parameter /UPDATE=1).
async function install(onProgress, shutdown) {
  if (!IS_PACKAGED) throw new Error('Updates gibt es nur für die installierte Version');
  if (!state.available || !state.asset) throw new Error('Kein Update verfügbar');
  const target = path.join(os.tmpdir(), state.asset.name);
  const res = await fetch(state.asset.url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || state.asset.size || 0;
  const out = fs.createWriteStream(target);
  let done = 0;
  let last = 0;
  for await (const chunk of res.body) {
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    done += chunk.length;
    const pct = total ? Math.floor((done / total) * 100) : null;
    if (pct !== last) onProgress((last = pct));
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  if (total && fs.statSync(target).size !== total) throw new Error('Download unvollständig');

  spawn(target, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/UPDATE=1'], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(shutdown, 500);
}

module.exports = { check, install, getState };
