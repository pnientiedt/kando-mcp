// The record-then-code gate re-injected whenever a prompt references a Kando
// ticket. Kept in sync with assets/kando-workflow.mjs (a test asserts the asset
// embeds this text) — the asset must be self-contained (no imports) since it
// runs as a standalone hook process.
export const GATE_TEXT = `MANDATORY — Kando record-then-code gate (see the \`kando\` skill; re-read it now for THIS ticket).
If this task corresponds to a Kando ticket KEY-N, before ANY repo Edit/Write for it you MUST:
  1) get_ticket(KEY-N)
  2) append a "## 🤖 Claude — Plan" section to its body (preserve the human's original text)
  3) move_ticket(KEY-N) into the in-progress column (move its subtasks if it is a container)
When finished: append a "## 🤖 Claude — Done" section and move it to the last column.
A skill loaded for a previous ticket does NOT count — re-anchor per ticket.`;

/** Whether a submitted prompt references Kando work (a KEY-N ticket or "kando"). */
export function shouldReanchor(prompt: string): boolean {
  return /kando|[A-Z]{2,10}-[0-9]+/i.test(prompt);
}
