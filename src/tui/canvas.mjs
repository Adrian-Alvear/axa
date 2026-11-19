// A braille canvas: each terminal cell holds 2x4 dots, so lines, rings and charts come out fine-grained.
// Text and colors are laid over cells; render() returns ANSI rows exactly `cols` wide.
import { width } from "./draw.mjs";

const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]]; // [row][col] within a cell

export class Canvas {
  constructor(cols, rows) {
    this.cols = cols; this.rows = rows; this.W = cols * 2; this.H = rows * 4;
    this.dots = new Uint8Array(cols * rows);
    this.color = new Array(cols * rows).fill(null); // SGR code per cell (the last color drawn there)
    this.text = new Array(cols * rows).fill(null); // [char, sgr] overlays
  }
  set(x, y, sgr) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = (y >> 2) * this.cols + (x >> 1);
    this.dots[i] |= BIT[y & 3][x & 1];
    if (sgr) this.color[i] = sgr;
  }
  // dashed: draw `on` dots then skip `off`
  line(x0, y0, x1, y1, sgr, { on = 1, off = 0 } = {}) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let k = 0; k <= n; k++) if (!off || k % (on + off) < on) this.set(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, sgr);
  }
  // an ellipse (rx, ry in dots); step > 1 makes it dotted
  ring(cx, cy, rx, ry, sgr, step = 1) {
    const n = Math.max(12, Math.ceil(2 * Math.PI * Math.max(rx, ry)));
    for (let k = 0; k < n; k += step) { const a = (2 * Math.PI * k) / n; this.set(cx + rx * Math.cos(a), cy + ry * Math.sin(a), sgr); }
  }
  disc(cx, cy, r, sgr) {
    for (let y = -r; y <= r; y++) for (let x = -r * 1; x <= r; x++) if (x * x + y * y <= r * r) this.set(cx + x, cy + y, sgr);
  }
  // text at a cell position (col, row)
  put(col, row, s, sgr) {
    let c = Math.round(col);
    row = Math.round(row);
    if (row < 0 || row >= this.rows) return;
    for (const ch of s) {
      if (c >= 0 && c < this.cols) this.text[row * this.cols + c] = [ch, sgr];
      c += width(ch);
    }
  }
  // clear a run of cells (so a label sits on a clean background)
  clear(col, row, n) {
    for (let c = Math.round(col); c < Math.round(col) + n; c++) if (c >= 0 && c < this.cols && row >= 0 && row < this.rows) { const i = row * this.cols + c; this.dots[i] = 0; this.text[i] = [" ", null]; }
  }
  render(base = "") {
    const out = [];
    const open = (sgr) => `\x1b[0${base ? ";" + base : ""}${sgr ? ";" + sgr : ""}m`;
    for (let r = 0; r < this.rows; r++) {
      let s = "", cur = undefined;
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c, t = this.text[i];
        const sgr = t ? t[1] : this.dots[i] ? this.color[i] : null;
        if (sgr !== cur) { s += open(sgr); cur = sgr; }
        s += t ? t[0] : this.dots[i] ? String.fromCharCode(0x2800 + this.dots[i]) : " ";
      }
      out.push(s + "\x1b[0m");
    }
    return out;
  }
}

// An area chart of values across the canvas width (newest at the right)
export function areaChart(cols, rows, values, { line, fill }) {
  const cv = new Canvas(cols, rows);
  const max = Math.max(1, ...values), n = values.length;
  const at = (x) => { const f = (x / (cv.W - 1)) * (n - 1), i = Math.floor(f), t = f - i; return (values[i] ?? 0) * (1 - t) + (values[Math.min(n - 1, i + 1)] ?? 0) * t; };
  let prev = null;
  for (let x = 0; x < cv.W; x++) {
    const y = cv.H - 1 - Math.round((at(x) / max) * (cv.H - 2));
    for (let yy = y + 1; yy < cv.H; yy += 2) cv.set(x, yy, fill);
    if (prev !== null) cv.line(x - 1, prev, x, y, line); else cv.set(x, y, line);
    prev = y;
  }
  return cv;
}
