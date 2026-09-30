import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeMcpJson,
  ensureGitignore,
  removeGitignoreLine,
  enableMcpServer,
  ensureWorkflowHook,
  ensureToolPermissions,
  LOOP_TOOL_PERMISSIONS,
  ensureLoopAuthorization,
  relTargets,
  mcpServerEntry,
  cleanupLegacy,
  gitWorkTreeRoot,
  init,
  readInstalledVersion,
  compareVersions,
  writeTracked,
  formatInitReport,
  type InitReport,
} from './init.js';
import { parseInitArgs } from './cli.js';
import { statSync, readdirSync } from 'node:fs';

describe('mcpServerEntry', () => {
  it('uses plain npx on posix', () => {
    expect(mcpServerEntry('linux')).toEqual({ command: 'npx', args: ['-y', 'kando-mcp', 'serve'] });
    expect(mcpServerEntry('darwin')).toEqual({ command: 'npx', args: ['-y', 'kando-mcp', 'serve'] });
  });
  it('wraps in cmd /c on windows', () => {
    expect(mcpServerEntry('win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'kando-mcp', 'serve'],
    });
  });
});

describe('ensureToolPermissions', () => {
  it('adds the given tools to permissions.allow', () => {
    const out = ensureToolPermissions({}, ['mcp__kando__get_ticket', 'mcp__kando__move_ticket']);
    expect(out.permissions.allow).toEqual(['mcp__kando__get_ticket', 'mcp__kando__move_ticket']);
  });

  it('preserves unrelated entries already in the allow list', () => {
    const out = ensureToolPermissions(
      { permissions: { allow: ['Bash(npm test)'], deny: ['Bash(rm:*)'] } },
      ['mcp__kando__get_ticket'],
    );
    expect(out.permissions.allow).toEqual(['Bash(npm test)', 'mcp__kando__get_ticket']);
    expect(out.permissions.deny).toEqual(['Bash(rm:*)']);
  });

  it('is idempotent', () => {
    const once = ensureToolPermissions({}, ['mcp__kando__get_ticket']);
    expect(ensureToolPermissions(once, ['mcp__kando__get_ticket'])).toEqual(once);
  });

  it('never pre-grants a destructive tool', () => {
    // The loop runs unattended with standing push authorization. Granting these by
    // default would put a permanent delete one stray instruction away. The comment
    // pair is here for a second reason: the record of what was planned and what a
    // reviewer found is append-only, so nothing in the loop may rewrite it.
    for (const forbidden of [
      'delete_ticket',
      'delete_tag',
      'delete_release',
      'archive_ticket',
      'delete_comment',
      'edit_comment',
    ]) {
      expect(LOOP_TOOL_PERMISSIONS).not.toContain(`mcp__kando__${forbidden}`);
    }
  });

  it('pre-grants the comment tools every ticket goes through', () => {
    // Worker writes `plan` and `done`, reviewer writes `review · pass N`, both read
    // the thread back. A prompt on the first comment is a silent wait in an
    // unattended run — the exact failure the pre-grant list exists to remove.
    expect(LOOP_TOOL_PERMISSIONS).toContain('mcp__kando__add_comment');
    expect(LOOP_TOOL_PERMISSIONS).toContain('mcp__kando__list_comments');
  });
});

