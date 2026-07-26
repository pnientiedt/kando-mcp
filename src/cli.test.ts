import { describe, it, expect } from 'vitest';
import { parseCli } from './cli.js';

describe('parseCli', () => {
  it('defaults to serve when invoked with no subcommand', () => {
    expect(parseCli([]).cmd).toBe('serve');
  });
  it('routes subcommands', () => {
    expect(parseCli(['serve']).cmd).toBe('serve');
    expect(parseCli(['login']).cmd).toBe('login');
    expect(parseCli(['logout']).cmd).toBe('logout');
    const init = parseCli(['init', './x']);
    expect(init.cmd).toBe('init');
    expect(init.args).toEqual(['./x']);
  });
  it('handles version and help flags', () => {
    expect(parseCli(['--version']).cmd).toBe('version');
    expect(parseCli(['-v']).cmd).toBe('version');
    expect(parseCli(['--help']).cmd).toBe('help');
    expect(parseCli(['-h']).cmd).toBe('help');
  });
  it('treats an unknown subcommand as help', () => {
    expect(parseCli(['wat']).cmd).toBe('help');
  });
});
