import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOP_AUTH_MARKER = '## Kando autonomous loop — deploy authorization';
const LOOP_AUTH_BLOCK = `${LOOP_AUTH_MARKER}

The \`/kando-loop\` command runs an autonomous work loop that **spawns worker and reviewer subagents** (the Agent/Task tool) and lets those subagents **commit, push to \`main\`, and trigger the deploy** for the tickets it works — that is its intended, sanctioned flow. Do not gate the loop's subagent dispatch or its deploys behind asking. (Added by the Kando MCP installer so /kando-loop runs under auto mode; delete this section to withdraw the authorization.)`;

/**
 * Ensure a repo's CLAUDE.md carries the loop deploy-authorization section.
 * Idempotent: a no-op if the section is already present.
 */
export function ensureLoopAuthorization(text: string): string {
  if ((text ?? '').includes(LOOP_AUTH_MARKER)) return text;
  const base = (text ?? '').trimEnd();
  return (base ? base + '\n\n' : '') + LOOP_AUTH_BLOCK + '\n';
}

/** Destination repo-relative paths for a set of skill + command source files (used in tests). */
export function relTargets(skillFiles: string[], commandFiles: string[]) {
  return {
    skills: skillFiles.map((f) => `.claude/skills/${f}`),
    commands: commandFiles.map((f) => `.claude/commands/${f}`),
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
 * `.mcp.json` → `npx kando-mcp serve`, skills/commands into `.claude/`, the Node
 * workflow hook, settings approval + hook registration, CLAUDE.md loop-auth, and
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

  // 2) skills + commands (shipped in the package)
  copyTree(join(pkgRoot, '..', 'skills'), join(target, '.claude', 'skills'));
  copyTree(join(pkgRoot, '..', 'commands'), join(target, '.claude', 'commands'));

  // 3) Node workflow hook (shipped asset), invoked via `node`
  const hookDest = join(target, '.claude', 'hooks', 'kando-workflow.mjs');
  mkdirSync(dirname(hookDest), { recursive: true });
  copyFileSync(join(pkgRoot, '..', 'assets', 'kando-workflow.mjs'), hookDest);
  // $CLAUDE_PROJECT_DIR is set by Claude Code for hooks. NOTE: the POSIX form is
  // verified; Windows hook-shell expansion is the A15 real-Windows decision point.
  const hookCmd = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/kando-workflow.mjs"`;

  // 4) settings.local.json — approve the server + register the hook
  const settingsPath = join(target, '.claude', 'settings.local.json');
  let settings = enableMcpServer(readJson(settingsPath), 'kando');
  settings = ensureWorkflowHook(settings, hookCmd);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // 5) CLAUDE.md loop-auth
  const claudeMdPath = join(target, 'CLAUDE.md');
  const before = readText(claudeMdPath);
  const after = ensureLoopAuthorization(before);
  if (after !== before) writeFileSync(claudeMdPath, after);

  // 6) .gitignore — ignore the personal settings file
  const giPath = join(target, '.gitignore');
  writeFileSync(giPath, ensureGitignore(readText(giPath), '.claude/settings.local.json'));

  // 7) legacy cleanup is wired in by Task A11 (cleanupLegacy).
}
