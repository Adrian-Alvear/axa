# Credits

AXA adapts a few ideas and patterns from **ECC / everything-claude-code**
(https://github.com/affaan-m/everything-claude-code), MIT License, Copyright (c) 2026 Affaan Mustafa:

- Secret redaction patterns (provider tokens, key=value and CLI forms) in `lib/safety.mjs`,
  from `skills/continuous-learning-v2/hooks/observe.sh`, `scripts/lib/memory-vault-format.js`,
  `scripts/hooks/governance-capture.js` and `scripts/hooks/post-bash-command-log.js`.
- Hidden/control character checks for untrusted text, from `scripts/lib/memory-vault-format.js`
  and `the-security-guide.md`.
- Destructive shell command patterns, from `scripts/hooks/governance-capture.js` and
  `scripts/hooks/gateguard-fact-force.js`.
- Reviewer discipline, the verification table, the two-reviewer gate for risky work, escalation
  rules and "search first", paraphrased from `agents/code-reviewer.md`,
  `skills/verification-loop`, `skills/santa-method`, `agents/loop-operator.md` and
  `skills/search-first`.
