import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOP_AUTH_MARKER = '## Kando autonomous loop — deploy authorization';
const LOOP_AUTH_BLOCK = `${LOOP_AUTH_MARKER}

The \`/kando-loop\` command runs an autonomous work loop that **spawns worker and reviewer subagents** (the Agent/Task tool) and lets them **commit and push to a \`kando-loop/*\` branch**, and lets the loop **merge that branch to this repo's base branch — whatever it is called (\`main\`, \`master\`, …) — and trigger the deploy** once a batch of tickets is worth shipping — that is its intended, sanctioned flow. The coordinator, not a worker, is what touches the base branch. Do not gate the loop's subagent dispatch, its branch pushes, or its deploys behind asking. (Added by the Kando MCP installer so /kando-loop runs under auto mode; delete this section to withdraw the authorization.)`;

/**
 * Ensure a repo's CLAUDE.md carries the CURRENT loop deploy-authorization section.
 *
 * Replaces a stale block rather than skipping it: the marker is stable across
 * versions, so a repo installed by an older `init` would otherwise keep wording that
 * authorizes something the loop no longer does — and re-running `init`, the obvious
 * fix, would silently do nothing. Idempotent: re-running on a current block
 * reproduces it byte for byte.
 *
 * The block ends at the next top-level `## ` heading, which is how the installer has
 * always written it — a leaf section. A hand-edited block carrying `###` subsections
 * of its own would lose them, and that is the intended trade: the block is ours.
 */
