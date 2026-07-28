// Frame-rate detection for uploads.
//
// MP4 and MOV are both ISO base media files, so the rate can be read straight
// out of the container: the media header carries a timescale and the
// time-to-sample table carries per-frame durations. That is exact (it recovers
// 23.976 as 24000/1001 rather than "about 24"), and it only needs the few KB
// the moov box occupies — no decoding.
//
// WebM uses EBML instead, where the video track records a default frame
// duration — also exact, also cheap.
//
// Playing the file back and counting frames is the last resort only: browsers
// refuse to play video in a background tab, so it can't be relied on.

// Rates a detected value is snapped to when it lands close enough; nearest
// always wins, so 23.976 can't be mistaken for 24 (they sit 0.1% apart).
const COMMON_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];

const MAX_MOOV_BYTES = 64 * 1024 * 1024;
// WebM writes Tracks before the first cluster of media, so a prefix suffices.
const EBML_PREFIX_BYTES = 4 * 1024 * 1024;
const MEASURE_FRAMES = 30;
const MEASURE_TIMEOUT_MS = 4000;

// Returns {fps, source: "container"|"measured"} or null when unreadable.
export async function detectFps(file) {
  for (const parse of [fpsFromIsoBmff, fpsFromEbml]) {
    try {
      const exact = await parse(file);
      if (exact) return { fps: snapNearest(exact, 0.002), source: "container" };
    } catch {
      // Wrong container for this parser, or a truncated file — try the next.
    }
  }
  try {
    const measured = await fpsFromPlayback(file);
    if (measured) return { fps: snapNearest(measured, 0.02), source: "measured" };
  } catch {
    // Undecodable in this browser; the caller keeps its manual value.
  }
  return null;
}

function snapNearest(fps, tolerance) {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  let best = fps;
  let bestErr = Infinity;
  for (const rate of COMMON_RATES) {
    const err = Math.abs(fps - rate) / rate;
    if (err < bestErr) {
      bestErr = err;
      best = rate;
    }
  }
  return bestErr <= tolerance ? best : Math.round(fps * 1000) / 1000;
}

// ── ISO BMFF (MP4 / MOV) ────────────────────────────────────────────────────

async function bytesAt(file, start, length) {
  const end = Math.min(file.size, start + length);
  if (end <= start) return new Uint8Array(0);
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

const typeAt = (bytes, p) =>
  String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);

// Box header: 32-bit size, then type. size 1 means a 64-bit size follows;
// size 0 means the box runs to the end of its container.
function headerAt(bytes, dv, p, end) {
  if (p + 8 > end) return null;
  let size = dv.getUint32(p);
  let header = 8;
  if (size === 1) {
    if (p + 16 > end) return null;
    size = dv.getUint32(p + 8) * 2 ** 32 + dv.getUint32(p + 12);
    header = 16;
  } else if (size === 0) {
    size = end - p;
  }
  if (size < header || p + size > end) return null;
  return { type: typeAt(bytes, p), size, body: p + header, bodyEnd: p + size };
}

// Walks sibling boxes inside an already-loaded buffer.
function* boxes(bytes, dv, start, end) {
  let p = start;
  while (p + 8 <= end) {
    const box = headerAt(bytes, dv, p, end);
    if (!box) return;
    yield box;
    p += box.size;
  }
}

function child(bytes, dv, parent, type) {
  for (const box of boxes(bytes, dv, parent.body, parent.bodyEnd)) {
    if (box.type === type) return box;
  }
  return null;
}

// Locates moov by stepping over top-level boxes — mdat is skipped by offset
// arithmetic, never read, so a 700 MB file still costs only a few small reads.
async function findMoov(file) {
  let offset = 0;
  while (offset < file.size) {
    const head = await bytesAt(file, offset, 16);
    if (head.length < 8) return null;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = dv.getUint32(0);
    const type = typeAt(head, 0);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = dv.getUint32(8) * 2 ** 32 + dv.getUint32(12);
      header = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < header) return null;
    if (type === "moov") {
      const length = size - header;
      if (length <= 0 || length > MAX_MOOV_BYTES) return null;
      return bytesAt(file, offset + header, length);
    }
    offset += size;
  }
  return null;
}

