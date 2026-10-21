// Reading Claude Code's dialogs off a session's screen: pure functions over captured lines, so they
// can be tested against fixture captures (test/fixtures/*.txt). terminals.mjs does the capturing,
// cleans what it shows (cleanText + redact) and types the answer.

// A captured screen as lines: trailing spaces and blank rows at the bottom dropped, the last n kept
export function screenTail(raw, n = 60) {
  const out = raw.map((l) => l.trimEnd());
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-n);
}

// Claude Code's permission dialogs: AXA must never answer these on the user's behalf. The traced
// PermissionRequest/Notification events are the main signal; this screen check is a backup.
// Any of Claude Code's choice dialogs counts (permission, folder trust, new MCP server...): they all
// end with "Enter to confirm · Esc to cancel/exit" and number their options.
export const PERMISSION_RE = /Do you want to (proceed|make this edit|create|allow)|Do you trust the files|trust this folder|Yes, and don't ask again|❯\s*1\.\s*Yes|MCP servers? found|Enter to confirm · Esc to (cancel|exit)/i;
export const awaitingPermission = (lines) => PERMISSION_RE.test(screenTail(lines, 25).join("\n"));

// ---------- the dialog on screen: its question and numbered options ----------
// So the user can answer a permission/trust prompt from the sessions list (on their phone) with one tap.
// Claude Code's menus (numbered or not) are a block of lines just above "Enter to confirm", one marked
// with the ❯ cursor; option labels line up with the cursor line's label (deeper lines are descriptions).
// width: the pane's width in columns (to tell a wrapped long label from the next option).
// Returns { question, options: [{ n, label }], cursor } as raw screen text, or null.
const BOX = /[│┃╭╮╰╯─━╌╍┄┅┈┉═║]/g;
export function choicesOf(screen, width = 100) {
  const lines = screenTail(screen, 40).map((l) => l.replace(BOX, " ").trimEnd());
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) if (/Enter to (?:confirm|select)|Esc to (?:cancel|exit)/i.test(lines[i])) { end = i; break; }
  let i = end - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  const block = [];
  for (; i >= 0 && lines[i].trim(); i--) block.unshift({ text: lines[i], at: i });
  const cur = block.find((b) => /^\s*❯/.test(b.text));
  if (!cur) return null;
  const col = cur.text.search(/❯/) + 1 + (cur.text.slice(cur.text.search(/❯/) + 1).search(/\S/));
  const numbered = /^\d\.\s/.test(cur.text.slice(col));
  const options = [];
  let cursor = -1, last = "";
  for (const b of block) {
    const isCur = b === cur;
    const start = isCur ? col : b.text.search(/\S/);
    if (start !== col) continue; // a description line under an option, or the question above
    const text = b.text.slice(col).trim();
    // A long label wraps onto the next line at the same indent: in a numbered menu every option has
    // its number; otherwise a line continues the previous one if its first word wouldn't have fit there
    // (or it starts lowercase right after a nearly full line)
    const wraps = options.length && !isCur && (numbered ? !/^\d\.\s/.test(text) : col + last.length + 1 + text.split(" ")[0].length > width - 4 || (/^[a-z]/.test(text) && col + last.length > (width - 4) * 0.75));
    if (wraps) { options[options.length - 1] += " " + text; last = text; continue; }
    if (isCur) cursor = options.length;
    options.push(text.replace(/^\d\.\s+/, ""));
    last = text;
  }
  if (!options.length || options.length > 9 || cursor < 0) return null;
  const firstAt = block.find((b) => (b === cur ? col : b.text.search(/\S/)) === col)?.at ?? cur.at;
  const above = lines.slice(Math.max(0, firstAt - 12), firstAt).map((l) => l.trim()).filter(Boolean);
  return { question: above.slice(-5).join("\n"), options: options.map((label, k) => ({ n: k + 1, label })), cursor };
}

// Picking option n (1-based) from a menu whose cursor is on index `cursor` (0-based): the arrow key to
// press, how many times, then Enter. As tmux key names; terminals.mjs maps them to escape codes for PTYs.
export function answerKeys(cursor, n) {
  const moves = n - 1 - cursor, key = moves > 0 ? "Down" : "Up";
  return { moves, key, keys: [...Array(Math.abs(moves)).fill(key), "Enter"] };
}
