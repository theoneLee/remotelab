import { describe, expect, it } from 'vitest';
import {
  getNextToolSessionName,
  mergeWrappedTerminalLines,
  cleanupAssistantText,
  normalizeTerminalText,
  deriveVisibleDelta,
  deriveVisibleResponseText,
  deriveProgressSummary,
} from './chat-utils.mjs';

describe('chat utils', () => {
  it('computes the next numbered tool session name', () => {
    const name = getNextToolSessionName([
      { name: 'OpenAI Codex #1' },
      { name: 'OpenAI Codex #3' },
    ], 'OpenAI Codex');

    expect(name).toBe('OpenAI Codex #4');
  });

  it('merges wrapped terminal lines into logical lines', () => {
    const merged = mergeWrappedTerminalLines([
      { text: 'Hello ', isWrapped: false },
      { text: 'world', isWrapped: true },
      { text: 'Second line', isWrapped: false },
    ]);

    expect(merged).toEqual(['Hello world', 'Second line']);
  });

  it('removes prompt echo and collapses excessive blank lines', () => {
    const cleaned = cleanupAssistantText('explain this\n\n\nAnswer line 1\n\n\nAnswer line 2', 'explain this');
    expect(cleaned).toBe('Answer line 1\n\nAnswer line 2');
  });

  it('normalizes terminal text and strips ansi noise', () => {
    const normalized = normalizeTerminalText('\u001b[31mWorking\u001b[0m\r\n\r\nDone');
    expect(normalized).toBe('Working\n\nDone');
  });

  it('derives appended visible delta', () => {
    const delta = deriveVisibleDelta('Line 1\nLine 2', 'Line 1\nLine 2\nLine 3');
    expect(delta).toBe('Line 3');
  });

  it('extracts visible response lines while dropping progress hints', () => {
    const text = deriveVisibleResponseText('Codex is working…\nRunning rg src\nHere is the answer\nWith detail', 'prompt');
    expect(text).toBe('Here is the answer\nWith detail');
  });

  it('summarizes tool progress from the visible screen', () => {
    const progress = deriveProgressSummary('Codex', 'Thinking…\nRunning rg src\nReading README.md', 'prompt', '');
    expect(progress).toContain('Codex is working…');
    expect(progress).toContain('Running rg src');
  });
});
