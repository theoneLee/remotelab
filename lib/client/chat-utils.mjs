export function getNextToolSessionName(sessions, toolName) {
  const existing = Array.isArray(sessions) ? sessions : [];
  const baseName = toolName || 'Session';
  let maxNum = 0;

  for (const session of existing) {
    if (!session || typeof session.name !== 'string') continue;
    const match = session.name.match(new RegExp(`^${escapeRegex(baseName)} #(\\d+)$`));
    if (match) {
      const value = parseInt(match[1], 10);
      if (value > maxNum) maxNum = value;
    }
  }

  return `${baseName} #${maxNum + 1}`;
}

export function mergeWrappedTerminalLines(lines) {
  const merged = [];
  for (const line of lines || []) {
    const text = typeof line?.text === 'string' ? line.text : '';
    if (line?.isWrapped && merged.length) {
      merged[merged.length - 1] += text;
    } else {
      merged.push(text);
    }
  }
  return merged;
}

export function cleanupAssistantText(text, promptText = '') {
  const cleaned = normalizeTerminalText(text);
  if (!cleaned) return '';

  const lines = cleaned.split('\n');
  const trimmedPrompt = String(promptText || '').trim();

  if (trimmedPrompt) {
    while (lines.length && lines[0].trim() === trimmedPrompt) {
      lines.shift();
    }
  }

  return collapseBlankLines(lines).join('\n').trim();
}

export function normalizeTerminalText(text = '') {
  return collapseBlankLines(
    stripAnsi(String(text || ''))
      .replace(/\r\n?/g, '\n')
      .replace(/\u0000/g, '')
      .split('\n')
      .map((line) => line.replace(/\s+$/g, '')),
  ).join('\n').trim();
}

export function deriveVisibleDelta(previousText = '', currentText = '') {
  const previous = normalizeTerminalText(previousText);
  const current = normalizeTerminalText(currentText);

  if (!current || current === previous) return '';
  if (!previous) return current;
  if (current.startsWith(previous)) {
    return current.slice(previous.length).replace(/^\n+/, '');
  }

  const previousLines = previous.split('\n');
  const currentLines = current.split('\n');
  let prefixLength = 0;
  while (
    prefixLength < previousLines.length &&
    prefixLength < currentLines.length &&
    previousLines[prefixLength] === currentLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  if (prefixLength > 0 && prefixLength < currentLines.length) {
    return currentLines.slice(prefixLength).join('\n').trim();
  }

  return '';
}

export function deriveVisibleResponseText(screenText = '', promptText = '') {
  const lines = getMeaningfulLines(screenText, promptText);
  const responseLines = lines.filter((line) => !isProgressLine(line));
  if (!responseLines.length) return '';

  const responseText = responseLines.join('\n').trim();
  if (responseText.length < 20 && responseLines.length < 2) return '';
  return responseText;
}

export function deriveProgressSummary(toolLabel, screenText = '', promptText = '', responseText = '') {
  const label = toolLabel || 'Tool';
  const lines = getMeaningfulLines(screenText, promptText);
  const responseLines = new Set(normalizeTerminalText(responseText).split('\n').filter(Boolean));

  const progressLines = dedupeTrailingLines(lines.filter((line) => {
    if (responseLines.has(line)) return false;
    if (isProgressLine(line)) return true;
    return false;
  }));

  if (progressLines.length) {
    return `${label} is working…\n${progressLines.slice(-3).join('\n')}`.trim();
  }

  return lines.length ? `${label} is working…` : '';
}

function getMeaningfulLines(screenText, promptText = '') {
  const cleaned = normalizeTerminalText(screenText);
  if (!cleaned) return [];

  const trimmedPrompt = String(promptText || '').trim();
  return cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== trimmedPrompt)
    .filter((line) => !/^press ⏎ to reconnect$/i.test(line))
    .filter((line) => !/^connection closed$/i.test(line));
}

function dedupeTrailingLines(lines) {
  const output = [];
  for (const line of lines) {
    if (output[output.length - 1] === line) continue;
    output.push(line);
  }
  return output;
}

function isProgressLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;

  return (
    /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒·•…]+$/.test(text)
    || /^[>$] /.test(text)
    || /(thinking|working|running|executing|searching|reading|writing|editing|planning|analyzing|applying|loading|waiting|tool|command|patch|diff|approval|permissions?)/i.test(text)
  );
}

function collapseBlankLines(lines) {
  const compact = [];
  let prevBlank = false;

  for (const line of lines) {
    const trimmed = String(line).replace(/\s+$/g, '');
    const blank = trimmed.length === 0;
    if (blank && prevBlank) continue;
    compact.push(trimmed);
    prevBlank = blank;
  }

  return compact;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAnsi(value) {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[@-_]/g, '');
}
