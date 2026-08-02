---
name: kando-refine
description: Use when asked to refine a Kando ticket (a story or subtask) into a spec, e.g. via /kando-refine KEY-N. Runs an interactive brainstorming-style dialogue and writes an agreed Specification section into the ticket; for a big story it can also break it into subtasks, each with its own spec.
---

# Refining a Kando ticket

Turn a rough Kando ticket into an implementable spec through an interactive dialogue **with the user**, then persist the agreed spec into the ticket. This is human-in-the-loop: you ask, the user answers. You do **not** implement anything and do **not** spawn subagents — this produces a spec, not code.

**REQUIRED BACKGROUND:** the `kando` skill (ticket model, KEY-N, tags). This follows the `superpowers:brainstorming` *method*, but it targets a ticket, writes the result into the ticket body, and **stops at the spec** (no docs file, no planning, no implementation).

## The dialogue (in order — do NOT skip ahead to writing the spec)

1. **Explore.** `get_ticket KEY-N` — read its title, body, existing sections, tags, release; read any repo context that matters. If no KEY-N was given, ask which ticket.
2. **Lock the ticket.** `ensure_tag <board> human-needed` and `update_ticket KEY-N` to apply it (keep existing tags). This prevents a concurrent `/kando-loop` from picking the ticket up while you refine — `next_task` excludes `human-needed`. This is the ONLY pre-approval write: it's a tag, not body content, so it doesn't touch the human's words.
3. **Clarify — ONE question at a time.** Ask about purpose, constraints, and success criteria. Prefer multiple-choice. One question per message; don't overwhelm.
4. **Alternatives.** Propose **2–3 approaches** with trade-offs; lead with your recommendation and why.
5. **Present the design** in sections and get the user's approval. Revise until they approve.

**Do NOT write the Specification (or create subtasks) until the user has approved the design** — the step-2 lock tag is the only exception.

## Persist the spec (ONLY after approval)

1. `get_ticket KEY-N` again to get the CURRENT body.
2. Build the new body: keep the **original description** and any `## 🤖 Claude — …` sections **UNTOUCHED**; add a `## 📋 Specification` section — or, if one already exists, replace **that** section in place (never duplicate):

   ```
   ## 📋 Specification
   **Problem / goal:** …
   **Approach:** <the chosen option and why>
   **Key decisions:** …
   **Acceptance criteria:** <concrete, testable bullets>
   **Out of scope:** …
   ```

3. `update_ticket KEY-N` with `body` = the full combined text. Never send a body that drops the human's words, and never a section-only body.
4. `ensure_tag <board> refined`, then `update_ticket KEY-N` with `tags` = the ticket's current tag **names** plus `refined` (keep existing tags) — the "has an agreed spec" marker. **Keep the `human-needed` lock for now**; you release it in **Finish** below.
5. Continue to the decomposition offer below. (For a subtask target, skip straight to **Finish**.)

## Decompose a big story into subtasks (only when a breakdown is RECOMMENDED — story targets only)

Runs **after** the Specification is written, and **only when the target is a story** (a subtask has no children). **Only suggest a breakdown when you judge one is genuinely warranted** — do NOT dangle it as a generic option on every story.

1. **Decide first — is a breakdown warranted?** Judge it from the Specification you just wrote. A breakdown is warranted when the work splits into **multiple independently-shippable, separately-testable units**, spans **distinct concerns or sequential phases**, or is **too large for one TDD cycle**. It is NOT warranted for a single cohesive change, even a non-trivial one.
   - **If NOT warranted:** do not offer a breakdown. Tell the user the story is well-scoped as a single unit and go straight to **Finish** below (the spec-only outcome). (If the target is a subtask, always land here.)
   - **If warranted:** say so and recommend it — briefly name why (the units/phases you see) — then ask the user ONE question: "Want to break this into subtasks so it can be worked step by step?" If they decline, go to **Finish**.
2. **Read what exists.** `get_ticket` (and `get_board` for the board's columns) to see any subtasks the story already has. You will only ADD.
3. **Breakdown sub-dialogue.** Propose an **ordered** list of subtasks — each a short title + a one-line purpose — that together deliver the story's Specification. Iterate with the user (add / remove / reorder / merge). If subtasks already exist, propose only **additional or adjusted** steps; never propose duplicating an existing one, and never delete — a rename/removal is a suggestion for the user to act on, not something you do. **Do NOT create anything until the user approves the set.**
4. **Create the subtasks (only after approval), in order.** For each agreed step, in sequence:
   - `create_subtask <STORY KEY-N>` with a clear title and a `body` that is its own Specification:
     ```
     ## 📋 Specification
     **Problem / goal:** …
     **Approach:** …
     **Acceptance criteria:** <concrete, testable bullets>
     **Out of scope:** …
     ```
   - `ensure_tag <board> refined`, then `update_ticket` the new subtask with `tags: ["refined"]` (keep any tags it already has).
   - **If a step genuinely cannot start until an earlier one lands, say so with a dependency:** pass `blockedBy: ["<the earlier subtask's KEY-N>"]` to `create_subtask` (you have its `KEY-N` — you just created it). Rank is a preference; `blockedBy` is a constraint `/kando-loop` actually enforces, since `next_task` never serves a blocked ticket. Use it only for a real prerequisite, not to re-state the order you already created them in.
   Create them in discussion order so board rank matches the sequence — `/kando-loop <STORY>` then works them top-to-bottom, each to its own Acceptance criteria.
5. Then go to **Finish** below.

## Finish — release the lock and announce

Once the spec (and any decomposition) is done, **release the lock**: `update_ticket KEY-N` with tags = the ticket's current tag **names minus `human-needed`** (keep `refined` and everything else). This lets `/kando-loop` pick the ticket up again. Then tell the user the ticket is refined (and, if you decomposed it, split into N subtasks) and ready for `/kando-loop`.

## Never

- Never write the Specification or create subtasks before the user approves — the only pre-approval write is the step-2 `human-needed` lock tag.
- Never leave the `human-needed` lock on at the end — always release it at **Finish**, or the ticket stays excluded from `/kando-loop`.
- Never overwrite the original description or existing `## 🤖 Claude — …` sections — only add or replace the `## 📋 Specification` section.
- Never create subtasks before the user approves the breakdown; never decompose a subtask target (only stories have subtasks).
- Never offer a breakdown for a story that's fine as a single unit — suggest one only when you judge it genuinely warranted (see the Decide step), not as a default option.
- Never duplicate or delete an existing subtask — decomposition only ADDS newly-agreed subtasks.
- Never implement the work or spawn subagents — `/kando-refine` produces a spec; `/kando-loop` builds it.
