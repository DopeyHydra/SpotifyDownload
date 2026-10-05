// Pfade für Entwicklungsmodus (node server.js) und gepackte Version (SpotifyDownloader.exe)
const path = require('path');
const os = require('os');
const fs = require('fs');

let sea = null;
try {
  sea = require('node:sea');
  if (!sea.isSea()) sea = null;
} catch {
  sea = null;
}

const IS_PACKAGED = !!sea;
// Gepackt: Ordner der exe (Installation pro Benutzer → beschreibbar). Sonst: Projektordner.
const APP_DIR = IS_PACKAGED ? path.dirname(process.execPath) : path.join(__dirname, '..');

function defaultDownloadDir() {
  if (!IS_PACKAGED) return path.join(APP_DIR, 'downloads');
  const music = path.join(os.homedir(), 'Music');
  return path.join(fs.existsSync(music) ? music : os.homedir(), 'Spotify Downloader');
}

// Statische Dateien der Oberfläche: gepackt aus den eingebetteten Assets, sonst aus public/
function readPublic(name) {
  if (IS_PACKAGED) {
    try {
      return Buffer.from(sea.getAsset(`public/${name}`));
    } catch {
      return null;
    }
  }
  const root = path.join(APP_DIR, 'public');
  const file = path.join(root, path.normalize(name));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return fs.readFileSync(file);
}

// Version: beim Build per esbuild eingesetzt, im Entwicklungsmodus aus package.json
const VERSION = process.env.APP_VERSION || require('../package.json').version;

module.exports = { IS_PACKAGED, VERSION, APP_DIR, BIN_DIR: path.join(APP_DIR, 'bin'), defaultDownloadDir, readPublic };
