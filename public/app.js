const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let list = null; // { name, cover, truncated, tracks: [] }
const jobs = new Map();
let minScore = 1.4;

// ---------- Hilfsfunktionen ----------

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isError ? 6000 : 3000);
}

function fmtDur(sec) {
  if (!sec) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function ytId(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/|^)([A-Za-z0-9_-]{11})(?:[&?#]|$)/);
  return m ? m[1] : null;
}

async function busy(btn, fn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// TXT-Dateien korrekt dekodieren (UTF-8, UTF-16 oder Windows-1252)
function decode(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  let zeros = 0;
  for (let i = 1; i < Math.min(b.length, 400); i += 2) if (b[i] === 0) zeros++;
  if (zeros > 50) return new TextDecoder('utf-16le').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// ---------- Tabs ----------

$$('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
  }),
);

// ---------- Liste ----------

function setList(data, append = false) {
  const tracks = data.tracks.map((t) => ({ ...t, selected: true }));
  if (append && list) list.tracks.push(...tracks);
  else list = { name: data.name, cover: data.cover, truncated: data.truncated, tracks };
  renderList();
  $('#listCard').hidden = false;
  $('#listCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(`${tracks.length} Titel geladen`);
}

function renderList() {
  if (!list) return;
  $('#listName').value = list.name || '';
  $('#listCover').hidden = !list.cover;
  if (list.cover) $('#listCover').src = list.cover;
  const total = list.tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const sel = list.tracks.filter((t) => t.selected).length;
  $('#listInfo').textContent = `${list.tracks.length} Titel · ${sel} ausgewählt${total ? ' · ' + Math.round(total / 60) + ' min' : ''}`;
  $('#truncatedNote').hidden = !list.truncated;
  $('#truncatedNote').textContent = 'Spotify zeigt ohne API-Zugang nur die ersten 100 Titel. Für die komplette Playlist Spotify-Zugangsdaten in den Einstellungen eintragen oder als TXT exportieren und importieren.';
  $('#checkAll').checked = sel === list.tracks.length;

  $('#trackBody').innerHTML = list.tracks
    .map((t, i) => {
      let match;
      if (t.searching) match = '<span class="muted">sucht …</span>';
      else if (t.candidates?.length) {
        const best = t.candidates.find((c) => c.id === t.videoId);
        const unsure = !t.manual && best && best.score < minScore;
        match = (unsure ? `<div class="uncertain">⚠ nicht eindeutig – <button class="small" data-act="suggest" data-i="${i}">Vorschläge</button></div>` : '') + `<select data-i="${i}" class="cand">${t.candidates
          .map((c) => `<option value="${c.id}" ${c.id === t.videoId ? 'selected' : ''}>${c.source === 'ytmusic' ? '♪ ' : ''}${esc(c.title)}${c.channel && c.source !== 'ytmusic' ? ' · ' + esc(c.channel) : ''}${c.duration ? ' · ' + fmtDur(c.duration) : ''}</option>`)
          .join('')}</select>`;
      } else if (t.videoId) match = `<a href="https://www.youtube.com/watch?v=${t.videoId}" target="_blank" rel="noopener">▶ ${esc(t.videoTitle || t.videoId)}</a>`;
      else if (t.candidates) match = `<span class="uncertain">⚠ nichts gefunden – <button class="small" data-act="suggest" data-i="${i}">Vorschläge</button></span>`;
      else match = `<button class="small ghost" data-act="match" data-i="${i}">automatisch · prüfen</button>`;
      return `<tr>
        <td><input type="checkbox" data-i="${i}" class="sel" ${t.selected ? 'checked' : ''}></td>
        <td class="num">${i + 1}</td>
        <td class="title">${esc(t.title)}</td>
        <td>${esc(t.artist)}</td>
        <td class="hide-sm muted">${esc(t.album)}</td>
        <td class="num">${fmtDur(t.duration)}</td>
        <td class="match">${match}</td>
        <td><button class="small ghost" data-act="url" data-i="${i}" title="YouTube-Link manuell festlegen">🔗</button>
            <button class="small ghost" data-act="del" data-i="${i}" title="Entfernen">✕</button></td>
      </tr>`;
    })
    .join('');
}

$('#trackBody').addEventListener('change', (e) => {
  const i = Number(e.target.dataset.i);
  if (e.target.classList.contains('sel')) list.tracks[i].selected = e.target.checked;
  if (e.target.classList.contains('cand')) {
    const t = list.tracks[i];
    t.videoId = e.target.value;
    t.videoTitle = t.candidates.find((c) => c.id === t.videoId)?.title;
    t.manual = true;
  }
  renderList();
});

$('#trackBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const i = Number(btn.dataset.i);
  const t = list.tracks[i];
  if (btn.dataset.act === 'del') {
    list.tracks.splice(i, 1);
    renderList();
  } else if (btn.dataset.act === 'url') {
    const url = prompt(`YouTube-Link für „${t.artist} – ${t.title}“:`, t.videoId ? `https://www.youtube.com/watch?v=${t.videoId}` : '');
    if (url === null) return;
    const id = ytId(url.trim());
    if (!url.trim()) { t.videoId = null; t.candidates = null; }
    else if (!id) return toast('Ungültiger YouTube-Link', true);
    else { t.videoId = id; t.videoTitle = url.trim(); t.candidates = null; }
    renderList();
  } else if (btn.dataset.act === 'match') {
    await matchTracks([t]);
  } else if (btn.dataset.act === 'suggest') {
    openPicker(t, async (choice) => {
      if (choice.track) {
        // Gewählten Spotify-Song übernehmen und neu auf YouTube suchen
        Object.assign(t, choice.track, { videoId: null, videoTitle: null, candidates: null });
        await matchTracks([t]);
        t.manual = true;
      } else {
        Object.assign(t, { videoId: choice.videoId, videoTitle: choice.videoTitle, manual: true });
        if (!t.candidates?.some((c) => c.id === choice.videoId)) t.candidates = null;
      }
      renderList();
    });
  }
});

async function matchTracks(tracks) {
  tracks.forEach((t) => (t.searching = true));
  renderList();
  const queue = [...tracks];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const { candidates } = await api('/api/match', { track: t });
        t.candidates = candidates;
        t.videoId = candidates[0]?.id || null;
        t.manual = false;
        t.videoTitle = candidates[0]?.title;
      } catch (e) {
        toast(e.message, true);
      }
      t.searching = false;
      renderList();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

$('#checkAll').addEventListener('change', (e) => {
  list.tracks.forEach((t) => (t.selected = e.target.checked));
  renderList();
});
$('#listName').addEventListener('input', (e) => (list.name = e.target.value));

$('#btnMatchAll').addEventListener('click', (e) =>
  busy(e.currentTarget, () => matchTracks(list.tracks.filter((t) => t.selected && !t.videoId))),
);

$('#btnDownload').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    const tracks = list.tracks
      .map((t, i) => ({ ...t, trackNo: i + 1 }))
      .filter((t) => t.selected)
      .map(({ title, artist, album, genre, duration, videoId, videoTitle, trackNo, candidates, manual }) => {
        // Unsichere, nicht bestätigte Treffer nicht blind übernehmen – der Server fragt dann nach
        const best = candidates?.find((c) => c.id === videoId);
        if (best && !manual && best.score < minScore) videoId = undefined;
        return { title, artist, album, genre, duration, videoId, videoTitle, trackNo };
      });
    if (!tracks.length) throw new Error('Keine Titel ausgewählt');
    await api('/api/download', { listName: list.name, tracks });
    toast(`${tracks.length} Titel zur Warteschlange hinzugefügt`);
    $('.downloads').scrollIntoView({ behavior: 'smooth' });
  }),
);

