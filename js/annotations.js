// Canvas overlay for drawing on paused frames.
// All shape coordinates are normalized 0..1 against the video's intrinsic
// frame (not the element box), so drawings land on the same image features
// at any player size, including letterboxed/pillarboxed videos.
// Stroke width is normalized against the frame width.

import { el } from "./ui.js";

export const ANNOT_COLORS = ["#ff4757", "#f5a623", "#3ecf8e", "#5b8cff"];

export class Annotator {
  constructor(videoWrap, video) {
    this.video = video;
    this.canvas = el("canvas", { class: "annot-canvas" });
    videoWrap.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this.tool = null;          // null | "pen" | "arrow" | "rect"
    this.color = ANNOT_COLORS[0];
    this.pending = [];         // shapes drawn but not yet posted
    this.shown = null;         // saved shapes currently displayed
    this.drawing = null;       // in-progress shape
    this.onPendingChange = null;

    this._resize = () => {
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = this.canvas.clientWidth * dpr;
      this.canvas.height = this.canvas.clientHeight * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._repaint();
    };
    this._observer = new ResizeObserver(this._resize);
    this._observer.observe(this.canvas);
    video.addEventListener("loadedmetadata", this._resize);

    this.canvas.addEventListener("pointerdown", (e) => this._down(e));
    this.canvas.addEventListener("pointermove", (e) => this._move(e));
    this.canvas.addEventListener("pointerup", (e) => this._up(e));
    this.canvas.addEventListener("pointercancel", () => (this.drawing = null));
  }

  destroy() {
    this._observer.disconnect();
    this.canvas.remove();
  }

  get active() {
    return this.tool !== null;
  }

  get hasPending() {
    return this.pending.length > 0;
  }

  setTool(tool) {
    this.tool = tool;
    this.canvas.classList.toggle("drawing", !!tool);
  }

  setColor(color) {
    this.color = color;
  }

  takePending() {
    const shapes = this.pending;
    this.pending = [];
    this._repaint();
    return shapes;
  }

  cancelPending() {
    this.pending = [];
    this.drawing = null;
    this.setTool(null);
    this._repaint();
    this.onPendingChange?.();
  }

  showShapes(shapes) {
    this.shown = shapes || null;
    this._repaint();
  }

  clearShown() {
    if (!this.shown) return;
    this.shown = null;
    this._repaint();
  }

  // Content box of the actual video image inside the element (letterbox-aware).
  _contentBox() {
    const vw = this.video.videoWidth || 16;
    const vh = this.video.videoHeight || 9;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const scale = Math.min(cw / vw, ch / vh);
    const w = vw * scale;
    const h = vh * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  _norm(e) {
    const rect = this.canvas.getBoundingClientRect();
    const box = this._contentBox();
    const nx = (e.clientX - rect.left - box.x) / box.w;
    const ny = (e.clientY - rect.top - box.y) / box.h;
    return [Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny))];
  }

  _down(e) {
    if (!this.tool) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this._norm(e);
    const base = { color: this.color, width: 0.004 };
    if (this.tool === "pen") this.drawing = { type: "pen", points: [p], ...base };
    if (this.tool === "arrow") this.drawing = { type: "arrow", from: p, to: p, ...base };
    if (this.tool === "rect") this.drawing = { type: "rect", x: p[0], y: p[1], w: 0, h: 0, _from: p, ...base };
    this._repaint();
  }

  _move(e) {
    if (!this.drawing) return;
    const p = this._norm(e);
    const d = this.drawing;
    if (d.type === "pen") {
      const last = d.points[d.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.003) d.points.push(p);
    } else if (d.type === "arrow") {
      d.to = p;
    } else if (d.type === "rect") {
      d.x = Math.min(d._from[0], p[0]);
      d.y = Math.min(d._from[1], p[1]);
      d.w = Math.abs(p[0] - d._from[0]);
      d.h = Math.abs(p[1] - d._from[1]);
    }
    this._repaint();
  }

  _up() {
    if (!this.drawing) return;
    const d = this.drawing;
    this.drawing = null;
    const tooSmall =
      (d.type === "pen" && d.points.length < 2) ||
      (d.type === "arrow" && Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]) < 0.01) ||
      (d.type === "rect" && (d.w < 0.01 || d.h < 0.01));
    if (!tooSmall) {
      delete d._from;
      this.pending.push(d);
    }
    this._repaint();
    this.onPendingChange?.();
  }

  _repaint() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    const box = this._contentBox();
    const paint = (shape) => this._paintShape(ctx, shape, box);
    if (this.shown) this.shown.forEach(paint);
    this.pending.forEach(paint);
    if (this.drawing) paint(this.drawing);
  }

  _paintShape(ctx, s, box) {
    const X = (nx) => box.x + nx * box.w;
    const Y = (ny) => box.y + ny * box.h;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(1.5, s.width * box.w);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();

    if (s.type === "pen") {
      s.points.forEach(([nx, ny], i) => (i ? ctx.lineTo(X(nx), Y(ny)) : ctx.moveTo(X(nx), Y(ny))));
      ctx.stroke();
    } else if (s.type === "rect") {
      ctx.strokeRect(X(s.x), Y(s.y), s.w * box.w, s.h * box.h);
    } else if (s.type === "arrow") {
      const x1 = X(s.from[0]), y1 = Y(s.from[1]);
      const x2 = X(s.to[0]), y2 = Y(s.to[1]);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(10, ctx.lineWidth * 4);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
      ctx.stroke();
    }
  }
}
