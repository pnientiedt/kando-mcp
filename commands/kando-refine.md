---
description: Refine a Kando ticket (story or subtask) into an agreed spec, written into the ticket.
argument-hint: <KEY-N>
---

Load the `kando-refine` skill and refine the ticket: **$ARGUMENTS**

This is an interactive, human-in-the-loop design conversation: ask questions one at a time, present 2–3 alternatives, and present a design for approval. Only after I approve, write a `## 📋 Specification` section into the ticket (preserving the original description and any existing `## 🤖 Claude — …` sections) and apply the `refined` tag. Do NOT implement anything or spawn subagents. If no ticket was given above, ask which one.
