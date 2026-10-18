// "Bei YouTube anmelden": eigenes Browserfenster (separates Profil) zum Anmelden öffnen,
// danach die Cookies über das DevTools-Protokoll auslesen und als cookies.txt für yt-dlp speichern.
// Chrome/Edge verschlüsseln Cookies unter Windows app-gebunden – über den Browser selbst sind sie lesbar.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { APP_DIR } = require('./paths');

const PROFILE_DIR = path.join(APP_DIR, 'yt-login-profile');
const COOKIE_FILE = path.join(APP_DIR, 'yt-cookies.txt');
const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F';

function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome'],
    [path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome'],
    [path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome'],
    [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Edge'],
    [path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Edge'],
  ];
  const hit = candidates.find(([p]) => fs.existsSync(p));
  if (!hit) throw new Error('Weder Chrome noch Edge gefunden');
  return { exe: hit[0], name: hit[1] };
}

const BASE_ARGS = [`--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', '--disable-sync'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Profil-Ordner gesperrt? (Browser mit diesem Profil läuft noch)
function profileInUse() {
  return fs.existsSync(path.join(PROFILE_DIR, 'lockfile'));
}

/**
 * Öffnet ein normales Browserfenster (ohne Automatisierung, damit Google die Anmeldung zulässt)
 * und wartet, bis der Nutzer es schließt. Danach werden die Cookies exportiert.
 */
async function login(onStatus = () => {}) {
  const { exe, name } = findBrowser();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  onStatus({ state: 'browser', message: `${name}-Fenster geöffnet – bei YouTube anmelden und das Fenster danach schließen.` });
  const p = spawn(exe, [...BASE_ARGS, '--new-window', LOGIN_URL], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Zeitüberschreitung – Anmeldefenster war länger als 15 Minuten offen')), 15 * 60000);
    p.on('error', (e) => (clearTimeout(timer), reject(e)));
    p.on('exit', () => (clearTimeout(timer), resolve()));
  });
  // Der Browser schreibt Cookies beim Beenden – kurz warten, bis das Profil frei ist
  for (let i = 0; i < 20 && profileInUse(); i++) await sleep(500);
  onStatus({ state: 'export', message: 'Übernehme Anmeldung …' });
  return exportCookies();
}

/** Liest die Cookies aus dem Anmelde-Profil (unsichtbarer Browser) und schreibt die cookies.txt. */
async function exportCookies() {
  if (!fs.existsSync(PROFILE_DIR)) throw new Error('Noch nicht bei YouTube angemeldet');
  const { exe } = findBrowser();
  const portFile = path.join(PROFILE_DIR, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const p = spawn(exe, [...BASE_ARGS, '--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', 'about:blank'], { stdio: 'ignore' });
  try {
    let port = null;
    for (let i = 0; i < 40 && !port; i++) {
      await sleep(250);
      if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) || null;
    }
    if (!port) throw new Error('Browser für die Anmeldedaten konnte nicht gestartet werden (läuft das Anmeldefenster noch?)');
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const cookies = await cdpCall(webSocketDebuggerUrl, 'Storage.getCookies', {});
    const yt = cookies.filter((c) => /(^|\.)(youtube\.com|google\.com)$/.test(c.domain.replace(/^\./, '')) || /youtube\.com$|google\.com$/.test(c.domain));
    const loggedIn = yt.some((c) => /youtube\.com$/.test(c.domain) && ['LOGIN_INFO', 'SAPISID', '__Secure-3PSID', 'SID'].includes(c.name));
    writeNetscape(yt, COOKIE_FILE);
    return { file: COOKIE_FILE, count: yt.length, loggedIn };
  } finally {
    p.kill();
  }
}

function cdpCall(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => (ws.close(), reject(new Error('Browser antwortet nicht'))), 10000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onerror = () => (clearTimeout(timer), reject(new Error('Verbindung zum Browser fehlgeschlagen')));
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (d.error) reject(new Error(d.error.message));
      else resolve(d.result.cookies || []);
    };
  });
}

// Netscape-Format, wie es yt-dlp mit --cookies erwartet
function writeNetscape(cookies, file) {
  const lines = ['# Netscape HTTP Cookie File', '# Erstellt vom Spotify Downloader – nicht weitergeben', ''];
  for (const c of cookies) {
    const domain = c.domain;
    const sub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = c.session || !c.expires || c.expires < 0 ? 0 : Math.floor(c.expires);
    lines.push([domain, sub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t'));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function status() {
  return { available: (() => { try { return findBrowser().name; } catch { return null; } })(), hasProfile: fs.existsSync(PROFILE_DIR), cookieFile: fs.existsSync(COOKIE_FILE) ? COOKIE_FILE : null };
}

function logout() {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.rmSync(COOKIE_FILE, { force: true });
}

module.exports = { login, exportCookies, status, logout, COOKIE_FILE, PROFILE_DIR };
