// app.js — Mute Video and Remove Audio. Everything runs on this device: the video is handed to worker.js,
// which runs the vendored ffmpeg wasm core and copies the video stream into a new file without the audio.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'];
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska' };
const WARN_BYTES = 500 * 1024 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const results = $('results');
const source = $('source');
const srcVideo = $('source-video');
const muteBtn = $('mute-btn');
const progressWrap = $('progress-wrap');
const progressBar = $('progress');
const progressLabel = $('progress-label');
const progressPct = $('progress-pct');

const state = { file: null, ext: '', info: null, busy: false, srcUrl: null, outUrl: null, token: 0 };

/* ---------- Worker plumbing ---------- */
let worker = null;
let engineReady = false;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('./worker.js');
  worker.onmessage = ({ data }) => {
    if (data.type === 'stage') {
      if (data.stage === 'loading') setProgress('Loading the video engine (about 32 MB, first time only)…', null);
      if (data.stage === 'ready') engineReady = true;
      return;
    }
    if (data.type === 'progress') { onProgress?.(data); return; }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.ok) p.resolve(data);
    else {
      const err = new Error(data.error);
      err.kind = data.kind;
      if (data.kind === 'oom' || data.kind === 'crash') resetWorker();
      p.reject(err);
    }
  };
  worker.onerror = (e) => {
    e.preventDefault();
    const err = new Error(e.message || 'The video engine stopped unexpectedly.');
    err.kind = /memory/i.test(err.message) ? 'oom' : 'crash';
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    resetWorker();
  };
  return worker;
}

function resetWorker() {
  if (worker) worker.terminate();
  worker = null;
  engineReady = false;
}

let onProgress = null;
function call(msg) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...msg });
  });
}

/* ---------- UI helpers ---------- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function showAlert(kind, message) {
  const a = el('div', `alert alert--${kind}`, message);
  a.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  results.prepend(a);
  return a;
}

// pct: null = indeterminate. Never shows 100% before the file is actually done.
function setProgress(label, pct) {
  progressWrap.hidden = false;
  progressLabel.textContent = label;
  const bar = progressBar.firstElementChild;
  if (pct == null) {
    progressBar.classList.add('progress--busy');
    progressBar.removeAttribute('aria-valuenow');
    progressPct.textContent = '';
    bar.style.width = '';
  } else {
    progressBar.classList.remove('progress--busy');
    const shown = Math.floor(pct * 10) / 10;
    progressBar.setAttribute('aria-valuenow', String(shown));
    progressPct.textContent = `${shown.toFixed(shown >= 100 ? 0 : 1)}%`;
    bar.style.width = `${shown}%`;
  }
}

function hideProgress() { progressWrap.hidden = true; }

export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return 'Unknown';
  const s = Math.round(sec * 10) / 10;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function mutedName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-muted${name.slice(dot)}` : `${name}-muted`;
}

function extOf(name) {
  const m = /\.([^.]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function errorText(err) {
  if (err.kind === 'oom') {
    return 'The browser ran out of memory while processing this video. Close other tabs and try again, or use a desktop browser; phones (especially Safari on iPhone) have much less memory for large files.';
  }
  if (err.kind === 'convert') return `ffmpeg could not copy the video into a new file: ${err.message}`;
  return `Something went wrong in the video engine: ${err.message}`;
}

function clearResultCard() {
  results.querySelectorAll('.mv-result').forEach((n) => n.remove());
  if (state.outUrl) URL.revokeObjectURL(state.outUrl);
  state.outUrl = null;
}

/* ---------- Loading a file ---------- */
function handleFiles(files) {
  if (state.busy) { toast('Please wait for the current video to finish.'); return; }
  const videos = files.filter((f) => EXTS.includes(extOf(f.name)));
  const rejected = files.filter((f) => !videos.includes(f));
  results.replaceChildren();
  if (rejected.length) {
    const names = rejected.map((f) => f.name).join(', ');
    const looksVideo = rejected.some((f) => f.type.startsWith('video/'));
    showAlert('error', `${names}: ${rejected.length > 1 ? 'these are' : 'this is'} not a supported video. ` +
      (looksVideo ? 'This container is not supported; ' : '') + 'Choose an MP4, MOV, M4V, WebM or MKV file.');
  }
  if (!videos.length) return;
  if (videos.length > 1) showAlert('info', `One video at a time: using ${videos[0].name}.`);
  loadFile(videos[0]);
}