describe('ensureLoopAuthorization', () => {
  it('appends the authorization section to an existing CLAUDE.md', () => {
    const out = ensureLoopAuthorization('# My Project\n\nSome rules.\n');
    expect(out).toContain('# My Project');
    expect(out).toContain('Kando autonomous loop — deploy authorization');
    expect(out).toMatch(/spawns worker and reviewer subagents/);
  });
  it('is idempotent', () => {
    const once = ensureLoopAuthorization('# P\n');
    expect(ensureLoopAuthorization(once)).toBe(once);
  });
  it('creates content when there is no CLAUDE.md yet', () => {
    const out = ensureLoopAuthorization('');
    expect(out.startsWith('## Kando')).toBe(true);
  });

  it('replaces a stale block rather than leaving it', () => {
    // A repo installed before batched deploys carries the old wording. Re-running
    // init must refresh it, or the repo authorizes something the loop no longer does.
    const stale =
      '# P\n\n## Kando autonomous loop — deploy authorization\n\nOld wording: subagents push to `main`.\n';
    const out = ensureLoopAuthorization(stale);
    expect(out).toContain('# P');
    expect(out).not.toContain('Old wording');
    expect(out).toContain('kando-loop/*');
    expect((out.match(/## Kando autonomous loop — deploy authorization/g) ?? []).length).toBe(1);
  });

  it('preserves sections that follow the block when replacing', () => {
    const stale =
      '# P\n\n## Kando autonomous loop — deploy authorization\n\nOld wording.\n\n## My own rules\n\nKeep me.\n';
    const out = ensureLoopAuthorization(stale);
    expect(out).toContain('## My own rules');
    expect(out).toContain('Keep me.');
    expect(out).not.toContain('Old wording');
  });

  it('says the coordinator owns the base branch and workers stay on the loop branch', () => {
    const out = ensureLoopAuthorization('');
    expect(out).toContain('kando-loop/*');
    expect(out).toMatch(/coordinator, not a worker, is what touches/);
  });

  it('names the base branch generically, not `main`', () => {
    // A repo that ships from `master` gets this block too. Authorizing a merge to
    // `main` by name reads as "not my branch" there — the loop then stops to ask.
    const out = ensureLoopAuthorization('');
    expect(out).toContain('base branch');
    expect(out).not.toMatch(/merge that branch to `main`/);
  });
});

describe('relTargets', () => {
  it('lists skill + command destination paths', () => {
    const out = relTargets(['kando/SKILL.md'], ['kando-loop.md']);
    expect(out.skills).toEqual(['.claude/skills/kando/SKILL.md']);
    expect(out.commands).toEqual(['.claude/commands/kando-loop.md']);
  });
  it('lists agent destination paths', () => {
    const out = relTargets(['kando/SKILL.md'], ['kando-loop.md'], ['kando-reviewer.md']);
    expect(out.agents).toEqual(['.claude/agents/kando-reviewer.md']);
  });
  it('defaults agents to empty when none are given', () => {
    expect(relTargets(['kando/SKILL.md'], ['kando-loop.md']).agents).toEqual([]);
  });
});

describe('mergeMcpJson', () => {
  it('adds the kando server, preserving others', () => {
    const out = mergeMcpJson({ mcpServers: { other: { command: 'x' } } }, mcpServerEntry('linux'));
    expect(out.mcpServers.other).toEqual({ command: 'x' });
    expect(out.mcpServers.kando).toEqual({ command: 'npx', args: ['-y', 'kando-mcp', 'serve'] });
  });
  it('creates the structure when none exists', () => {
    const out = mergeMcpJson(null, { command: 'npx', args: ['a'] });
    expect(out.mcpServers.kando.args).toEqual(['a']);
  });
});

describe('ensureGitignore / removeGitignoreLine', () => {
  it('appends once and is idempotent', () => {
    expect(ensureGitignore('node_modules\n', '.claude/settings.local.json')).toBe(
      'node_modules\n.claude/settings.local.json\n',
    );
    expect(ensureGitignore('a\n.claude/settings.local.json\n', '.claude/settings.local.json')).toBe(
      'a\n.claude/settings.local.json\n',
    );
  });
  it('removes an exact-match line, keeps others', () => {
    expect(removeGitignoreLine('node_modules\n.kando/\ndist\n', '.kando/')).toBe('node_modules\ndist\n');
  });
});

describe('enableMcpServer', () => {
  it('approves the server when no settings exist', () => {
    expect(enableMcpServer(null, 'kando')).toEqual({ enabledMcpjsonServers: ['kando'] });
  });
  it('dedups and un-disables', () => {
    const out = enableMcpServer({ disabledMcpjsonServers: ['kando', 'other'] }, 'kando');
    expect(out.enabledMcpjsonServers).toEqual(['kando']);
    expect(out.disabledMcpjsonServers).toEqual(['other']);
  });
});

describe('ensureWorkflowHook', () => {
  const cmd = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/kando-workflow.mjs"';
  const cmds = (out: any) =>
    out.hooks.UserPromptSubmit.flatMap((e: any) => e.hooks.map((h: any) => h.command));

  it('adds a UserPromptSubmit command hook when none exists', () => {
    const out = ensureWorkflowHook(null, cmd);
    expect(out.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: cmd }] }]);
  });
  it('migrates the OLD bash .sh hook to the new .mjs command (no duplicate)', () => {
    const stale = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.kando/hooks/kando-workflow.sh"' }] },
        ],
      },
    };
    expect(cmds(ensureWorkflowHook(stale, cmd))).toEqual([cmd]);
  });
  it('preserves non-Kando hooks', () => {
    const existing = {
      hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'x' }] }] },
    };
    const out = ensureWorkflowHook(existing, cmd);
    expect(out.hooks.PostToolUse).toEqual(existing.hooks.PostToolUse);
    expect(out.hooks.UserPromptSubmit[0].hooks[0].command).toBe(cmd);
  });
});