// ---------- Quellen ----------

async function importFiles(files) {
  for (const f of files) {
    try {
      const text = decode(await f.arrayBuffer());
      const data = await api('/api/import', { text, name: f.name.replace(/\.[^.]+$/, '') });
      setList(data, files.length > 1 && f !== files[0]);
      if (files.length > 1) list.name = 'Import';
    } catch (e) {
      toast(`${f.name}: ${e.message}`, true);
    }
  }
  renderList();
}

$('#fileInput').addEventListener('change', (e) => {
  importFiles([...e.target.files]);
  e.target.value = '';
});
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === dz) dz.classList.remove('over'); }));
document.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) importFiles(files);
});

$('#btnPaste').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => setList(await api('/api/import', { text: $('#pasteText').value, name: 'Import' }))),
);

$('#formSpotify').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => setList(await api('/api/spotify', { url: $('#spotifyUrl').value })));
});

$('#formYt').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => setList(await api('/api/youtube-playlist', { url: $('#ytUrl').value })));
});

$('#formSingle').addEventListener('submit', (e) => {
  e.preventDefault();
  const tracks = $('#singleText').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const id = ytId(l);
    if (id && /youtu/.test(l)) return { title: l, artist: '', album: '', videoId: id, videoTitle: l };
    const m = l.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    return m ? { artist: m[1], title: m[2], album: '' } : { artist: '', title: l, album: '' };
  });
  if (!tracks.length) return;
  setList({ name: list?.name || 'Einzelne Songs', tracks }, !!list);
  $('#singleText').value = '';
});

