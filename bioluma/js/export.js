/* Getting work out of the app: a still, or a video of the canvas as it renders.

   Recording captures the visible canvas through captureStream, so what you see
   is exactly what lands in the file — including grain and vignette, which are
   composited on the view rather than into the accumulation. The bitrate is set
   deliberately high: these frames are almost entirely soft gradients, which is
   the worst case for a video codec, and the default bitrate turns them into
   banded mush. */

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function savePNG(canvas, name) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) download(blob, `${name}-${stamp()}.png`);
      resolve();
    }, 'image/png');
  });
}

export class Recorder {
  constructor() {
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
  }

  get active() { return !!this.rec; }
  get elapsed() { return this.rec ? (performance.now() - this.startedAt) / 1000 : 0; }

  static supported() {
    return typeof MediaRecorder !== 'undefined'
      && MIME_CANDIDATES.some((m) => MediaRecorder.isTypeSupported(m));
  }

  start(canvas, { fps = 60, name = 'bioluma', onStop } = {}) {
    if (this.rec) return;
    const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('This browser cannot record canvas video.');

    const stream = canvas.captureStream(fps);
    this.chunks = [];
    this.name = name;
    this.ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    this.rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 32_000_000,
    });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: mime });
      download(blob, `${this.name}-${stamp()}.${this.ext}`);
      this.rec = null;
      this.chunks = [];
      if (onStop) onStop(blob);
    };
    this.startedAt = performance.now();
    this.rec.start(250);
  }

  stop() {
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
  }
}
