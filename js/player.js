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
    this.muteBtn = el("button", { class: "ctrl-btn", title: "Mute" }, icon("volume"));

    const stepBackBtn = el("button", { class: "ctrl-btn", title: "Previous frame (←)" }, icon("stepBack"));
    const stepFwdBtn = el("button", { class: "ctrl-btn", title: "Next frame (→)" }, icon("stepFwd"));
    const fullBtn = el("button", { class: "ctrl-btn", title: "Fullscreen" }, icon("full"));

    this.controls = el(
      "div", { class: "player-controls" },
      this.playBtn, stepBackBtn, stepFwdBtn,
      el("div", { class: "tc-group" }, this.timecodeEl, el("span", { class: "dim" }, " / "), this.durationEl),
      this.scrub,
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
    });
    this.video.addEventListener("play", () => {
      this.playBtn.replaceChildren(icon("pause"));
      this.onPlayStateChange?.(true);
    });
    this.video.addEventListener("pause", () => {
      this.playBtn.replaceChildren(icon("play"));
      this.onPlayStateChange?.(false);
    });
    this.video.addEventListener("error", () => this._recoverExpiredLink());

    this.scrub.addEventListener("input", () => {
      if (!this.video.duration) return;
      this.video.currentTime = (this.scrub.value / 1000) * this.video.duration;
    });

    this._onKey = (e) => this._handleKey(e);
    document.addEventListener("keydown", this._onKey);

    this._raf = null;
    const tick = () => {
      if (!this.video.paused) this._syncUi();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  destroy() {
    document.removeEventListener("keydown", this._onKey);
    cancelAnimationFrame(this._raf);
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

  _syncUi() {
    this.timecodeEl.textContent = secondsToTimecode(this.video.currentTime, this.fps);
    if (this.video.duration) {
      this.scrub.value = String(Math.round((this.video.currentTime / this.video.duration) * 1000));
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
