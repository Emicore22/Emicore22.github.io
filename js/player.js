// Custom <video> player: frame-accurate stepping, HH:MM:SS:FF timecode,
// keyboard shortcuts, and transparent refresh of expired Dropbox temp links.

import { el } from "./ui.js";
import { secondsToTimecode, stepTime, clamp } from "./timecode.js";

const ICONS = {
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zM14 5h4v14h-4z",
  stepBack: "M18 6l-8.5 6L18 18V6zM8 6H6v12h2z",
  stepFwd: "M6 6l8.5 6L6 18V6zM16 6h2v12h-2z",
  volume: "M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z",
  muted: "M3 9v6h4l5 5V4L7 9H3zm18.6 6.4l-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1-2.1-2.1 1.4-1.4 2.1 2.1 2.1-2.1 1.4 1.4-2.1 2.1z",
  full: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

export class Player {
  constructor(mount, { fps = 25 } = {}) {
    this.fps = fps;
    this.refreshLink = null;
    this.expiresAt = 0;
    this.keyboardEnabled = true;
    this.onPlayStateChange = null;

    this.video = el("video", { class: "player-video", playsInline: true, preload: "metadata" });
    this.videoWrap = el("div", { class: "video-wrap" }, this.video);

    this.timecodeEl = el("span", { class: "timecode" }, "00:00:00:00");
    this.durationEl = el("span", { class: "timecode dim" }, "00:00:00:00");
    this.playBtn = el("button", { class: "ctrl-btn", title: "Play/Pause (Space)" }, icon("play"));
    this.scrub = el("input", {
      class: "scrub", type: "range", min: "0", max: "1000", step: "1", value: "0",
    });
    // Comment ticks live on their own rail above the track rather than on top
    // of it, so they never intercept a drag on the scrubber.
    this.markerRail = el("div", { class: "scrub-markers" });
    this.scrubWrap = el("div", { class: "scrub-wrap" }, this.markerRail, this.scrub);
    this.markers = [];
    this.activeMarkerId = null;
    this.muteBtn = el("button", { class: "ctrl-btn", title: "Mute" }, icon("volume"));

    const stepBackBtn = el("button", { class: "ctrl-btn", title: "Previous frame (←)" }, icon("stepBack"));
    const stepFwdBtn = el("button", { class: "ctrl-btn", title: "Next frame (→)" }, icon("stepFwd"));
    const fullBtn = el("button", { class: "ctrl-btn", title: "Fullscreen" }, icon("full"));

    this.controls = el(
      "div", { class: "player-controls" },
      this.playBtn, stepBackBtn, stepFwdBtn,
      el("div", { class: "tc-group" }, this.timecodeEl, el("span", { class: "dim" }, " / "), this.durationEl),
      this.scrubWrap,
      this.muteBtn, fullBtn
    );

    this.root = el("div", { class: "player" }, this.videoWrap, this.controls);
    mount.append(this.root);

    // ── events ──
    this.playBtn.addEventListener("click", () => this.togglePlay());
    this.video.addEventListener("click", () => this.togglePlay());
    stepBackBtn.addEventListener("click", () => this.step(-1));
    stepFwdBtn.addEventListener("click", () => this.step(1));
    this.muteBtn.addEventListener("click", () => {
      this.video.muted = !this.video.muted;
      this.muteBtn.replaceChildren(icon(this.video.muted ? "muted" : "volume"));
    });
    fullBtn.addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else this.root.requestFullscreen?.();
    });

    this.video.addEventListener("timeupdate", () => this._syncUi());
    this.video.addEventListener("durationchange", () => {
      this.durationEl.textContent = secondsToTimecode(this.video.duration || 0, this.fps);
      // Marker positions are a percentage of the duration, which is unknown
      // until metadata arrives — so place them again once it does.
      this._drawMarkers();
    });
    this.video.addEventListener("play", () => {
      this.playBtn.replaceChildren(icon("pause"));
      this._startTicking();
      this.onPlayStateChange?.(true);
    });
    this.video.addEventListener("pause", () => {
      this.playBtn.replaceChildren(icon("play"));
      this._stopTicking();
      this.onPlayStateChange?.(false);
    });
    this.video.addEventListener("ended", () => this._stopTicking());
    this.video.addEventListener("error", () => this._recoverExpiredLink());

    this.scrub.addEventListener("input", () => {
      if (!this.video.duration) return;
      this.video.currentTime = (this.scrub.value / 1000) * this.video.duration;
    });

    this._onKey = (e) => this._handleKey(e);
    document.addEventListener("keydown", this._onKey);

    // timeupdate fires about four times a second — too coarse for a scrubber
    // that should track the frame. So the playhead is read on every animation
    // frame instead, but only while it is actually moving: a paused player
    // holds still, and waking 60 times a second to re-read the same number is
    // the one thing this app does when the reviewer is doing nothing at all.
    this._raf = null;
    this._tick = () => {
      this._syncUi();
      this._raf = requestAnimationFrame(this._tick);
    };
    if (!this.video.paused) this._startTicking();
  }

  _startTicking() {
    if (this._raf == null) this._raf = requestAnimationFrame(this._tick);
  }

  _stopTicking() {
    if (this._raf != null) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  destroy() {
    document.removeEventListener("keydown", this._onKey);
    this._stopTicking();
    this.video.pause();
    this.video.removeAttribute("src");
    this.root.remove();
  }

  // media: {url, expiresAt}; refresh: async () => ({url, expiresAt})
  load(media, refresh) {
    this.refreshLink = refresh || null;
    this.expiresAt = media.expiresAt || 0;
    this.video.src = media.url;
    this.video.load();
  }

  setFps(fps) {
    this.fps = fps;
    this._syncUi();
    this.durationEl.textContent = secondsToTimecode(this.video.duration || 0, this.fps);
  }

  // markers: [{id, timeSec, color, label, initials, onSelect}] — redrawn
  // whenever the comments change, and again on durationchange since positions
  // are a percentage of a duration that isn't known until metadata loads.
  setMarkers(markers) {
    this.markers = markers || [];
    this._drawMarkers();
  }

  // Keeps one tick expanded into its author's avatar — the selected note. Set
  // from whoever owns selection, so picking a note in the sidebar lights up its
  // tick just as clicking the tick does.
  setActiveMarker(id) {
    this.activeMarkerId = id ?? null;
    this._syncActiveMarker();
  }

  _syncActiveMarker() {
    for (const tick of this.markerRail.children) {
      tick.classList.toggle("active", tick.dataset.markerId === this.activeMarkerId);
    }
  }

  _drawMarkers() {
    const duration = this.video.duration;
    if (!duration || !Number.isFinite(duration)) {
      this.markerRail.replaceChildren();
      return;
    }
    this.markerRail.replaceChildren(
      ...this.markers.map((m) => {
        const pct = Math.min(100, Math.max(0, (m.timeSec / duration) * 100));
        const tick = el("button", {
          class: "scrub-marker",
          style: `left:${pct}%; --marker: ${m.color}`,
          title: m.label || secondsToTimecode(m.timeSec, this.fps),
          "aria-label": m.label || `Comment at ${secondsToTimecode(m.timeSec, this.fps)}`,
        }, el("span", { class: "marker-initials", "aria-hidden": "true" }, m.initials || ""));
        if (m.id != null) tick.dataset.markerId = m.id;
        tick.addEventListener("click", (e) => {
          e.stopPropagation();
          if (m.onSelect) m.onSelect();
          else this.seekTo(m.timeSec);
        });
        return tick;
      })
    );
    // Markers are rebuilt wholesale, so the active one has to be re-marked.
    this._syncActiveMarker();
  }

  get currentTime() {
    return this.video.currentTime;
  }

  get paused() {
    return this.video.paused;
  }

  async togglePlay() {
    if (this.video.paused) {
      await this._ensureFreshLink();
      this.video.play().catch(() => {});
    } else {
      this.video.pause();
    }
  }

  pause() {
    this.video.pause();
  }

  step(deltaFrames) {
    this.video.pause();
    this.video.currentTime = stepTime(this.video.currentTime, this.fps, deltaFrames, this.video.duration || 0);
    this._syncUi();
  }

  seekTo(timeSec) {
    // Quantize onto the frame grid so annotation overlays land on the exact frame.
    this.video.pause();
    this.video.currentTime = stepTime(timeSec, this.fps, 0, this.video.duration || timeSec + 1);
    this._syncUi();
  }

  // Runs once per animation frame during playback, so it writes to the DOM
  // only when the value on screen is actually stale: at 25 fps most frames
  // land on the same timecode and the same scrubber step.
  _syncUi() {
    const tc = secondsToTimecode(this.video.currentTime, this.fps);
    if (tc !== this._shownTc) {
      this.timecodeEl.textContent = tc;
      this._shownTc = tc;
    }
    if (this.video.duration) {
      const pos = String(Math.round((this.video.currentTime / this.video.duration) * 1000));
      if (pos !== this.scrub.value) this.scrub.value = pos;
    }
  }

  async _ensureFreshLink() {
    if (!this.refreshLink || !this.expiresAt || Date.now() < this.expiresAt) return;
    await this._swapLink();
  }

  async _recoverExpiredLink() {
    if (!this.refreshLink) return;
    try {
      await this._swapLink();
    } catch {
      // Leave the native error state; the UI surface is the video element.
    }
  }

  async _swapLink() {
    const t = this.video.currentTime;
    const wasPaused = this.video.paused;
    const media = await this.refreshLink();
    this.expiresAt = media.expiresAt || 0;
    this.video.src = media.url;
    this.video.load();
    await new Promise((resolve) => {
      this.video.addEventListener("loadedmetadata", resolve, { once: true });
    });
    this.video.currentTime = t;
    if (!wasPaused) this.video.play().catch(() => {});
  }

  _handleKey(e) {
    if (!this.keyboardEnabled) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

    switch (e.key) {
      case " ":
        e.preventDefault();
        this.togglePlay();
        break;
      case "k":
      case "K":
        this.video.pause();
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (e.shiftKey) this.video.currentTime = clamp(this.video.currentTime - 1, 0, this.video.duration || 0);
        else this.step(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (e.shiftKey) this.video.currentTime = clamp(this.video.currentTime + 1, 0, this.video.duration || 0);
        else this.step(1);
        break;
      case "j":
      case "J":
        this.video.currentTime = clamp(this.video.currentTime - 10, 0, this.video.duration || 0);
        break;
      case "l":
      case "L":
        if (this.video.paused) this.togglePlay();
        else this.video.playbackRate = this.video.playbackRate >= 2 ? 1 : 2;
        break;
      case "Home":
        this.video.currentTime = 0;
        break;
    }
  }
}
