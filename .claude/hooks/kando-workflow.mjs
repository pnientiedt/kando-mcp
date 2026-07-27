#!/usr/bin/env node
// Kando record-then-code re-anchor (UserPromptSubmit hook, installed by `kando-mcp init`).
// Cross-platform Node — no bash, no jq. When a submitted prompt references a Kando
// ticket, prints the gate to stdout (added to context); silent otherwise. Reads only
// the prompt field so the repo path (which may itself contain "kando") never matches.
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  raw += c;
});
process.stdin.on('end', () => {
  let prompt = '';
  try {
    prompt = JSON.parse(raw).prompt ?? '';
  } catch {
    prompt = '';
  }
  if (!/kando|[A-Z]{2,10}-[0-9]+/i.test(prompt)) process.exit(0);
  process.stdout.write(`MANDATORY — Kando record-then-code gate (see the \`kando\` skill; re-read it now for THIS ticket).
If this task corresponds to a Kando ticket KEY-N, before ANY repo Edit/Write for it you MUST:
  1) get_ticket(KEY-N)
  2) append a "## 🤖 Claude — Plan" section to its body (preserve the human's original text)
  3) move_ticket(KEY-N) into the in-progress column (move its subtasks if it is a container)
When finished: append a "## 🤖 Claude — Done" section and move it to the last column.
A skill loaded for a previous ticket does NOT count — re-anchor per ticket.
`);
  process.exit(0);
});
