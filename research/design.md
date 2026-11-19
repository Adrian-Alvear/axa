# AXA design research: terminal UI and commander experience (Nov 2026)
(Full report from the design agent; mockups and rationale summarized. Saved from the commander session because writing into research/ was blocked.)

## Current state (file:line)
- 5 panels with Control first (app.mjs:25, 679); the README still says 1-4 (README.md:13-30, 76).
- Control: tiles only when 30+ rows (control.mjs:157-175), map at 62% width (88-148), approvals (180-201), commander (202-228).
- Below 100x26, Control is a bare list plus "widen the window" (app.mjs:333): about 20 blank rows at 80x24.
- 3 rows per list entry (app.mjs:138).
- The axa theme is used whenever truecolor is available, with no light-background check (app.mjs:35, draw.mjs:24). On white: text 1.19:1, statuses 1.5-1.6:1. Frame text 2.07-2.24:1 (control.mjs:169, 173); dim text on the selected row 3.33:1.
- segBar uses ▮ for both filled and empty (control.mjs:22), so it's meaningless without color.
- h/l mean different things in Control (app.mjs:651-652 vs 686-687); R, u, c, i aren't documented; help is static (571-602); no command palette; footer hints get cut mid-word.
- Approvals: the question shows only its last line (app.mjs:67), so the command is lost; the approver's reason is in s.doing (events.mjs:106) but not shown; Yes is the primary button (control.mjs:196); options 2+ can't be picked (app.mjs:68-69); y answers waitingOthers()[0] (527-531) with no check that it's the same prompt.
- Markdown tables show raw (control.mjs:38-58, app.mjs:244); **bold** shows literally (app.mjs:221); placeholder reads "k anything…" (control.mjs:222-224).
- Map redraws every 150ms (app.mjs:907, 911) with no motion setting; empty map fills about 60% of the screen.
- Panel tags break the borders at 100 columns (control.mjs:12); agent names are cut (248); first-run focus is Sessions, not Chats as commented (app.mjs:882-883); no terminal title or notifications (app.mjs:81).

## Recommendations (effort, impact)
- R1 Approval card: full question, command in bold, WHY (approver reason), AXA SAYS (recommendation); 1-9 picks any option. (S, High)
- R2 Safer answering: send the session id + prompt hash, rejected if the prompt changed; y y within 5s to approve; Decline primary; a receipt toast. (S, High)
- R3 Attention-first Control: needs-you list on top; map optional (2+ sessions and 140+ cols, or m); compact Control under 100 cols. (M, High)
- R4 Light terminals: OSC 11 detection with COLORFGBG fallback, theme:auto plus axa-light; fix low-contrast roles; a contrast check in verify. (S-M, High)
- R5 OSC 2 tab title ("▲2 AXA · feed needs you") and opt-in OSC 9/777 notifications (WSL toast). (S, High)
- R6 Okabe-Ito palette (#E69F00 waiting, #56B4E9 working, #009E73 done, #D55E00 stuck); ▮▯ bars with numbers. (S, Med)
- R7 Ctrl-k command palette; context-sensitive ? help. (M, Med-High)
- R8 Footer hints dropped by priority; fix the placeholder, tag overflow and agent names. (S, Med)
- R9 Render markdown tables and bold; report template Done/Checked/Needs you/Next. (S-M, Med)
- R10 "Since you left" card after 10+ min away; log filter f. (M, Med-High)
- R11 Consistent keys; help and README generated from one key map; fix first-run focus. (S, Med)
- R12 First-run onboarding card in place of the empty map. (S, Med)
- R13 Motion setting full/reduced/off. (S, Low-Med)
- R14 Compact density mode. (S, Med)
- R15 Settings with descriptions and a live theme preview. (S, Low-Med)

Top 5: R1-R5. Quick wins: ▯ glyph, placeholder, tag overflow, footer priority, first-run focus, README panel numbers.

Sources: code.claude.com/docs/en/agent-view, nngroup.com/articles/confirmation-dialog, k9scli.io/topics/hotkeys, terminfo OSC 11, WCAG 1.4.1/1.4.3/1.4.11/2.3.3, textual command palette, lazygit, zellij, clig.dev, disler/claude-code-hooks-multi-agent-observability.