export function ensureLoopAuthorization(text: string): string {
  const src = text ?? '';
  const at = src.indexOf(LOOP_AUTH_MARKER);
  if (at === -1) {
    const base = src.trimEnd();
    return (base ? base + '\n\n' : '') + LOOP_AUTH_BLOCK + '\n';
  }
  const rest = src.slice(at + LOOP_AUTH_MARKER.length);
  const nextHeading = rest.search(/\n## /);
  const before = src.slice(0, at).trimEnd();
  const after = nextHeading === -1 ? '' : rest.slice(nextHeading + 1);
  return (before ? before + '\n\n' : '') + LOOP_AUTH_BLOCK + '\n' + (after ? '\n' + after : '');
}

/**
 * The Kando tools the autonomous loop actually calls, pre-granted so an unattended run
 * cannot stall on a permission prompt — a wait that emits nothing, which is the exact
 * failure mode the loop's liveness design exists to remove.
 *
 * Destructive tools are deliberately absent. `delete_ticket` is permanent, and
 * `delete_tag` / `delete_release` strip from every item on the board; a run with standing
 * authorization to push should not be one stray instruction away from any of them. The
 * shipped `kando-worker` agent also withholds them, so this list is the second of two
 * independent barriers rather than the only one.
 *
 * `edit_comment` and `delete_comment` are absent for a related reason: the comment thread
 * is the loop's record of what was planned and what the reviewer found, and a record the
 * run can rewrite is worth less than one it can only append to.
 */
export const LOOP_TOOL_PERMISSIONS = [
  'mcp__kando__list_boards',
  'mcp__kando__get_board',
  'mcp__kando__get_ticket',
  'mcp__kando__search_tickets',
  'mcp__kando__next_task',
  'mcp__kando__ensure_tag',
  'mcp__kando__update_ticket',
  'mcp__kando__move_ticket',
  'mcp__kando__create_story',
  'mcp__kando__create_subtask',
  'mcp__kando__list_comments',
  'mcp__kando__add_comment',
];

/** Add tool permissions to settings.permissions.allow. Idempotent; preserves everything else. */
export function ensureToolPermissions(settings: any, tools: string[]): any {
  const out = settings && typeof settings === 'object' ? { ...settings } : {};
  const permissions = { ...(out.permissions ?? {}) };
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
  for (const tool of tools) if (!allow.includes(tool)) allow.push(tool);
  permissions.allow = allow;
  out.permissions = permissions;
  return out;
}

/** Destination repo-relative paths for a set of skill + command + agent source files (used in tests). */
export function relTargets(skillFiles: string[], commandFiles: string[], agentFiles: string[] = []) {
  return {
    skills: skillFiles.map((f) => `.claude/skills/${f}`),
    commands: commandFiles.map((f) => `.claude/commands/${f}`),
    agents: agentFiles.map((f) => `.claude/agents/${f}`),
  };
}

/** Recursively copy a directory's files into destDir (skipping .gitkeep). No-op if srcDir is absent. */
export function copyTree(srcDir: string, destDir: string): void {
  if (!existsSync(srcDir)) return;
  for (const entry of readdirSync(srcDir)) {
    if (entry === '.gitkeep') continue;
    const src = join(srcDir, entry);
    const dest = join(destDir, entry);
    if (statSync(src).isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyTree(src, dest);
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  }
}

export function mergeMcpJson(existing: any, serverEntry: any): any {
  const out = existing && typeof existing === 'object' ? { ...existing } : {};
  out.mcpServers = { ...(out.mcpServers ?? {}) };
  out.mcpServers.kando = serverEntry;
  return out;
}

export function ensureGitignore(text: string, entry: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  if (lines.includes(entry)) return text;
  const base = text.endsWith('\n') || text === '' ? text : text + '\n';
  return base + entry + '\n';
}

/** Remove every line that exactly matches `entry` (used to migrate an old ignore rule). */
export function removeGitignoreLine(text: string, entry: string): string {
  return text
    .split('\n')
    .filter((l) => l.trim() !== entry)
    .join('\n');
}

/**
 * Approve a project MCP server so a new session auto-loads it. Adds to
 * `enabledMcpjsonServers` (dedup) and removes the name from
 * `disabledMcpjsonServers` if it was previously rejected.
 */
export function enableMcpServer(existing: any, name: string): any {
  const out = existing && typeof existing === 'object' ? { ...existing } : {};
  const enabled = Array.isArray(out.enabledMcpjsonServers) ? [...out.enabledMcpjsonServers] : [];
  if (!enabled.includes(name)) enabled.push(name);
  out.enabledMcpjsonServers = enabled;
  if (Array.isArray(out.disabledMcpjsonServers)) {
    out.disabledMcpjsonServers = out.disabledMcpjsonServers.filter((s: string) => s !== name);
  }
  return out;
}

/**
 * Ensure the Kando UserPromptSubmit workflow hook is present with the given
 * command. Idempotent AND migrating: any prior hook whose command references
 * `kando-workflow` (the old bash `.sh` OR the new Node `.mjs`) is removed and
 * replaced, so re-running never duplicates and old installs get upgraded.
 * Non-Kando hooks are preserved.
 */
export function ensureWorkflowHook(settings: any, command: string): any {
  const out = settings && typeof settings === 'object' ? { ...settings } : {};
  const hooks = { ...(out.hooks ?? {}) };
  const list = ((Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []) as any[])
    .map((e) => ({
      ...e,
      hooks: (e.hooks ?? []).filter(
        (h: any) => !String(h.command ?? '').includes('kando-workflow'),
      ),
    }))
    .filter((e) => (e.hooks ?? []).length > 0);
  list.push({ hooks: [{ type: 'command', command }] });
  hooks.UserPromptSubmit = list;
  out.hooks = hooks;
  return out;
}

/** The `.mcp.json` server entry: `npx -y kando-mcp serve`, wrapped in `cmd /c` on Windows. */
export function mcpServerEntry(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  const base = ['-y', 'kando-mcp', 'serve'];
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'npx', ...base] }
    : { command: 'npx', args: base };
}

