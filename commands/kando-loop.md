---
description: Autonomously work one or more Kando targets (board keys and/or KEY-N stories/subtasks) to completion.
argument-hint: <target> [target ...]
---

Load the `kando-autonomous-loop` skill and run its coordinator loop for the target(s): **$ARGUMENTS**

If more than one target is given (space-separated, e.g. `TSK-1 TSK-2 TSK-3`), process them **in order** — fully exhaust one before moving to the next — with the safety counters **cumulative across the whole run**.

This is an autonomous, unattended run: you WILL spawn one worker subagent per ticket, and each worker commits, pushes, and (where a pipeline exists) waits for the deploy to go green before marking the ticket done. Honor every safety limit in the skill — respect-assignee scope, the high `human-needed` bar, circuit breaker = 3 consecutive human-needed, max-tasks = 25, and halt on any verify / push / deploy failure. If no target was given above, ask for one before starting.
