const SELECTION_MARKERS = ['›', '>', '❯', '→', '*'];
const APPROVAL_KEYWORDS = /(allow|approve|permission|deny|reject|run the following command|make the following edits|continue|cancel|command|edit|write|access)/i;

function trimLine(line) {
  return line.replace(/\s+$/g, '');
}

function collapseBlankLines(lines) {
  const compact = [];
  let prevBlank = false;
  for (const line of lines) {
    const blank = !line.trim();
    if (blank && prevBlank) continue;
    compact.push(line);
    prevBlank = blank;
  }
  return compact;
}

export function normalizeScreenText(screenText = '') {
  return collapseBlankLines(
    String(screenText)
      .replace(/\r\n?/g, '\n')
      .replace(/\u0000/g, '')
      .split('\n')
      .map(trimLine),
  ).join('\n').trim();
}

function extractShortcut(label) {
  const parenMatch = label.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) return parenMatch[1].trim().toLowerCase();
  return null;
}

function parseNumberedOption(line, index) {
  const markerPattern = SELECTION_MARKERS.map((marker) => `\\${marker}`).join('');
  const match = line.match(new RegExp(`^\\s*([${markerPattern}])?\\s*(\\d+)[.)]\\s+(.+?)\\s*$`));
  if (!match) return null;
  const label = match[3].trim();
  return {
    id: `option-${index}`,
    index,
    label,
    shortcut: extractShortcut(label),
    selected: Boolean(match[1]),
    source: 'numbered',
  };
}

function parseNamedOption(line, index) {
  const match = line.match(/^\s*([›>❯→*])?\s*(Allow.*|Always allow.*|Approve.*|Yes.*|No.*|Deny.*|Reject.*|Cancel.*|Continue.*|Accept.*|Esc.*)$/i);
  if (!match) return null;
  const label = match[2].trim();
  return {
    id: `option-${index}`,
    index,
    label,
    shortcut: extractShortcut(label),
    selected: Boolean(match[1]),
    source: 'named',
  };
}

function extractBracketOptions(lines) {
  const options = [];
  const combined = lines.join('\n');
  if (/\[y\/n\]/i.test(combined) || /\[y\/N\]/.test(combined)) {
    options.push({ id: 'option-yes', index: 0, label: 'Yes, proceed', shortcut: 'y', selected: false, source: 'bracket' });
    options.push({ id: 'option-no', index: 1, label: 'No, cancel', shortcut: 'n', selected: false, source: 'bracket' });
  }
  return options;
}

function buildApproval(title, bodyLines, options, tool, lines) {
  if (!title || !options.length) return null;
  const selectedIndex = options.findIndex((option) => option.selected);
  return {
    tool,
    title,
    body: bodyLines.join('\n').trim(),
    options,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
    fingerprint: `${tool}:${normalizeScreenText([title, ...bodyLines, ...options.map((option) => option.label)].join('\n'))}`,
    screenText: normalizeScreenText(lines.join('\n')),
  };
}

function splitApprovalSections(lines, options) {
  const optionLabels = new Set(options.map((option) => option.label));
  const titleIndex = lines.findIndex((line) => APPROVAL_KEYWORDS.test(line));
  const optionStart = lines.findIndex((line) => optionLabels.has(line.trim().replace(/^([›>❯→*])\s*/, '').replace(/^\d+[.)]\s+/, '')));
  const safeTitleIndex = titleIndex >= 0 ? titleIndex : 0;
  const safeOptionStart = optionStart >= 0 ? optionStart : lines.length;
  const title = lines[safeTitleIndex] || '';
  const bodyLines = lines.slice(safeTitleIndex + 1, safeOptionStart).filter(Boolean);
  return { title, bodyLines };
}

export function parseCodexApprovalScreen(screenText = '') {
  const normalized = normalizeScreenText(screenText);
  if (!normalized) return null;

  const lines = normalized.split('\n');
  const options = lines
    .map((line, index) => parseNumberedOption(line, index))
    .filter(Boolean);

  const hasCodexTitle = lines.some((line) => /would you like to run the following command\??/i.test(line))
    || lines.some((line) => /would you like to make the following edits\??/i.test(line));
  const hasConfirmationHint = lines.some((line) => /press enter to confirm or esc to cancel/i.test(line));

  if (!hasCodexTitle || !hasConfirmationHint || options.length < 2) {
    return null;
  }

  const { title, bodyLines } = splitApprovalSections(lines, options);
  return buildApproval(title, bodyLines, options, 'codex', lines);
}

export function parseClaudeApprovalScreen(screenText = '') {
  const normalized = normalizeScreenText(screenText);
  if (!normalized) return null;

  const lines = normalized.split('\n');
  const bracketOptions = extractBracketOptions(lines);
  let options = lines
    .map((line, index) => parseNumberedOption(line, index) || parseNamedOption(line, index))
    .filter(Boolean);

  if (!options.length || bracketOptions.length >= 2) {
    options = bracketOptions.length >= 2 ? bracketOptions : options;
  }

  const keywordHit = lines.some((line) => APPROVAL_KEYWORDS.test(line));
  const optionKeywordHit = options.some((option) => /(allow|approve|yes|no|deny|reject|continue|cancel|accept)/i.test(option.label));

  if (!keywordHit || !optionKeywordHit || !options.length) {
    return null;
  }

  const { title, bodyLines } = splitApprovalSections(lines, options);
  return buildApproval(title, bodyLines, options, 'claude', lines);
}

export function parseApprovalScreen(toolId, screenText = '') {
  if (toolId === 'codex') {
    return parseCodexApprovalScreen(screenText);
  }
  if (toolId === 'claude') {
    return parseClaudeApprovalScreen(screenText);
  }
  return null;
}

export function buildApprovalInput(approval, optionId) {
  if (!approval || !Array.isArray(approval.options)) return null;
  const optionIndex = approval.options.findIndex((option) => option.id === optionId);
  if (optionIndex === -1) return null;

  const option = approval.options[optionIndex];

  if (typeof approval.selectedIndex === 'number') {
    const delta = optionIndex - approval.selectedIndex;
    let sequence = '';
    if (delta < 0) {
      sequence += '\u001b[A'.repeat(Math.abs(delta));
    } else if (delta > 0) {
      sequence += '\u001b[B'.repeat(delta);
    }
    sequence += '\r';
    return sequence;
  }

  if (option.shortcut === 'esc') return '\u001b';
  if (option.shortcut && option.shortcut.length === 1) return `${option.shortcut}\r`;
  if (option.shortcut) return option.shortcut;
  return null;
}
