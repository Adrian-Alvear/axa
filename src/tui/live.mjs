// A live session inside the terminal UI: a tmux client attached to the session (in a PTY), rendered
// through a headless terminal so AXA can draw its own header around it. Everything you type goes to it.
// Copying: drag with the mouse (tmux selects); the copy reaches your clipboard through OSC 52 and, on
// WSL, clip.exe. Hold Shift to use your terminal's own selection instead.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { ESC } from "./draw.mjs";
import { copyToClipboard } from "./clipboard.mjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const { Terminal: Headless } = require("@xterm/headless");

export class LiveView {
  constructor({ socket, conf, env, session, cols, rows, onUpdate, noColor }) {
    this.socket = socket; this.env = env; this.id = session.id; this.onUpdate = onUpdate; this.noColor = noColor;
    this.cols = cols; this.rows = rows; this.cursorOn = true; this.dead = null;
    const has = spawnSync("tmux", ["-L", socket, "has-session", "-t", `=axa-${session.id}`], { stdio: "ignore", env });
    if (!session.alive || has.status !== 0) { this.dead = "This session has ended."; return; }
    this.term = new Headless({ cols, rows, scrollback: 0, allowProposedApi: true });
    this.proc = pty.spawn("tmux", ["-L", socket, "-f", conf, "attach-session", "-t", `=axa-${session.id}`], { name: "xterm-256color", cols, rows, cwd: homedir(), env });
    this.fit();
    this.proc.onData((d) => {
      if (this.closed) return;
      // a copy made in tmux arrives as OSC 52: pass it to your clipboard
      const osc = /\x1b\]52;[a-z]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/.exec(d);
      if (osc) { try { copyToClipboard(Buffer.from(osc[1], "base64").toString("utf8")); this.copied = Date.now(); } catch {} }
      // cursor visibility isn't in the public API: follow the last show/hide in the stream
      const i = Math.max(d.lastIndexOf("\x1b[?25h"), d.lastIndexOf("\x1b[?25l"));
      if (i >= 0) this.cursorOn = d[i + 5] === "h";
      this.term.write(d, onUpdate);
    });
    this.proc.onExit(() => { if (!this.closed) { this.dead = "This session has ended or was detached."; onUpdate(); } });
  }
  // The session's window takes this view's size (the web console re-sizes it when you use it there)
  fit() { spawnSync("tmux", ["-L", this.socket, "resize-window", "-t", `=axa-${this.id}:`, "-x", String(this.cols), "-y", String(this.rows)], { stdio: "ignore", env: this.env }); }
  resize(cols, rows) {
    if (this.dead || (cols === this.cols && rows === this.rows)) return;
    this.cols = cols; this.rows = rows;
    try { this.proc.resize(cols, rows); this.term.resize(cols, rows); this.fit(); } catch {}
  }
  write(data) { if (!this.dead) this.proc.write(data); }
  // Forward a mouse event (1-based x, y inside the view) when the session asked for the mouse (tmux does)
  mouse(b, x, y, up) { if (!this.dead && this.term.modes.mouseTrackingMode !== "none") this.proc.write(`${ESC}[<${b};${x};${y}${up ? "m" : "M"}`); }
  close() {
    if (this.closed) return;
    this.closed = true;
    // detach only this client (by its tty), never the daemon's own view
    try { if (this.proc?._pty) spawnSync("tmux", ["-L", this.socket, "detach-client", "-t", this.proc._pty], { stdio: "ignore", env: this.env }); } catch {}
    try { this.proc?.kill(); } catch {}
    try { this.term?.dispose(); } catch {}
  }
  // Rows of the session as ANSI strings, exactly `cols` wide
  rowsAnsi() {
    const rows = [];
    const b = this.term.buffer.active, cell = b.getNullCell();
    for (let y = 0; y < this.rows; y++) {
      const ln = b.getLine(b.baseY + y);
      let s = "", cur = "", n = 0;
      for (let x = 0; x < this.cols && ln; x++) {
        ln.getCell(x, cell);
        const w = cell.getWidth();
        if (w === 0) continue;
        const a = this.sgr(cell);
        if (a !== cur) { s += `${ESC}[0${a ? ";" + a : ""}m`; cur = a; }
        if (x + w > this.cols) { s += " "; n += 1; break; } // a wide char in the last column
        s += cell.getChars() || " "; n += w;
      }
      rows.push(s + `${ESC}[0m` + " ".repeat(Math.max(0, this.cols - n)));
    }
    return rows;
  }
  sgr(c) {
    const a = [];
    if (c.isBold()) a.push(1); if (c.isDim()) a.push(2); if (c.isItalic()) a.push(3); if (c.isUnderline()) a.push(4);
    if (c.isInverse()) a.push(7); if (c.isInvisible()) a.push(8); if (c.isStrikethrough()) a.push(9);
    if (this.noColor) return a.join(";");
    if (c.isFgRGB()) { const v = c.getFgColor(); a.push(`38;2;${v >> 16};${(v >> 8) & 255};${v & 255}`); }
    else if (c.isFgPalette()) { const p = c.getFgColor(); a.push(p < 8 ? 30 + p : p < 16 ? 82 + p : `38;5;${p}`); }
    if (c.isBgRGB()) { const v = c.getBgColor(); a.push(`48;2;${v >> 16};${(v >> 8) & 255};${v & 255}`); }
    else if (c.isBgPalette()) { const p = c.getBgColor(); a.push(p < 8 ? 40 + p : p < 16 ? 92 + p : `48;5;${p}`); }
    return a.join(";");
  }
  cursor() { const b = this.term?.buffer.active; return b && this.cursorOn ? { x: b.cursorX, y: b.cursorY } : null; }
}