function readJson(p: string): any {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
function readText(p: string): string {
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/**
 * Wire the Kando MCP into a target repo (cross-platform, pure Node):
 * `.mcp.json` → `npx kando-mcp serve`, skills/commands/agents into `.claude/`, the Node
 * workflow hook, settings approval + hook registration + loop tool permissions,
 * CLAUDE.md loop-auth, and
 * `.gitignore` for the personal settings file. `init` also runs legacy cleanup
 * (see cleanupLegacy in this module).
 */
export function init(targetDir: string): void {
  const target = resolve(targetDir);
  if (!existsSync(join(target, '.git'))) throw new Error(`${target} is not a git repo`);
  const pkgRoot = dirname(fileURLToPath(import.meta.url)); // src/ (dev) or dist/ (built)

  // 1) .mcp.json → npx kando-mcp serve
  const mcpJsonPath = join(target, '.mcp.json');
  writeFileSync(mcpJsonPath, JSON.stringify(mergeMcpJson(readJson(mcpJsonPath), mcpServerEntry()), null, 2) + '\n');

  // 2) skills + commands + agents (shipped in the package)
  copyTree(join(pkgRoot, '..', 'skills'), join(target, '.claude', 'skills'));
  copyTree(join(pkgRoot, '..', 'commands'), join(target, '.claude', 'commands'));
  copyTree(join(pkgRoot, '..', 'agents'), join(target, '.claude', 'agents'));

  // 3) Node workflow hook (shipped asset), invoked via `node`
  const hooksDir = join(target, '.claude', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookDest = join(hooksDir, 'kando-workflow.mjs');
  copyFileSync(join(pkgRoot, '..', 'assets', 'kando-workflow.mjs'), hookDest);
  // The loop's verification waiter. Not a hook — the coordinator runs it under
  // Monitor — but it lives here so `init` ships it with the hook it sits beside.
  copyFileSync(
    join(pkgRoot, '..', 'assets', 'kando-verify-wait.mjs'),
    join(hooksDir, 'kando-verify-wait.mjs'),
  );
  // $CLAUDE_PROJECT_DIR is set by Claude Code for hooks. NOTE: the POSIX form is
  // verified; Windows hook-shell expansion is the A15 real-Windows decision point.
  const hookCmd = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/kando-workflow.mjs"`;

  // 4) settings.local.json — approve the server + register the hook
  const settingsPath = join(target, '.claude', 'settings.local.json');
  let settings = enableMcpServer(readJson(settingsPath), 'kando');
  settings = ensureWorkflowHook(settings, hookCmd);
  settings = ensureToolPermissions(settings, LOOP_TOOL_PERMISSIONS);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // 5) CLAUDE.md loop-auth
  const claudeMdPath = join(target, 'CLAUDE.md');
  const before = readText(claudeMdPath);
  const after = ensureLoopAuthorization(before);
  if (after !== before) writeFileSync(claudeMdPath, after);

  // 6) .gitignore — ignore the personal settings file
  const giPath = join(target, '.gitignore');
  writeFileSync(giPath, ensureGitignore(readText(giPath), '.claude/settings.local.json'));

  // 7) remove stale artifacts from the old bundle-in-repo (bot credentials) model
  cleanupLegacy(target);
}

/**
 * Remove the dead per-repo artifacts of the old shared-bot install model:
 * `.kando/.env` (+ example), the legacy `credentials` file, the vendored
 * `.kando/mcp/` bundle, and the bash `.kando/hooks/kando-workflow.sh`. Removes
 * the now-empty `.kando/`, and strips the `.kando/.env` line from `.gitignore`.
 * A stale `.env` holding the old shared bot password must not linger. Returns
 * the repo-relative paths removed (for logging). No-op when there's no `.kando/`.
 */
export function cleanupLegacy(target: string): string[] {
  const removed: string[] = [];
  const rmIf = (rel: string, recursive = false): void => {
    const p = join(target, rel);
    if (existsSync(p)) {
      rmSync(p, { recursive, force: true });
      removed.push(rel);
    }
  };
  rmIf('.kando/.env');
  rmIf('.kando/.env.example');
  rmIf('.kando/credentials');
  rmIf('.kando/mcp', true);
  rmIf('.kando/hooks/kando-workflow.sh');

  const hooks = join(target, '.kando', 'hooks');
  if (existsSync(hooks) && readdirSync(hooks).length === 0) rmSync(hooks, { recursive: true, force: true });
  const kando = join(target, '.kando');
  if (existsSync(kando) && readdirSync(kando).length === 0) {
    rmSync(kando, { recursive: true, force: true });
    removed.push('.kando/');
  }

  const giPath = join(target, '.gitignore');
  if (existsSync(giPath)) {
    const gi = readFileSync(giPath, 'utf8');
    const cleaned = removeGitignoreLine(gi, '.kando/.env');
    if (cleaned !== gi) writeFileSync(giPath, cleaned);
  }
  return removed;
}