$('#formSearch').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    $('#searchResults').innerHTML = '<p class="muted">Suche läuft …</p>';
    const r = await api('/api/playlists', { q: $('#searchQuery').value });
    const card = (p) => `<button class="result" data-src="${p.source}" data-url="${esc(p.url)}">
        ${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy">` : '<img alt="">'}
        <span><span class="t">${esc(p.title)}</span><span class="o">${esc(p.owner)}${p.count ? ' · ' + p.count + ' Titel' : ''}</span></span>
      </button>`;
    let html = '';
    if (r.spotify.available) {
      html += `<div class="result-group"><h3>Spotify</h3>${r.spotify.error ? `<p class="hint">${esc(r.spotify.error)}</p>` : ''}<div class="results">${r.spotify.results.map(card).join('') || '<span class="muted">Keine Treffer</span>'}</div></div>`;
    } else {
      html += '<p class="hint">Spotify-Playlistsuche: in den Einstellungen Spotify-API-Zugangsdaten hinterlegen. Spotify-Links können jederzeit im Tab „Spotify-Link“ geladen werden.</p>';
    }
    html += `<div class="result-group"><h3>YouTube</h3>${r.youtubeError ? `<p class="hint">${esc(r.youtubeError)}</p>` : ''}<div class="results">${r.youtube.map(card).join('') || '<span class="muted">Keine Treffer</span>'}</div></div>`;
    $('#searchResults').innerHTML = html;
  });
});

$('#searchResults').addEventListener('click', (e) => {
  const b = e.target.closest('.result');
  if (!b) return;
  const endpoint = b.dataset.src === 'spotify' ? '/api/spotify' : '/api/youtube-playlist';
  toast('Playlist wird geladen …');
  busy(null, async () => setList(await api(endpoint, { url: b.dataset.url })));
});

// ---------- Downloads ----------

const STATUS = {
  queued: 'Wartet', searching: 'Sucht auf YouTube …', downloading: 'Lädt', converting: 'Konvertiert …',
  review: 'Auswahl nötig', done: 'Fertig', exists: 'Bereits vorhanden', error: 'Fehler', cancelled: 'Abgebrochen',
};
const ACTIVE = ['queued', 'searching', 'downloading', 'converting'];

function renderJobs() {
  const all = [...jobs.values()].sort((a, b) => a.id - b.id);
  const ul = $('#jobList');
  if (!all.length) {
    ul.innerHTML = '<li class="empty">Noch keine Downloads.</li>';
    $('#jobSummary').textContent = '';
    $('#overall div').style.width = '0';
    return;
  }
  const count = (s) => all.filter((j) => s.includes(j.status)).length;
  const finished = count(['done', 'exists']);
  $('#jobSummary').textContent = `· ${finished}/${all.length} fertig${count(['error']) ? ` · ${count(['error'])} Fehler` : ''}${count(ACTIVE) ? ` · ${count(ACTIVE)} offen` : ''}${count(['review']) ? ` · ${count(['review'])} Auswahl nötig` : ''}`;
  const pct = all.reduce((a, j) => a + (['done', 'exists', 'error', 'cancelled'].includes(j.status) ? 100 : j.progress || 0), 0) / all.length;
  $('#overall div').style.width = pct + '%';

  ul.innerHTML = all
    .map((j) => {
      const t = j.track;
      const sub = j.status === 'review'
        ? 'Nicht eindeutig gefunden – bitte richtigen Song auswählen'
        : j.status === 'error'
        ? esc(j.error)
        : j.match ? `▶ <a href="${esc(j.match.url)}" target="_blank" rel="noopener">${esc(j.match.title)}</a>${j.match.channel ? ' · ' + esc(j.match.channel) : ''}` : esc(j.listName);
      const pct = j.status === 'downloading' ? ` ${Math.round(j.progress || 0)} %` : '';
      const indet = ['searching', 'converting'].includes(j.status);
      let actions = `<span class="status ${j.status}">${STATUS[j.status] || j.status}${pct}</span>`;
      if (ACTIVE.includes(j.status)) actions += `<button class="small ghost" data-job="${j.id}" data-act="cancel" title="Abbrechen">✕</button>`;
      if (['error', 'cancelled'].includes(j.status)) {
        actions += `<button class="small ghost" data-job="${j.id}" data-act="retry" title="Erneut versuchen">↻</button>`;
        actions += `<button class="small primary" data-job="${j.id}" data-act="pick" title="Anderen Treffer, Spotify-Song oder YouTube-Link wählen">Andere Quelle</button>`;
      }
      if (j.status === 'review') actions += `<button class="small primary" data-job="${j.id}" data-act="pick">Auswählen</button>`;
      if (j.file) actions += `<button class="small ghost" data-job="${j.id}" data-act="show" title="Im Explorer zeigen">📂</button>`;
      return `<li>
        <div class="job-title">${esc(t.artist ? `${t.artist} – ${t.title}` : t.title)}</div>
        <div class="job-actions">${actions}</div>
        <div class="job-sub">${sub}</div>
        ${ACTIVE.includes(j.status) ? `<div class="progress ${indet ? 'indet' : ''}"><div style="width:${indet ? '' : (j.progress || 0) + '%'}"></div></div>` : ''}
      </li>`;
    })
    .join('');
}

$('#jobList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-job]');
  if (!b) return;
  const id = Number(b.dataset.job);
  const j = jobs.get(id);
  if (b.dataset.act === 'cancel') api('/api/cancel', { id });
  if (b.dataset.act === 'retry') api('/api/retry', { id });
  if (b.dataset.act === 'show') api('/api/open', { path: j.file });
  if (b.dataset.act === 'pick') {
    openPicker(j.track, (choice) => api('/api/resolve', { id, ...choice }).catch((e) => toast(e.message, true)), j.candidates, j.failedIds);
  }
});

$('#btnCancelAll').addEventListener('click', () => api('/api/cancel', {}));
$('#btnRetryAll').addEventListener('click', () => api('/api/retry', {}));
$('#btnClear').addEventListener('click', () => api('/api/clear', {}));
$('#btnOpenFolder').addEventListener('click', () => api('/api/open', {}).catch((e) => toast(e.message, true)));

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderJobs();
  });
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('jobs', (e) => {
    jobs.clear();
    JSON.parse(e.data).forEach((j) => jobs.set(j.id, j));
    scheduleRender();
  });
  es.addEventListener('job', (e) => {
    const j = JSON.parse(e.data);
    jobs.set(j.id, j);
    scheduleRender();
  });
  es.addEventListener('tools', (e) => setToolStatus(JSON.parse(e.data)));
  es.addEventListener('update', (e) => renderUpdate(JSON.parse(e.data)));
  es.onopen = () => {
    // Nach einem Update läuft eine neue Version → Seite neu laden, damit die neue Oberfläche erscheint
    api('/api/status')
      .then((s) => {
        if (window.appVersion && s.version !== window.appVersion) location.reload();
        window.appVersion = s.version;
      })
      .catch(() => {});
  };
  es.onerror = () => {
    $('#toolStatus').textContent = 'Programm läuft nicht – bitte neu starten';
    $('#toolStatus').className = 'pill err';
  };
}

function setToolStatus(s) {
  const el = $('#toolStatus');
  el.textContent = s.ready ? 'Bereit' : s.message;
  el.className = 'pill ' + (s.ready ? 'ok' : /Fehler/.test(s.message) ? 'err' : 'busy');
}

// ---------- Einstellungen ----------

const dlg = $('#settings');
$('#btnSettings').addEventListener('click', async () => {
  const { config, version, update } = await api('/api/status');
  $('#settingsVersion').textContent = 'v' + version;
  $('#updateCheckResult').textContent = update?.available ? `v${update.latest} verfügbar` : '';
  const f = $('#formSettings');
  for (const [k, v] of Object.entries(config)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  dlg.showModal();
});
dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'save') return;
  const f = $('#formSettings');
  const body = {};
  for (const el of f.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  try {
    await api('/api/config', body);
    $('#outputDir').textContent = (await api('/api/status')).config.outputDir;
    toast('Einstellungen gespeichert');
  } catch (e) {
    toast(e.message, true);
  }
});

api('/api/status')
  .then((s) => {
    setToolStatus(s.tools);
    window.appVersion = s.version;
    $('#version').textContent = 'v' + s.version;
    renderUpdate(s.update);
    minScore = s.minScore ?? minScore;
    $('#outputDir').textContent = s.config.outputDir;
  })
  .catch(() => {});
connect();

// ---------- Download-Ordner ----------

$('#btnBrowse').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    const { path } = await api('/api/pick-folder', {});
    if (path) $('#formSettings').elements.outputDir.value = path;
  }),
);

$('#btnPickFolder').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    const { path } = await api('/api/pick-folder', {});
    if (!path) return;
    await api('/api/config', { outputDir: path });
    $('#outputDir').textContent = path;
    toast('Download-Ordner geändert');
  }),
);

// ---------- Auswahl-Dialog (Spotify-/YouTube-Vorschläge) ----------

const picker = $('#picker');
let pickerTrack = null;
let pickerDone = null;

let pickerFailed = new Set();

function openPicker(track, onChoose, initialCandidates, failedIds) {
  pickerTrack = track;
  pickerDone = onChoose;
  pickerFailed = new Set(failedIds || []);
  $('#pickerWanted').textContent =
    'Gesucht: ' + (track.artist ? `${track.artist} – ${track.title}` : track.title) + (track.duration ? ` (${fmtDur(track.duration)})` : '');
  $('#pickerQuery').value = [track.artist, track.title].filter(Boolean).join(' ');
  picker.showModal();
  loadSuggestions('', initialCandidates);
}

async function loadSuggestions(q, initialCandidates) {
  const box = $('#pickerResults');
  box.innerHTML = '<p class="muted">Suche Vorschläge …</p>';
  try {
    const r = await api('/api/suggest', { track: pickerTrack, q });
    // Fehlgeschlagene Quellen ans Ende sortieren und markieren
    const yt = (r.youtube.length ? r.youtube : initialCandidates || [])
      .map((c) => ({ ...c, failed: pickerFailed.has(c.id) }))
      .sort((a, b) => a.failed - b.failed);
    let html = '<div class="result-group"><h3>Spotify</h3>';
    if (!r.spotify.available) {
      html += '<p class="hint">Für Spotify-Vorschläge in den Einstellungen Spotify-API-Zugangsdaten hinterlegen. Unten stehen die YouTube-Vorschläge.</p>';
    } else if (r.spotify.error) {
      html += `<p class="hint">${esc(r.spotify.error)}</p>`;
    } else {
      html += `<div class="song-list">${
        r.spotify.results
          .map(
            (t, i) => `
        <button class="song" data-sp="${i}">
          ${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy">` : '<span class="ph">♪</span>'}
          <span><span class="t">${esc(t.title)}</span><br><span class="o">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</span></span>
          <span class="d">${fmtDur(t.duration)}</span>
        </button>`,
          )
          .join('') || '<span class="muted">Keine Treffer</span>'
      }</div>`;
    }
    html += '</div><div class="result-group"><h3>YouTube</h3><div class="song-list">';
    html +=
      yt
        .map(
          (c, i) => `
        <button class="song" data-yt="${i}">
          <img src="https://i.ytimg.com/vi/${c.id}/default.jpg" alt="" loading="lazy">
          <span><span class="t">${esc(c.title)}</span><br><span class="o">${c.failed ? '<span class="uncertain">⚠ fehlgeschlagen</span> · ' : ''}${c.source === 'ytmusic' ? '♪ YouTube Music' : esc(c.channel)}
            · <a href="${esc(c.url)}" target="_blank" rel="noopener">ansehen</a></span></span>
          <span class="d">${fmtDur(c.duration)}<br><span class="score ${c.score < minScore ? 'low' : ''}">${Math.round(Math.min(1, c.score / 2) * 100)} %</span></span>
        </button>`,
        )
        .join('') || '<span class="muted">Keine Treffer</span>';
    html += '</div></div>';
    box.innerHTML = html;
    box.onclick = (e) => {
      if (e.target.closest('a')) return;
      const b = e.target.closest('.song');
      if (!b) return;
      let choice;
      if (b.dataset.sp !== undefined) {
        const t = r.spotify.results[Number(b.dataset.sp)];
        choice = { track: { title: t.title, artist: t.artist, album: t.album, duration: t.duration } };
      } else {
        const c = yt[Number(b.dataset.yt)];
        choice = { videoId: c.id, videoTitle: c.title };
      }
      picker.close();
      pickerDone?.(choice);
    };
  } catch (e) {
    box.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
}

