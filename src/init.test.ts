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
  ensureLoopAuthorization,
  relTargets,
  mcpServerEntry,
  cleanupLegacy,
  init,
} from './init.js';

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
});

describe('relTargets', () => {
  it('lists skill + command destination paths', () => {
    const out = relTargets(['kando/SKILL.md'], ['kando-loop.md']);
    expect(out.skills).toEqual(['.claude/skills/kando/SKILL.md']);
    expect(out.commands).toEqual(['.claude/commands/kando-loop.md']);
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
    expect(existsSync(join(dir, '.claude', 'commands', 'kando-loop.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'hooks', 'kando-workflow.mjs'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'hooks', 'kando-verify-wait.mjs'))).toBe(true);

    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.enabledMcpjsonServers).toContain('kando');
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('kando-workflow.mjs');

    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('deploy authorization');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.claude/settings.local.json');
  });

  it('throws when the target is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kando-init-nogit-'));
    expect(() => init(dir)).toThrow(/not a git repo/);
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
