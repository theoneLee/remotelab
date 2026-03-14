import { describe, expect, it } from 'vitest';
import { sanitizeSessions } from './sessions.mjs';

describe('sanitizeSessions', () => {
  it('filters out legacy chat-only sessions', () => {
    const sanitized = sanitizeSessions([
      { id: 'terminal-1', folder: '/tmp/project', tool: 'codex', type: 'tool' },
      { id: 'chat-1', folder: '/tmp/project', tool: 'codex', type: 'tool', surface: 'chat' },
    ]);

    expect(sanitized).toEqual([
      { id: 'terminal-1', folder: '/tmp/project', tool: 'codex', type: 'tool' },
    ]);
  });

  it('strips surface field from visible sessions', () => {
    const sanitized = sanitizeSessions([
      { id: 'terminal-2', folder: '/tmp/project', tool: 'claude', type: 'tool', surface: 'terminal' },
    ]);

    expect(sanitized).toEqual([
      { id: 'terminal-2', folder: '/tmp/project', tool: 'claude', type: 'tool' },
    ]);
  });
});
