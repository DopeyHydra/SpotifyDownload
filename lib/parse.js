// Parser für TXT-Exporte im Format:
// #  Bild  Trackname  Interpret  Album  Genre  BPM  Wertung  Dauer  Tonart  Datum Hinzufügung

const COLUMN_ALIASES = {
  title: ['trackname', 'titel', 'track', 'title', 'song', 'name'],
  artist: ['interpret', 'künstler', 'kuenstler', 'artist', 'artists', 'artist name(s)'],
  album: ['album', 'album name'],
  genre: ['genre'],
  bpm: ['bpm', 'tempo'],
  duration: ['dauer', 'duration', 'länge', 'laenge', 'length'],
  key: ['tonart', 'key'],
  added: ['datum hinzufügung', 'datum hinzugefügt', 'hinzugefügt', 'added', 'date added'],
};

const RE_DURATION = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}/;
const RE_NUMBER = /^\d+([.,]\d+)?$/;

function durationToSec(s) {
  if (!s || !RE_DURATION.test(s.trim())) return null;
  return s.trim().split(':').reduce((acc, v) => acc * 60 + Number(v), 0);
}

function norm(s) {
  return (s || '').trim().toLowerCase();
}

function mapHeader(cells) {
  const map = {};
  cells.forEach((c, i) => {
    const n = norm(c);
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (map[key] === undefined && aliases.includes(n)) map[key] = i;
    }
  });
  return map.title !== undefined ? map : null;
}

// Standard-Spaltenpositionen, falls keine Kopfzeile vorhanden ist.
const DEFAULT_MAP = { title: 2, artist: 3, album: 4, genre: 5, bpm: 6, duration: 8, key: 9, added: 10 };

function fromCells(cells, map) {
  const get = (k) => (map[k] !== undefined ? (cells[map[k]] || '').trim() : '');
  return {
    title: get('title'),
    artist: get('artist'),
    album: get('album'),
    genre: get('genre'),
    bpm: get('bpm'),
    duration: durationToSec(get('duration')),
    added: get('added'),
  };
}

// Fallback für Zeilen ohne Tabs (z. B. aus einer Webseite kopiert, Spalten durch Leerzeichen getrennt).
function fromSpaces(line) {
  const parts = line.trim().split(/\s{2,}/);
  if (RE_NUMBER.test(parts[0]) && !parts[0].includes(',')) parts.shift(); // laufende Nummer
  const text = [];
  let duration = null;
  let bpm = '';
  let added = '';
  for (const p of parts) {
    if (RE_DURATION.test(p)) duration = durationToSec(p);
    else if (RE_DATE.test(p)) added = p;
    else if (RE_NUMBER.test(p)) bpm = bpm || p;
    else text.push(p);
  }
  return { title: text[0] || '', artist: text[1] || '', album: text[2] || '', genre: text[3] || '', bpm, duration, added };
}

function parseTxt(content) {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const tracks = [];
  let map = null;
  let sep = lines.some((l) => l.includes('\t')) ? '\t' : null;
  if (!sep && lines.some((l) => l.includes(';') && l.split(';').length >= 5)) sep = ';';

  for (const line of lines) {
    if (sep) {
      const cells = line.split(sep).map((c) => c.replace(/^"|"$/g, ''));
      const header = mapHeader(cells);
      if (header) {
        map = header;
        continue;
      }
      const t = fromCells(cells, map || DEFAULT_MAP);
      if (t.title) tracks.push(t);
    } else {
      if (/trackname|interpret/i.test(line) && !/\d{1,2}:\d{2}/.test(line)) continue; // Kopfzeile
      const t = fromSpaces(line);
      if (t.title) tracks.push(t);
    }
  }
  return tracks;
}

module.exports = { parseTxt, durationToSec };
