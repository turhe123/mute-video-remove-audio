// worker.js — runs the vendored single-threaded ffmpeg wasm core off the main thread.
// The input File is mounted read-only with WORKERFS (no copy into wasm memory); only the output lives in memory.
// Messages in:  { id, type: 'probe' | 'mute', file, ext, withSubs }
// Messages out: { type: 'stage' | 'progress' } events, then { id, ok: true, ... } or { id, ok: false, error, kind }
/* global createFFmpegCore */
'use strict';

const CORE_URL = new URL('vendor/ffmpeg/ffmpeg-core.js', self.location.href).href;
const WASM_URL = new URL('vendor/ffmpeg/ffmpeg-core.wasm', self.location.href).href;

let core = null;
let logLines = [];

async function ensureCore() {
  if (core) return;
  self.postMessage({ type: 'stage', stage: 'loading' });
  importScripts(CORE_URL);
  core = await createFFmpegCore({
    mainScriptUrlOrBlob: `${CORE_URL}#${btoa(JSON.stringify({ wasmURL: WASM_URL, workerURL: '' }))}`,
  });
  core.setLogger(({ message }) => { logLines.push(message); });
  core.setProgress(({ progress, time }) => self.postMessage({ type: 'progress', progress, time }));
  core.FS.mkdir('/in');
  core.FS.mkdir('/out');
  self.postMessage({ type: 'stage', stage: 'ready' });
}

function exec(args) {
  logLines = [];
  core.exec('-hide_banner', ...args);
  const ret = core.ret;
  core.reset();
  return { ret, log: logLines.slice() };
}

function withMountedInput(file, ext, fn) {
  const name = `input.${ext}`;
  // Re-wrapping the File gives it a plain ASCII name inside the virtual FS (no data is copied).
  core.FS.mount(core.FS.filesystems.WORKERFS, { files: [new File([file], name)] }, '/in');
  try { return fn(`/in/${name}`); } finally { core.FS.unmount('/in'); }
}

// Turn `ffmpeg -i` output into a small description of the container and its streams.
function parseInfo(log) {
  const text = log.join('\n');
  const input = /Input #0, ([^,\n]+(?:,[^,\n ]+)*), from/.exec(text);
  const info = { ok: Boolean(input), format: input ? input[1] : '', duration: null, video: [], audio: 0, subtitle: 0, data: 0, attachment: 0, rotation: null };
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) info.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  for (const line of log) {
    const s = /Stream #0:\d+[^:]*: (Video|Audio|Subtitle|Data|Attachment): ?(.*)/.exec(line);
    if (s) {
      const [, kind, rest] = s;
      if (kind === 'Video') {
        const size = /, (\d{2,5})x(\d{2,5})/.exec(rest);
        info.video.push({ codec: (/^(\w+)/.exec(rest) || [])[1] || '', width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0, cover: /attached pic/.test(rest) });
      } else info[kind.toLowerCase()] += 1;
    }
    const r = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(line);
    if (r && info.rotation === null) info.rotation = Number(r[1]);
  }
  info.invalid = /Invalid data found|could not find codec parameters|moov atom not found|EBML header parsing failed/i.test(text) && !info.video.length;
  return info;
}

function probe(path) {
  return parseInfo(exec(['-i', path]).log); // ffmpeg exits with 1 here ("no output file"); the log is what we want
}

function isOom(err) {
  return /memory|RangeError|allocation|OOM|Aborted/i.test(String(err && (err.message || err)));
}

function mute({ file, ext, withSubs }) {
  return withMountedInput(file, ext, (inPath) => {
    const outPath = `/out/output.${ext}`;
    const mov = ['mp4', 'm4v', 'mov'].includes(ext);
    const tail = ['-c', 'copy', '-an', '-dn', '-map_metadata', '0', ...(mov ? ['-movflags', '+faststart'] : []), '-y', outPath];
    // First try: every video stream plus subtitles, copied untouched. Fallback: just the main video stream.
    let keptSubs = withSubs;
    let run = exec(['-i', inPath, '-map', '0:v', ...(withSubs ? ['-map', '0:s?'] : []), ...tail]);
    if (run.ret !== 0) {
      keptSubs = false;
      try { core.FS.unlink(outPath); } catch { /* nothing written */ }
      run = exec(['-i', inPath, '-map', '0:v:0', '-sn', ...tail]);
    }
    if (run.ret !== 0) {
      const last = run.log.filter((l) => /error|invalid|not supported|could not/i.test(l)).slice(-2).join(' ');
      const err = new Error(last || 'ffmpeg could not copy the video stream into a new file.');
      err.kind = /memory/i.test(last) ? 'oom' : 'convert';
      throw err;
    }
    const data = core.FS.readFile(outPath);
    const outInfo = probe(outPath);
    core.FS.unlink(outPath);
    return { data, outInfo, keptSubs };
  });
}

self.onmessage = async ({ data: msg }) => {
  const { id } = msg;
  try {
    await ensureCore();
    if (msg.type === 'probe') {
      const info = withMountedInput(msg.file, msg.ext, probe);
      self.postMessage({ id, ok: true, info });
    } else if (msg.type === 'mute') {
      const res = mute(msg);
      self.postMessage({ id, ok: true, ...res }, [res.data.buffer]);
    }
  } catch (err) {
    const kind = err && err.kind ? err.kind : isOom(err) ? 'oom' : 'crash';
    self.postMessage({ id, ok: false, error: String((err && err.message) || err), kind });
  }
};