async function fpsFromIsoBmff(file) {
  const moov = await findMoov(file);
  if (!moov || !moov.length) return null;
  const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);

  for (const trak of boxes(moov, dv, 0, moov.length)) {
    if (trak.type !== "trak") continue;
    const mdia = child(moov, dv, trak, "mdia");
    if (!mdia) continue;

    // Skip audio and subtitle tracks.
    const hdlr = child(moov, dv, mdia, "hdlr");
    if (hdlr && typeAt(moov, hdlr.body + 4) !== "vide") continue;

    const mdhd = child(moov, dv, mdia, "mdhd");
    const minf = child(moov, dv, mdia, "minf");
    const stbl = minf && child(moov, dv, minf, "stbl");
    const stts = stbl && child(moov, dv, stbl, "stts");
    if (!mdhd || !stts) continue;

    // mdhd: version/flags, then times — 32-bit in version 0, 64-bit in 1.
    const version = moov[mdhd.body];
    const timescale = dv.getUint32(mdhd.body + (version === 1 ? 20 : 12));
    if (!timescale) continue;

    // stts: version/flags, entry_count, then (sample_count, sample_delta)*.
    const entries = dv.getUint32(stts.body + 4);
    let samples = 0;
    let ticks = 0;
    for (let i = 0; i < entries; i++) {
      const at = stts.body + 8 + i * 8;
      if (at + 8 > stts.bodyEnd) break;
      const count = dv.getUint32(at);
      const delta = dv.getUint32(at + 4);
      samples += count;
      ticks += count * delta;
    }
    // Averaging over the whole table keeps variable-frame-rate files honest.
    if (samples > 0 && ticks > 0) return (timescale * samples) / ticks;
  }
  return null;
}

// ── EBML (WebM) ─────────────────────────────────────────────────────────────

const EBML = {
  header: 0x1a45dfa3,
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackType: 0x83,
  defaultDuration: 0x23e383,
};

// EBML variable-length integer. IDs keep their marker bits (that's how the
// spec writes them); sizes strip the marker to get the length.
function readVint(bytes, p, end, keepMarker) {
  if (p >= end) return null;
  const first = bytes[p];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || p + length > end) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let unknown = !keepMarker && (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[p + i];
    if (!keepMarker && bytes[p + i] !== 0xff) unknown = false;
  }
  return { value, length, unknown };
}

function* ebmlChildren(bytes, start, end) {
  let p = start;
  while (p < end) {
    const id = readVint(bytes, p, end, true);
    if (!id) return;
    const size = readVint(bytes, p + id.length, end, false);
    if (!size) return;
    const body = p + id.length + size.length;
    // An unknown size (all bits set) runs to the end of what we have.
    const bodyEnd = size.unknown ? end : Math.min(end, body + size.value);
    if (bodyEnd < body) return;
    yield { id: id.value, body, bodyEnd };
    p = bodyEnd;
  }
}

function ebmlFind(bytes, start, end, id) {
  for (const child of ebmlChildren(bytes, start, end)) {
    if (child.id === id) return child;
  }
  return null;
}

function ebmlUint(bytes, start, end) {
  let value = 0;
  for (let p = start; p < end; p++) value = value * 256 + bytes[p];
  return value;
}

async function fpsFromEbml(file) {
  const head = await bytesAt(file, 0, EBML_PREFIX_BYTES);
  if (head.length < 4) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (dv.getUint32(0) !== EBML.header) return null;

  const segment = ebmlFind(head, 0, head.length, EBML.segment);
  if (!segment) return null;
  const tracks = ebmlFind(head, segment.body, segment.bodyEnd, EBML.tracks);
  if (!tracks) return null;

  for (const entry of ebmlChildren(head, tracks.body, tracks.bodyEnd)) {
    if (entry.id !== EBML.trackEntry) continue;
    let isVideo = false;
    let frameNanos = 0;
    for (const field of ebmlChildren(head, entry.body, entry.bodyEnd)) {
      if (field.id === EBML.trackType) isVideo = ebmlUint(head, field.body, field.bodyEnd) === 1;
      else if (field.id === EBML.defaultDuration) frameNanos = ebmlUint(head, field.body, field.bodyEnd);
    }
    if (isVideo && frameNanos > 0) return 1e9 / frameNanos;
  }
  return null;
}

// ── playback measurement (last resort) ──────────────────────────────────────

function fpsFromPlayback(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    if (typeof video.requestVideoFrameCallback !== "function") {
      reject(new Error("Frame callbacks unsupported"));
      return;
    }

    const url = URL.createObjectURL(file);
    let first = null;
    let last = null;
    let frames = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const span = last && first ? last.mediaTime - first.mediaTime : 0;
      const shown = last && first ? last.presentedFrames - first.presentedFrames : 0;
      const counted = shown > 0 ? shown : frames - 1;
      if (span > 0 && counted > 0) resolve(counted / span);
      else reject(new Error("Too few frames to measure"));
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(succeed, MEASURE_TIMEOUT_MS);

    const onFrame = (_now, meta) => {
      if (!first) first = meta;
      last = meta;
      frames++;
      if (frames >= MEASURE_FRAMES) succeed();
      else video.requestVideoFrameCallback(onFrame);
    };

    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.addEventListener("error", () => fail(new Error("Could not decode video")));
    video.src = url;
    video.play().then(
      () => video.requestVideoFrameCallback(onFrame),
      (err) => fail(err)
    );
  });
}