describe('init (integration)', () => {
  it('wires .mcp.json, skills/commands, the Node hook, settings, CLAUDE.md, gitignore', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kando-init-'));
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# Repo\n');
    init(dir);

    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.kando).toEqual(mcpServerEntry());

    expect(existsSync(join(dir, '.claude', 'skills', 'kando', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'agents', 'kando-reviewer.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'agents', 'kando-worker.md'))).toBe(true);
    const written = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
    expect(written.permissions.allow).toContain('mcp__kando__update_ticket');
    expect(written.permissions.allow).not.toContain('mcp__kando__delete_ticket');
    expect(existsSync(join(dir, '.claude', 'commands', 'kando-loop.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'hooks', 'kando-workflow.mjs'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'hooks', 'kando-verify-wait.mjs'))).toBe(true);

    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.enabledMcpjsonServers).toContain('kando');
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('kando-workflow.mjs');

    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('deploy authorization');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.claude/settings.local.json');
  });

  it('installs into a plain directory with no git anywhere above it', () => {
    // A Claude project dir is wherever you run the agent. Git is a `/kando-loop`
    // requirement, not an install-time one, and the server never shells out to it.
    const dir = mkdtempSync(join(tmpdir(), 'kando-init-nogit-'));
    init(dir);

    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'skills', 'kando', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(true);
    // Nothing to ignore when nothing tracks the directory.
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  it('installs into a subdirectory of a git repo (monorepo package)', () => {
    const root = mkdtempSync(join(tmpdir(), 'kando-init-mono-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    const pkg = join(root, 'packages', 'api');
    mkdirSync(pkg, { recursive: true });

    init(pkg);

    expect(existsSync(join(pkg, '.claude', 'skills', 'kando', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(pkg, '.mcp.json'))).toBe(true);
    // The entry goes in the package's OWN .gitignore: `.claude/settings.local.json`
    // is an anchored pattern, so from the repo root it would not match here.
    expect(readFileSync(join(pkg, '.gitignore'), 'utf8')).toContain('.claude/settings.local.json');
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    // The install is scoped to the package, never scattered up to the repo root.
    expect(existsSync(join(root, '.claude'))).toBe(false);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
  });

  it('throws a clear error when the target directory does not exist', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'kando-init-gone-')), 'nope');
    expect(() => init(missing)).toThrow(/does not exist/);
  });
});

describe('gitWorkTreeRoot', () => {
  it('finds the root from a nested subdirectory', () => {
    const root = mkdtempSync(join(tmpdir(), 'kando-wt-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    expect(gitWorkTreeRoot(deep)).toBe(root);
  });

  it('accepts a .git FILE — a worktree or submodule checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kando-wt-file-'));
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    expect(gitWorkTreeRoot(dir)).toBe(dir);
  });

  it('returns null when no ancestor is a work tree', () => {
    expect(gitWorkTreeRoot(mkdtempSync(join(tmpdir(), 'kando-wt-none-')))).toBe(null);
  });
});

describe('cleanupLegacy', () => {
  it('removes legacy .kando credential + bundle + bash-hook artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kando-cleanup-'));
    mkdirSync(join(dir, '.kando', 'mcp'), { recursive: true });
    mkdirSync(join(dir, '.kando', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.kando', '.env'), 'KANDO_BOT_PASSWORD=secret');
    writeFileSync(join(dir, '.kando', '.env.example'), 'x');
    writeFileSync(join(dir, '.kando', 'mcp', 'server.mjs'), 'x');
    writeFileSync(join(dir, '.kando', 'hooks', 'kando-workflow.sh'), 'x');
    writeFileSync(join(dir, '.gitignore'), '.kando/.env\nnode_modules/\n');

    const removed = cleanupLegacy(dir);

    expect(existsSync(join(dir, '.kando'))).toBe(false);
    expect(removed).toContain('.kando/.env');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).not.toContain('.kando/.env');
  });

  it('is a no-op when there is no .kando/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kando-cleanup-none-'));
    expect(cleanupLegacy(dir)).toEqual([]);
  });
});