async function loadFile(file) {
  const token = ++state.token;
  clearResultCard();
  state.file = file;
  state.ext = extOf(file.name);
  state.info = null;
  if (state.srcUrl) URL.revokeObjectURL(state.srcUrl);

  if (file.size > MAX_BYTES) {
    source.hidden = true;
    showAlert('error', `${file.name} is ${formatBytes(file.size)}. Browsers can only hold about 2 GB in memory, so this file is too large to process here.`);
    return;
  }

  source.hidden = false;
  $('info-name').textContent = file.name;
  $('info-name').title = file.name;
  $('info-size').textContent = formatBytes(file.size);
  for (const id of ['info-duration', 'info-resolution', 'info-audio']) $(id).textContent = 'Checking…';
  $('info-audio').className = '';
  $('info-extra').textContent = '';
  muteBtn.disabled = true;

  $('source-fallback').hidden = true;
  srcVideo.hidden = false;
  state.srcUrl = URL.createObjectURL(file);
  srcVideo.src = state.srcUrl;

  if (file.size > WARN_BYTES) {
    showAlert('warn', `This video is ${formatBytes(file.size)}. Files above 500 MB need a lot of memory and the single-threaded engine is slower on them; it may take a while or fail on phones.`);
  }

  if (!engineReady) setProgress('Loading the video engine (about 32 MB, first time only)…', null);
  else setProgress('Reading the video…', null);
  try {
    const { info } = await call({ type: 'probe', file, ext: state.ext });
    if (token !== state.token) return;
    hideProgress();
    applyInfo(info);
  } catch (err) {
    if (token !== state.token) return;
    hideProgress();
    showAlert('error', errorText(err));
  }
}

function applyInfo(info) {
  const main = info.video.find((v) => !v.cover) || info.video[0];
  if (!info.ok || !main) {
    source.hidden = true;
    showAlert('error', info.ok
      ? `${state.file.name} has no video stream, so there is nothing to keep. Choose a video file.`
      : `${state.file.name} is not a video this tool can read: the container is unsupported or the file is damaged. Choose an MP4, MOV, M4V, WebM or MKV file.`);
    return;
  }
  state.info = info;
  const duration = info.duration ?? (Number.isFinite(srcVideo.duration) ? srcVideo.duration : null);
  $('info-duration').textContent = formatDuration(duration);
  $('info-resolution').textContent = main.width ? `${main.width} × ${main.height} (${main.codec.toUpperCase()})` : main.codec.toUpperCase();
  const audio = $('info-audio');
  audio.textContent = info.audio ? `Yes, ${info.audio} track${info.audio > 1 ? 's' : ''}` : 'No audio track';
  audio.className = info.audio ? 'stat stat--warn' : 'stat stat--ok';

  const extra = [];
  if (info.subtitle) extra.push(`${info.subtitle} subtitle track${info.subtitle > 1 ? 's are' : ' is'} kept when the container allows it.`);
  if (info.data) extra.push('Data tracks (such as timecode) are dropped.');
  if (info.rotation) extra.push('Rotation metadata is preserved.');
  extra.push('Uses the single-threaded engine, so large files may be slower.');
  $('info-extra').textContent = extra.join(' ');

  if (!info.audio) {
    showAlert('info', 'This video has no audio track, so it is already silent. You can still save a fresh copy, but there is no sound to remove.');
  }
  muteBtn.disabled = false;
}

srcVideo.addEventListener('error', () => {
  if (!srcVideo.getAttribute('src')) return;
  srcVideo.hidden = true;
  $('source-fallback').hidden = false;
});
srcVideo.addEventListener('loadedmetadata', () => {
  if (state.info && state.info.duration == null) $('info-duration').textContent = formatDuration(srcVideo.duration);
});

/* ---------- Removing the audio ---------- */
async function removeAudio() {
  if (!state.file || !state.info || state.busy) return;
  state.busy = true;
  muteBtn.disabled = true;
  const { file, ext, info } = state;
  const token = state.token;
  clearResultCard();
  results.querySelectorAll('.alert--error').forEach((n) => n.remove());
  srcVideo.pause();
  setProgress(engineReady ? 'Removing audio…' : 'Loading the video engine (about 32 MB, first time only)…', engineReady ? 0 : null);
  onProgress = ({ progress }) => {
    if (Number.isFinite(progress) && progress >= 0) setProgress('Removing audio…', Math.min(99.9, progress * 100));
  };
  const started = performance.now();
  try {
    const res = await call({ type: 'mute', file, ext, withSubs: info.subtitle > 0 });
    if (token !== state.token) return;
    const blob = new Blob([res.data], { type: MIME[ext] || 'video/mp4' });
    hideProgress();
    showResult(blob, res, (performance.now() - started) / 1000);
  } catch (err) {
    hideProgress();
    showAlert('error', errorText(err));
  } finally {
    onProgress = null;
    state.busy = false;
    muteBtn.disabled = !state.info;
  }
}