$('#pickerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#pickerQuery').value.trim();
  // Eingefügter YouTube-Link wird direkt als Quelle übernommen
  const id = /youtu/.test(q) ? ytId(q) : null;
  if (id) {
    picker.close();
    pickerDone?.({ videoId: id, videoTitle: q });
    return;
  }
  loadSuggestions(q);
});
$('#pickerClose').addEventListener('click', () => picker.close());

// ---------- Beenden ----------

function showQuit() {
  document.body.innerHTML = '<main><section class="card" style="text-align:center;padding:40px"><h2>Programm beendet</h2><p class="muted">Du kannst diesen Tab jetzt schließen.</p></section></main>';
}

$('#btnQuit').addEventListener('click', async () => {
  const active = [...jobs.values()].filter((j) => ACTIVE.includes(j.status)).length;
  if (active && !confirm(`${active} Downloads laufen noch. Trotzdem beenden?`)) return;
  await api('/api/quit', {}).catch(() => {});
  showQuit();
});

// ---------- Selbst-Update ----------

let updateDismissed = null;
let updating = false;

function renderUpdate(u) {
  if (!u) return;
  const bar = $('#updateBar');
  if (u.error && updating) {
    updating = false;
    toast(u.error, true);
  }
  if (!u.available || updateDismissed === u.latest) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $('#updateNotes').href = u.url;
  const btn = $('#btnUpdate');
  if (u.progress != null || updating) {
    $('#updateText').textContent = u.progress >= 100 || u.progress == null
      ? 'Update wird installiert – das Programm startet gleich neu …'
      : `Update v${u.latest} wird geladen … ${u.progress} %`;
    btn.disabled = true;
  } else {
    $('#updateText').textContent = `Neue Version v${u.latest} verfügbar (installiert: v${u.current}).`;
    btn.disabled = !u.packaged;
    btn.title = u.packaged ? '' : 'Nur in der installierten Version möglich';
  }
}

$('#btnUpdate').addEventListener('click', async () => {
  const active = [...jobs.values()].filter((j) => ACTIVE.includes(j.status)).length;
  if (active && !confirm(`${active} Downloads laufen noch und werden abgebrochen. Trotzdem aktualisieren?`)) return;
  updating = true;
  renderUpdate({ available: true, progress: 0, latest: '' });
  try {
    await api('/api/update/install', {});
  } catch (e) {
    updating = false;
    toast(e.message, true);
  }
});

$('#btnUpdateLater').addEventListener('click', () => {
  updateDismissed = $('#updateText').textContent.match(/v([\d.]+)/)?.[1] || true;
  $('#updateBar').hidden = true;
});

$('#btnCheckUpdate').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    const res = $('#updateCheckResult');
    res.textContent = 'prüfe …';
    const u = await api('/api/update/check', {});
    if (u.error) res.textContent = 'Prüfung fehlgeschlagen: ' + u.error;
    else if (u.available) {
      updateDismissed = null;
      renderUpdate(u);
      res.textContent = `v${u.latest} verfügbar – siehe Leiste oben`;
    } else res.textContent = 'Du hast die neueste Version.';
  }),
);
