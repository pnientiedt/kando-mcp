import { describe, it, expect } from 'vitest';
import { installCrashGuards } from './crashGuards.js';

describe('installCrashGuards', () => {
  it('logs an uncaughtException to the provided logger and does not rethrow', () => {
    const logs: unknown[][] = [];
    const uninstall = installCrashGuards((...args) => logs.push(args));
    try {
      // process.emit invokes our listener synchronously; with a listener present
      // Node does not treat it as fatal.
      process.emit('uncaughtException', new Error('boom') as never);
      expect(logs).toHaveLength(1);
      expect(String(logs[0][0])).toMatch(/uncaughtException/);
    } finally {
      uninstall();
    }
  });

  it('logs an unhandledRejection and keeps the process alive', () => {
    const logs: unknown[][] = [];
    const uninstall = installCrashGuards((...args) => logs.push(args));
    try {
      process.emit('unhandledRejection', new Error('nope') as never, Promise.resolve() as never);
      expect(logs).toHaveLength(1);
      expect(String(logs[0][0])).toMatch(/unhandledRejection/);
    } finally {
      uninstall();
    }
  });

  it('uninstall removes the listeners', () => {
    const before = process.listenerCount('uncaughtException');
    const uninstall = installCrashGuards(() => {});
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    uninstall();
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });
});