function showResult(blob, res, seconds) {
  const name = mutedName(state.file.name);
  state.outUrl = URL.createObjectURL(blob);
  const ratio = blob.size / state.file.size;
  const audioLeft = res.outInfo && res.outInfo.ok ? res.outInfo.audio : null;

  const card = el('div', 'result mv-result');
  card.dataset.originalBytes = String(state.file.size);
  card.dataset.outputBytes = String(blob.size);

  const preview = el('div', 'preview mv-preview');
  const video = el('video');
  video.id = 'result-video';
  video.controls = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('aria-label', `Preview of ${name}`);
  video.src = state.outUrl;
  const fallback = el('p', 'mv-preview__fallback', 'This browser cannot preview this format, but the file is ready to download.');
  fallback.hidden = true;
  video.addEventListener('error', () => { video.hidden = true; fallback.hidden = false; });
  preview.append(video, fallback);

  const meta = el('div', 'mv-info');
  meta.append(el('p', 'mv-info__name', name));
  const facts = el('dl', 'mv-facts');
  const fact = (label, value, id, cls) => {
    const row = el('div');
    const dd = el('dd', cls, value);
    if (id) dd.id = id;
    row.append(el('dt', null, label), dd);
    facts.append(row);
  };
  fact('Original', formatBytes(state.file.size), 'result-original-size');
  fact('Output', formatBytes(blob.size), 'result-output-size');
  fact('Size kept', `${(Math.floor(ratio * 1000) / 10).toFixed(1)}% (video copied, not re-encoded)`, 'result-ratio');
  fact('Audio', audioLeft === 0 ? 'No audio track (verified)' : audioLeft == null ? 'Removed' : `${audioLeft} track(s) left`, 'result-audio', audioLeft === 0 ? 'stat stat--ok' : 'stat stat--warn');
  meta.append(facts);

  const notes = [seconds < 0.1 ? 'Done in under 0.1 s.' : `Done in ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s.`];
  if (state.info.subtitle) notes.push(res.keptSubs ? 'Subtitle tracks were kept.' : 'Subtitle tracks could not be copied into this container and were dropped.');
  meta.append(el('p', 'field__hint', notes.join(' ')));

  const dl = el('button', 'btn btn--primary', `Download ${name}`);
  dl.id = 'download';
  dl.type = 'button';
  dl.addEventListener('click', () => { downloadBlob(blob, name); toast(`Saved ${name}`); });
  const actions = el('div', 'mv-actions');
  actions.append(dl);
  meta.append(actions);

  const grid = el('div', 'mv-grid');
  grid.append(preview, meta);
  card.append(grid);
  results.append(card);
  card.scrollIntoView({ block: 'nearest' });
  toast('Audio removed. Nothing was uploaded.');
}

/* ---------- Wiring ---------- */
wireDropzone(zone, input, handleFiles);
muteBtn.addEventListener('click', removeAudio);

// Enter starts, Space plays the preview: only when focus is not on something that handles those keys itself.
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  if (t.closest && t.closest('button, a, input, select, textarea, summary, video, [role="button"], [contenteditable]')) return;
  if (source.hidden) return;
  if (e.key === 'Enter' && !muteBtn.disabled) { e.preventDefault(); removeAudio(); }
  else if (e.key === ' ') {
    const v = $('result-video') || srcVideo;
    if (v.hidden) return;
    e.preventDefault();
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }
});

// Called by the factory's screenshot script: loads the bundled six-second Sample Video and shows a finished result.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/sample-video.webm');
  const file = new File([await res.blob()], 'sample-video.webm', { type: 'video/webm' });
  handleFiles([file]);
  while (!state.info && !results.querySelector('.alert--error')) await new Promise((r) => setTimeout(r, 100));
  await removeAudio();
};

export { handleFiles, removeAudio };
