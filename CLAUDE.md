## Kando autonomous loop — deploy authorization

The `/kando-loop` command runs an autonomous work loop that **spawns worker and reviewer subagents** (the Agent/Task tool) and lets them **commit and push to a `kando-loop/*` branch**, and lets the loop **merge that branch to `main` and trigger the deploy** once a batch of tickets is worth shipping — that is its intended, sanctioned flow. The coordinator, not a worker, is what touches `main`. Do not gate the loop's subagent dispatch, its branch pushes, or its deploys behind asking. (Added by the Kando MCP installer so /kando-loop runs under auto mode; delete this section to withdraw the authorization.)

## Releasing — work ends in a tag, not in a merge

**A merge to `main` is not the end of a piece of work; the release tag is.** This package
is consumed through `npx` / `npm i -g`, so a change sitting on `main` untagged has
reached nobody. Finishing something and leaving it unreleased is the failure mode this
rule exists to prevent — do not stop at the merge and report done.

The flow, end to end:

1. **Work on a branch**, never directly on `main`. Merge it with
   `git merge --no-ff <branch>`, then **delete the branch** — locally and, if it was
   pushed, on `origin`. Merged branches are litter; this is the same rule the loop skill
   applies to its own `kando-loop/*` branches.
2. **`npm test` and `npm run typecheck` green first.** The publish workflow runs them
   again on three OSes, but finding it there costs a burnt tag.
3. **`npm version patch|minor -m "chore: release v%s"`** on `main`. It bumps
   `package.json` + `package-lock.json`, makes the `chore: release vX.Y.Z` commit, and
   creates the tag in one step — do not hand-roll those three.
   - **minor** — the server gains tool surface, or a shipped skill/agent gains a
     capability it did not have.
   - **patch** — fixes, and instruction changes that sharpen behavior already shipped.
4. **`git push origin main && git push origin vX.Y.Z`.** Both. A tag pushed without its
   branch, or a branch without its tag, is a half-release.
5. **Watch the run: `gh run list --workflow publish.yml --limit 1`.** It is not released
   until that is green.

**The tag push is the irreversible act.** It fires `.github/workflows/publish.yml`, which
runs typecheck/test/build on ubuntu + windows + macOS and then `npm publish` — public,
and not meaningfully undoable. Get the human's go-ahead before pushing a tag, and confirm
the version number with them rather than assuming patch. Everything before the tag push
is local and cheap to redo; nothing after it is.

**`files` in `package.json` is what actually ships** — `dist`, `skills`, `agents`,
`commands`, `assets`, `kando.config.json`, `README.md`, `LICENSE`. A change confined to
anything else (this file, `docs/`, tests, CI config) alters no published artifact. Say so
and let the human decide whether it earns a version of its own; do not publish an
identical tarball on autopilot, and do not quietly skip a release for a change that *does*
touch the list.
