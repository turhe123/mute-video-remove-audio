// Generates the fictional video fixtures with the vendored ffmpeg wasm core (no system ffmpeg needed).
//   node tests/make-video-fixtures.cjs
// sample-video.mp4         6 s, 480x270, a moving square + a beeping tone (H.264 + AAC, like a phone recording)
// sample-video-silent.mp4  the same picture with no audio track
// sample-video.webm        the same clip as VP8 + Opus, which open-source Chromium (Playwright) can play
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'vendor', 'ffmpeg') + '/';
const out = path.join(__dirname, 'fixtures');
// The core is built for browsers/workers; give it just enough of a worker-like global to boot in Node.
globalThis.self = globalThis;
self.location = { href: 'file://' + dir + 'ffmpeg-core.js' };
globalThis.importScripts = () => {};
const createCore = require(dir + 'ffmpeg-core.js');

const picture = 'color=c=0x1e2a44:s=480x270:r=24:d=6,noise=alls=10:allf=t[bg];color=c=0xf5b700:s=48x48:r=24:d=6[sq];' +
  "[bg][sq]overlay=x='(W-w)*abs(mod(t/3,2)-1)':y='(H-h)/2+50*sin(t*2)':shortest=1,format=yuv420p[out0]";
const tone = "sine=f=880:sample_rate=44100:d=6,volume='if(lt(mod(t,1),0.25),0.6,0)':eval=frame[out1]";
const x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '24'];
const vp8 = ['-c:v', 'libvpx', '-b:v', '300k', '-g', '24']; // libvpx-vp9 crashes in this wasm build, VP8 is fine
const opus = ['-c:a', 'libopus', '-b:a', '24k'];

(async () => {
  const bin = fs.readFileSync(dir + 'ffmpeg-core.wasm');
  const ff = await createCore({ instantiateWasm: (imports, cb) => { WebAssembly.instantiate(bin, imports).then((r) => cb(r.instance)); return {}; } });
  if (process.env.DEBUG) ff.setLogger((e) => console.log(e.message));
  const run = (args, name) => {
    ff.exec('-hide_banner', '-y', ...args, name);
    const code = ff.ret; ff.reset();
    if (code !== 0) throw new Error(`ffmpeg failed for ${name} (${code})`);
    const data = ff.FS.readFile(name);
    fs.writeFileSync(path.join(out, name), data);
    console.log(`${name}: ${data.length} bytes`);
  };
  const both = ['-f', 'lavfi', '-i', `${picture};${tone}`];
  const meta = ['-metadata', 'title=Sample Video'];
  run([...both, ...x264, '-c:a', 'aac', '-b:a', '32k', ...meta, '-movflags', '+faststart', '-t', '6'], 'sample-video.mp4');
  run(['-f', 'lavfi', '-i', picture, ...x264, '-metadata', 'title=Sample Video (silent)', '-movflags', '+faststart', '-t', '6'], 'sample-video-silent.mp4');
  run([...both, ...vp8, ...opus, ...meta, '-t', '6'], 'sample-video.webm');
})().catch((e) => { console.error(e); process.exit(1); });
