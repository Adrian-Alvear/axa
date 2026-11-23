// Reading Claude Code's dialogs off a session's screen: is a prompt open, and what are its options.
// AXA never answers these itself; only you can, from the hub, a session view or the web console.

// Any of Claude Code's choice dialogs (permission, folder trust, new MCP server...): they end with
// "Enter to confirm · Esc to cancel/exit" and number their options. The traced PermissionRequest and
// Notification events are the main signal; this is a backup.
export const PERMISSION_RE = /Do you want to (proceed|make this edit|create|allow)|Do you trust the files|trust this folder|Yes, and don't ask again|❯\s*1\.\s*Yes|MCP servers? found|Enter to confirm · Esc to (cancel|exit)/i;

// A dialog is open only while it's at the bottom of the screen: its "Enter to confirm / Esc to cancel"
// line is among the last few lines (an answered prompt can stay visible higher up, e.g. above a shell)
const FOOTER = /Enter to (?:confirm|select)|Esc to (?:cancel|exit)/i;
export function promptOnScreen(screenLines) {
  const tail = screenLines.filter((l) => l.trim()).slice(-4);
  return tail.some((l) => FOOTER.test(l)) && PERMISSION_RE.test(screenLines.slice(-25).join("\n"));
}

// Claude Code's folder-trust dialog ("Do you trust the files in this folder?", or newer: "Quick safety
// check: Is this a project you created or one you trust? ❯ 1. Yes, I trust this folder"). Only the user
// answers it; until then the session can't start, and anything typed would answer it.
const TRUST_RE = /Do you trust the files|Yes, I trust this folder|trust this folder|Quick safety check|a project you created or one you trust/i;
export const trustOnScreen = (screenLines) => promptOnScreen(screenLines) && TRUST_RE.test(screenLines.slice(-25).join("\n"));

const BOX = /[│┃╭╮╰╯─━╌╍┄┅┈┉═║]/g;

// The menu on screen: its question and options. Claude Code's menus (numbered or not) are a block of
// lines just above "Enter to confirm", one marked with the ❯ cursor; option labels line up with the
// cursor line's label (deeper lines are descriptions). Returns { question, options: [{n, label}], cursor } or null.
export function parseChoices(screenLines, width = 100) {
  const lines = screenLines.map((l) => l.replace(BOX, " ").trimEnd());
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) if (/Enter to (?:confirm|select)|Esc to (?:cancel|exit)/i.test(lines[i])) { end = i; break; }
  let i = end - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  const block = [];
  for (; i >= 0 && lines[i].trim(); i--) block.unshift({ text: lines[i], at: i });
  const cur = block.find((b) => /^\s*❯/.test(b.text));
  if (!cur) return null;
  const arrow = cur.text.search(/❯/);
  const col = arrow + 1 + cur.text.slice(arrow + 1).search(/\S/);
  const numbered = /^\d\.\s/.test(cur.text.slice(col));
  const options = [];
  let cursor = -1, last = "";
  for (const b of block) {
    const isCur = b === cur;
    if ((isCur ? col : b.text.search(/\S/)) !== col) continue; // a description line, or the question above
    const text = b.text.slice(col).trim();
    // A long label wraps onto the next line at the same indent: in a numbered menu every option has its
    // number; otherwise a line continues the previous one if its first word wouldn't have fit there
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
