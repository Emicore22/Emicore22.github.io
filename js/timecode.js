// Pure frame/timecode math. All timecode is non-drop-frame.

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function timeToFrame(seconds, fps) {
  return Math.round(seconds * fps);
}

export function frameToTime(frame, fps) {
  // Tiny epsilon past the frame boundary so the browser displays the
  // intended frame rather than the previous one (HTML5 seeking quirk).
  return frame / fps + 0.0001;
}

// 12.48s @ 25fps → "00:00:12:12"
export function secondsToTimecode(seconds, fps) {
  const totalFrames = Math.round(seconds * fps);
  const fpsInt = Math.round(fps);
  const ff = totalFrames % fpsInt;
  const totalSeconds = Math.floor(totalFrames / fpsInt);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

// Quantize an arbitrary currentTime onto the frame grid, shifted by `delta`
// frames, clamped to the clip duration.
export function stepTime(currentTime, fps, delta, duration) {
  const frame = Math.round(currentTime * fps) + delta;
  const maxFrame = Math.max(0, Math.floor(duration * fps) - 1);
  return frameToTime(clamp(frame, 0, maxFrame), fps);
}