const CUR = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version as string;
const tmp = (n: string) => mkdtempSync(join(tmpdir(), `kando-${n}-`));
const setMarker = (dir: string, v: unknown) => {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'kando.json'), typeof v === 'string' ? v : JSON.stringify(v));
};
function listAll(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) Object.assign(out, listAll(p, base));
    else out[p.slice(base.length)] = readFileSync(p, 'utf8');
  }
  return out;
}

describe('compareVersions', () => {
  it('compares numerically', () => {
    expect(compareVersions('0.14.10', '0.14.9')).toBeGreaterThan(0);
    expect(compareVersions('0.14.9', '0.14.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('99.0.0', '0.14.3')).toBeGreaterThan(0);
  });
});

describe('readInstalledVersion', () => {
  it('fresh when nothing is there', () => {
    expect(readInstalledVersion(tmp('rv-fresh'))).toEqual({ kind: 'fresh' });
  });
  it('installed when the marker is readable', () => {
    const d = tmp('rv-inst');
    setMarker(d, { version: '0.14.1' });
    expect(readInstalledVersion(d)).toEqual({ kind: 'installed', version: '0.14.1' });
  });
  it('legacy when .mcp.json has a kando server and no marker', () => {
    const d = tmp('rv-mcp');
    writeFileSync(join(d, '.mcp.json'), JSON.stringify({ mcpServers: { kando: {} } }));
    expect(readInstalledVersion(d)).toEqual({ kind: 'legacy' });
  });
  it('legacy when only .claude/skills/kando/ exists', () => {
    const d = tmp('rv-skill');
    mkdirSync(join(d, '.claude', 'skills', 'kando'), { recursive: true });
    expect(readInstalledVersion(d)).toEqual({ kind: 'legacy' });
  });
  it('fresh when .mcp.json has other servers only', () => {
    const d = tmp('rv-other');
    writeFileSync(join(d, '.mcp.json'), JSON.stringify({ mcpServers: { other: {} } }));
    expect(readInstalledVersion(d)).toEqual({ kind: 'fresh' });
  });
  it.each([['not json {'], [JSON.stringify({})], [JSON.stringify({ version: 'latest' })], [JSON.stringify({ version: '1.2' })]])(
    'legacy (never a crash) for a bad marker %s',
    (raw) => {
      const d = tmp('rv-bad');
      setMarker(d, raw);
      expect(readInstalledVersion(d)).toEqual({ kind: 'legacy' });
    },
  );
});

describe('writeTracked', () => {
  it('added / updated / unchanged, and does not write when unchanged', () => {
    const d = tmp('wt');
    const f = join(d, 'sub', 'a.txt');
    expect(writeTracked(f, 'one')).toBe('added');
    const m = statSync(f).mtimeMs;
    expect(writeTracked(f, 'one')).toBe('unchanged');
    expect(statSync(f).mtimeMs).toBe(m);
    expect(writeTracked(f, 'two')).toBe('updated');
    expect(readFileSync(f, 'utf8')).toBe('two');
  });
});

describe('init report + scenarios', () => {
  it('fresh install: adds everything and writes the marker', () => {
    const d = tmp('sc-fresh');
    const r = init(d);
    expect(r.previous).toEqual({ kind: 'fresh' });
    expect(r.current).toBe(CUR);
    expect(r.changes.length).toBeGreaterThan(0);
    expect(r.changes.every((c) => c.status === 'added')).toBe(true);
    expect(r.changes.map((c) => c.path)).toContain('.claude/kando.json');
    expect(JSON.parse(readFileSync(join(d, '.claude', 'kando.json'), 'utf8'))).toEqual({ version: CUR });
    expect(formatInitReport(r, { verbose: false })).toContain(`Fresh install: v${CUR}`);
  });

  it('second init: all unchanged, no mtime changes', async () => {
    const d = tmp('sc-again');
    init(d);
    const before = Object.fromEntries(Object.keys(listAll(d)).map((k) => [k, statSync(join(d, k)).mtimeMs]));
    await new Promise((r) => setTimeout(r, 20));
    const r = init(d);
    expect(r.previous).toEqual({ kind: 'installed', version: CUR });
    expect(r.changes.every((c) => c.status === 'unchanged')).toBe(true);
    for (const k of Object.keys(before)) expect(statSync(join(d, k)).mtimeMs).toBe(before[k]);
    const out = formatInitReport(r, { verbose: false });
    expect(out).toContain(`Reinstall: v${CUR} (already current)`);
    expect(out).toContain('Already up to date — nothing changed.');
  });

  it('legacy install (kando in .mcp.json, no marker): unknown version update, marker created', () => {
    const d = tmp('sc-legacy');
    writeFileSync(join(d, '.mcp.json'), JSON.stringify({ mcpServers: { kando: { command: 'x' } } }));
    const r = init(d);
    expect(formatInitReport(r, { verbose: false })).toContain(`Update: unknown version → v${CUR}`);
    expect(existsSync(join(d, '.claude', 'kando.json'))).toBe(true);
  });

  it('older marker + locally edited skill file: update, file updated, marker bumped', () => {
    const d = tmp('sc-old');
    init(d);
    setMarker(d, { version: '0.0.1' });
    writeFileSync(join(d, '.claude', 'skills', 'kando', 'SKILL.md'), 'edited');
    const r = init(d);
    expect(r.changes).toContainEqual({ path: '.claude/skills/kando/SKILL.md', status: 'updated' });
    expect(formatInitReport(r, { verbose: false })).toContain(`Update: v0.0.1 → v${CUR}`);
    expect(JSON.parse(readFileSync(join(d, '.claude', 'kando.json'), 'utf8')).version).toBe(CUR);
  });

  it('newer marker without force: throws and touches nothing (even legacy cleanup)', () => {
    const d = tmp('sc-down');
    setMarker(d, { version: '99.0.0' });
    mkdirSync(join(d, '.kando'), { recursive: true });
    writeFileSync(join(d, '.kando', '.env'), 'secret');
    const snap = listAll(d);
    expect(() => init(d)).toThrow(
      `Installed kando v99.0.0 is newer than this init (v${CUR}) — likely a stale npx cache. Try: npx kando-mcp@latest init. To downgrade anyway, re-run with --force.`,
    );
    expect(listAll(d)).toEqual(snap);
  });

  it('newer marker with force: runs as a labelled downgrade', () => {
    const d = tmp('sc-force');
    setMarker(d, { version: '99.0.0' });
    const r = init(d, { force: true });
    expect(formatInitReport(r, { verbose: false })).toContain(`Downgrade: v99.0.0 → v${CUR} (--force)`);
    expect(JSON.parse(readFileSync(join(d, '.claude', 'kando.json'), 'utf8')).version).toBe(CUR);
  });

  it('reports legacy cleanup as removed', () => {
    const d = tmp('sc-rm');
    mkdirSync(join(d, '.kando'), { recursive: true });
    writeFileSync(join(d, '.kando', '.env'), 'secret');
    const r = init(d);
    expect(r.changes).toContainEqual({ path: '.kando/.env', status: 'removed' });
    expect(formatInitReport(r, { verbose: false })).toContain('  removed    .kando/.env (legacy)');
  });
});

describe('formatInitReport', () => {
  const base = (over: Partial<InitReport>): InitReport => ({
    previous: { kind: 'fresh' },
    current: '1.2.3',
    target: '/abs/t',
    changes: [],
    ...over,
  });
  it('header line', () => {
    expect(formatInitReport(base({}), { verbose: false }).split('\n')[0]).toBe('kando-mcp init v1.2.3 → /abs/t');
  });
  it('all five line-2 variants', () => {
    const l2 = (p: InitReport['previous']) => formatInitReport(base({ previous: p }), { verbose: false }).split('\n')[1];
    expect(l2({ kind: 'fresh' })).toBe('Fresh install: v1.2.3');
    expect(l2({ kind: 'installed', version: '1.0.0' })).toBe('Update: v1.0.0 → v1.2.3');
    expect(l2({ kind: 'legacy' })).toBe('Update: unknown version → v1.2.3');
    expect(l2({ kind: 'installed', version: '1.2.3' })).toBe('Reinstall: v1.2.3 (already current)');
    expect(l2({ kind: 'installed', version: '2.0.0' })).toBe('Downgrade: v2.0.0 → v1.2.3 (--force)');
  });
  const changes = [
    { path: 'a', status: 'added' as const },
    { path: 'b', status: 'updated' as const },
    { path: 'c', status: 'removed' as const },
    { path: 'd', status: 'unchanged' as const },
    { path: 'e', status: 'unchanged' as const },
  ];
  it('per-file lines and unchanged count', () => {
    const out = formatInitReport(base({ previous: { kind: 'legacy' }, changes }), { verbose: false });
    expect(out).toContain('  added      a');
    expect(out).toContain('  updated    b');
    expect(out).toContain('  removed    c (legacy)');
    expect(out).toContain('  unchanged  2 files');
    expect(out).not.toContain('  unchanged  d');
    expect(out.trimEnd().split('\n').pop()).toBe('✓ Restart Claude Code to pick up the changes.');
  });
  it('verbose lists unchanged files', () => {
    const out = formatInitReport(base({ changes }), { verbose: true });
    expect(out).toContain('  unchanged  d');
    expect(out).toContain('  unchanged  e');
    expect(out).not.toContain('unchanged  2 files');
  });
  it('up-to-date final line; fresh adds the login hint', () => {
    const same = formatInitReport(
      base({ previous: { kind: 'installed', version: '1.2.3' }, changes: [{ path: 'd', status: 'unchanged' }] }),
      { verbose: false },
    );
    expect(same.trimEnd().split('\n').pop()).toBe('✓ Already up to date — nothing changed.');
    const fresh = formatInitReport(base({ changes: [{ path: 'a', status: 'added' }] }), { verbose: false });
    expect(fresh).toContain('Then run `kando-mcp login` if you have not.');
  });
});

describe('parseInitArgs', () => {
  it('flags in any position, dir is first non-flag', () => {
    expect(parseInitArgs([])).toEqual({ dir: '.', force: false, verbose: false });
    expect(parseInitArgs(['--force', 'x', '--verbose'])).toEqual({ dir: 'x', force: true, verbose: true });
    expect(parseInitArgs(['x', '--verbose'])).toEqual({ dir: 'x', force: false, verbose: true });
  });
});
