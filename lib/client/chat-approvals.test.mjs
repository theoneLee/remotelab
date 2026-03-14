import { describe, expect, it } from 'vitest';
import {
  normalizeScreenText,
  parseCodexApprovalScreen,
  parseClaudeApprovalScreen,
  buildApprovalInput,
} from './chat-approvals.mjs';

const CODEX_SCREEN = `
  Would you like to run the following command?

  Reason: this is a test reason such as one that would be produced by the model

  $ echo hello world

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`echo hello world\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`;

const CLAUDE_SCREEN = `
Claude needs permission to continue

Command: npm install

> Allow once (enter)
  Always allow for this session (a)
  Deny (esc)
`;

describe('chat approval parsing', () => {
  it('normalizes terminal screen text', () => {
    expect(normalizeScreenText('line 1\n\n\nline 2\r\n')).toBe('line 1\n\nline 2');
  });

  it('parses Codex approval modals with numbered options', () => {
    const approval = parseCodexApprovalScreen(CODEX_SCREEN);
    expect(approval).toBeTruthy();
    expect(approval.title).toMatch(/run the following command/i);
    expect(approval.options).toHaveLength(3);
    expect(approval.selectedIndex).toBe(0);
    expect(buildApprovalInput(approval, approval.options[2].id)).toBe('\u001b[B\u001b[B\r');
  });

  it('parses Claude approval screens with named options', () => {
    const approval = parseClaudeApprovalScreen(CLAUDE_SCREEN);
    expect(approval).toBeTruthy();
    expect(approval.tool).toBe('claude');
    expect(approval.options).toHaveLength(3);
    expect(approval.options[1].label).toMatch(/always allow/i);
    expect(buildApprovalInput(approval, approval.options[1].id)).toBe('\u001b[B\r');
  });

  it('falls back to bracket shortcuts when needed', () => {
    const approval = parseClaudeApprovalScreen('Allow network access? [y/N]');
    expect(approval).toBeTruthy();
    expect(approval.options.map((option) => option.shortcut)).toEqual(['y', 'n']);
    expect(buildApprovalInput(approval, approval.options[0].id)).toBe('y\r');
  });
});
