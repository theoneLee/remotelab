import { parseApprovalScreen, buildApprovalInput } from '/assets/chat-approvals.mjs';
import { getNextToolSessionName, mergeWrappedTerminalLines, cleanupAssistantText, normalizeTerminalText, deriveVisibleDelta, deriveVisibleResponseText, deriveProgressSummary } from '/assets/chat-utils.mjs';

const bootstrap = window.CHAT_BOOTSTRAP || {};
const params = new URLSearchParams(window.location.search);
const FOLDER_PATH = bootstrap.folderPath;
const MAX_MESSAGES = 200;
const STABLE_OUTPUT_MS = 1000;
const PROGRESS_STALE_MS = 3000;
const CAPTURE_STALE_MS = 5000;
const TOOL_ORDER = ['claude', 'codex'];

const state = {
  tools: [],
  sessions: [],
  currentToolId: null,
  currentSession: null,
  requestedSessionId: params.get('sessionId'),
  messages: [],
  iframe: null,
  term: null,
  capture: null,
  activeApproval: null,
  activeApprovalFingerprint: null,
  outputPollId: null,
  screenPollId: null,
  reconnectPollId: null,
  dismissedApprovalAt: 0,
  ready: false,
};

const elements = {
  toolSelect: document.getElementById('tool-select'),
  sessionSelect: document.getElementById('session-select'),
  newSessionButton: document.getElementById('new-session-btn'),
  clearButton: document.getElementById('clear-btn'),
  sessionLabel: document.getElementById('session-label'),
  statusText: document.getElementById('status-text'),
  messageList: document.getElementById('message-list'),
  emptyState: document.getElementById('empty-state'),
  emptyTitle: document.getElementById('empty-title'),
  emptySubtitle: document.getElementById('empty-subtitle'),
  composerInput: document.getElementById('composer-input'),
  sendButton: document.getElementById('send-btn'),
  stopButton: document.getElementById('stop-btn'),
  escButton: document.getElementById('esc-btn'),
  toastRoot: document.getElementById('toast-root'),
  approvalPanel: document.getElementById('approval-panel'),
  approvalTitle: document.getElementById('approval-title'),
  approvalBody: document.getElementById('approval-body'),
  approvalActions: document.getElementById('approval-actions'),
  terminalHost: document.getElementById('hidden-terminal-host'),
  scrollButton: document.getElementById('scroll-bottom-btn'),
};

function makeId(prefix = 'msg') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function toolName(toolId) {
  const tool = state.tools.find((item) => item.id === toolId);
  return tool ? tool.name : toolId;
}

function toolBindingKey(toolId) {
  return `chat_session_${FOLDER_PATH}_${toolId}`;
}

function lastToolKey() {
  return `chat_last_tool_${FOLDER_PATH}`;
}

function historyKey(sessionId) {
  return `chat_history_${sessionId}`;
}

function uiKey(sessionId) {
  return `chat_ui_${sessionId}`;
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function currentHistoryKey() {
  return state.currentSession ? historyKey(state.currentSession.id) : null;
}

function currentUiKey() {
  return state.currentSession ? uiKey(state.currentSession.id) : null;
}

function loadMessages(sessionId) {
  const data = loadJson(historyKey(sessionId), { version: 1, messages: [] });
  return Array.isArray(data.messages) ? data.messages : [];
}

function saveMessages() {
  const key = currentHistoryKey();
  if (!key) return;
  saveJson(key, { version: 1, messages: state.messages.slice(-MAX_MESSAGES) });
}

function saveUiState() {
  const key = currentUiKey();
  if (!key) return;
  saveJson(key, { draft: elements.composerInput.value });
}

function loadUiState(sessionId) {
  return loadJson(uiKey(sessionId), { draft: '' });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' error' : ''}`;
  toast.textContent = message;
  elements.toastRoot.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

function updateStatus(message, isReady = false) {
  elements.statusText.textContent = message;
  elements.statusText.dataset.ready = String(Boolean(isReady));
}

function setEmptyState(title, subtitle) {
  elements.emptyTitle.textContent = title;
  elements.emptySubtitle.textContent = subtitle;
}

function renderMessages() {
  elements.messageList.innerHTML = '';

  for (const message of state.messages) {
    const row = document.createElement('article');
    row.className = `message-row ${message.role}`;

    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${message.role}${message.pending ? ' pending' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = `${message.label || message.role} · ${formatTime(message.ts)}`;

    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = escapeHtml(message.content).replace(/\n/g, '<br>');

    bubble.appendChild(meta);
    bubble.appendChild(content);
    row.appendChild(bubble);
    elements.messageList.appendChild(row);
  }

  const hasSession = Boolean(state.currentSession);
  elements.emptyState.style.display = hasSession && state.messages.length ? 'none' : '';
  elements.scrollButton.classList.toggle('visible', state.messages.length > 10);
  requestAnimationFrame(() => {
    elements.messageList.scrollTop = elements.messageList.scrollHeight;
  });
}

function addMessage(message, persist = true) {
  state.messages = [...state.messages, message].slice(-MAX_MESSAGES);
  if (persist) saveMessages();
  renderMessages();
}

function updateMessage(messageId, patch, persist = false) {
  let changed = false;
  state.messages = state.messages.map((message) => {
    if (message.id !== messageId) return message;
    changed = true;
    return { ...message, ...patch };
  });
  if (!changed) return;
  if (persist) saveMessages();
  renderMessages();
}

function removeMessage(messageId, persist = true) {
  state.messages = state.messages.filter((message) => message.id !== messageId);
  if (persist) saveMessages();
  renderMessages();
}

function loadToolOptions() {
  elements.toolSelect.innerHTML = state.tools
    .map((tool) => `<option value="${escapeHtml(tool.id)}">${escapeHtml(tool.name)}</option>`)
    .join('');
}

function allToolSessions() {
  return state.sessions.filter((session) => session.type === 'tool');
}

function sessionsForTool(toolId) {
  return allToolSessions()
    .filter((session) => session.tool === toolId)
    .sort((left, right) => new Date(right.created).getTime() - new Date(left.created).getTime());
}

function getBoundSessionId(toolId) {
  return localStorage.getItem(toolBindingKey(toolId));
}

function setBoundSessionId(toolId, sessionId) {
  localStorage.setItem(toolBindingKey(toolId), sessionId);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

async function loadInitialData() {
  const [toolsData, sessionsData] = await Promise.all([
    fetchJson('/api/tools'),
    fetchJson(`/api/sessions?folder=${encodeURIComponent(FOLDER_PATH)}`),
  ]);

  state.tools = (toolsData.tools || []).filter((tool) => tool.available && tool.id !== 'shell');
  state.sessions = (sessionsData.sessions || []).filter((session) => session.type === 'tool');

  if (!state.tools.length) {
    throw new Error('No available tools for chat mode');
  }

  loadToolOptions();
}

function preferredToolId() {
  const requestedSession = state.requestedSessionId
    ? state.sessions.find((session) => session.id === state.requestedSessionId)
    : null;

  if (requestedSession) {
    return requestedSession.tool;
  }

  const stored = localStorage.getItem(lastToolKey());
  if (stored && state.tools.some((tool) => tool.id === stored)) {
    return stored;
  }

  for (const toolId of TOOL_ORDER) {
    if (sessionsForTool(toolId).length > 0) return toolId;
  }

  for (const toolId of TOOL_ORDER) {
    if (state.tools.some((tool) => tool.id === toolId)) return toolId;
  }

  return state.tools[0] ? state.tools[0].id : null;
}

function populateSessionSelect(toolId, selectedSessionId = '') {
  const sessions = sessionsForTool(toolId);
  const multipleChoices = sessions.length > 1;

  if (!sessions.length) {
    elements.sessionSelect.innerHTML = '<option value="">No sessions yet</option>';
    elements.sessionSelect.disabled = true;
    return;
  }

  let html = '';
  if (multipleChoices) {
    html += '<option value="">Select a session…</option>';
  }

  html += sessions.map((session) => {
    const selected = selectedSessionId === session.id ? ' selected' : '';
    return `<option value="${escapeHtml(session.id)}"${selected}>${escapeHtml(session.name)}</option>`;
  }).join('');

  elements.sessionSelect.innerHTML = html;
  elements.sessionSelect.disabled = false;

  if (!selectedSessionId && sessions.length === 1) {
    elements.sessionSelect.value = sessions[0].id;
  }
}

function updateTopbar() {
  const terminalReady = state.ready && isTerminalReady();
  elements.toolSelect.value = state.currentToolId || '';
  elements.clearButton.disabled = !state.currentSession;
  elements.stopButton.disabled = !state.currentSession || !terminalReady;
  elements.escButton.disabled = !state.currentSession || !terminalReady;
  elements.sendButton.disabled = !state.currentSession || !terminalReady;
  elements.newSessionButton.textContent = `New ${toolName(state.currentToolId) || 'session'}`;

  if (state.currentSession) {
    elements.sessionLabel.textContent = `${state.currentSession.name} · same context as Terminal`;
  } else {
    elements.sessionLabel.textContent = 'No session selected';
  }
}

function findSession(sessionId) {
  return state.sessions.find((session) => session.id === sessionId) || null;
}

function resolveSessionChoice(toolId, preferredSessionId) {
  const sessions = sessionsForTool(toolId);

  if (preferredSessionId && sessions.some((session) => session.id === preferredSessionId)) {
    return preferredSessionId;
  }

  const boundSessionId = getBoundSessionId(toolId);
  if (boundSessionId && sessions.some((session) => session.id === boundSessionId)) {
    return boundSessionId;
  }

  if (sessions.length === 1) {
    return sessions[0].id;
  }

  return '';
}

function clearRuntimeState() {
  if (state.outputPollId) clearInterval(state.outputPollId);
  if (state.screenPollId) clearInterval(state.screenPollId);
  if (state.reconnectPollId) clearInterval(state.reconnectPollId);
  state.outputPollId = null;
  state.screenPollId = null;
  state.reconnectPollId = null;
  state.capture = null;
  state.activeApproval = null;
  state.activeApprovalFingerprint = null;
  state.term = null;
  state.ready = false;
  if (state.iframe) state.iframe.remove();
  state.iframe = null;
}

function getTerminalTextarea(iframe = state.iframe) {
  try {
    const doc = iframe && (iframe.contentDocument || iframe.contentWindow.document);
    return doc ? doc.querySelector('.xterm-helper-textarea') : null;
  } catch {
    return null;
  }
}

function isTerminalReady(term = state.term, iframe = state.iframe) {
  return Boolean(
    term && (
      typeof term.input === 'function'
      || typeof term.paste === 'function'
      || getTerminalTextarea(iframe)
    )
  );
}

function getBuffer(term) {
  return term && term.buffer ? term.buffer.active : null;
}

function getBufferLineCount(term) {
  const buffer = getBuffer(term);
  if (!buffer) return 0;
  if (typeof buffer.length === 'number') return buffer.length;
  return (buffer.baseY || 0) + (term.rows || 0);
}

function getBufferSnapshot(term, start = 0, end = getBufferLineCount(term)) {
  const buffer = getBuffer(term);
  if (!buffer) return [];

  const snapshot = [];
  for (let index = Math.max(0, start); index < end; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    snapshot.push({
      text: line.translateToString(true),
      isWrapped: Boolean(line.isWrapped),
    });
  }
  return snapshot;
}

function getScreenText(term) {
  const buffer = getBuffer(term);
  if (!buffer) return '';
  const viewportY = typeof buffer.viewportY === 'number'
    ? buffer.viewportY
    : Math.max(0, getBufferLineCount(term) - (term.rows || 0));
  return mergeWrappedTerminalLines(
    getBufferSnapshot(term, viewportY, viewportY + (term.rows || 0)),
  ).join('\n');
}

function captureHasRecentActivity(capture = state.capture, now = Date.now()) {
  return Boolean(capture && (now - capture.lastActivityAt) < CAPTURE_STALE_MS);
}

function startCapture(promptText = '') {
  if (!state.term) return;
  state.capture = {
    startLine: getBufferLineCount(state.term),
    promptText,
    lastRawText: '',
    lastBufferText: '',
    lastScreenText: normalizeTerminalText(getScreenText(state.term)),
    screenStreamText: '',
    assistantText: '',
    progressText: '',
    lastActivityAt: Date.now(),
    lastContentAt: 0,
    assistantMessageId: null,
    progressMessageId: null,
  };
}

function upsertPendingAssistant(text) {
  if (!state.capture) return;

  if (!text) {
    if (state.capture.assistantMessageId) {
      removeMessage(state.capture.assistantMessageId, false);
      state.capture.assistantMessageId = null;
    }
    return;
  }

  if (!state.capture.assistantMessageId) {
    const message = {
      id: makeId('assistant'),
      role: 'assistant',
      label: toolName(state.currentToolId),
      content: text,
      ts: Date.now(),
      pending: true,
    };
    state.capture.assistantMessageId = message.id;
    addMessage(message, false);
    return;
  }

  updateMessage(state.capture.assistantMessageId, { content: text, pending: true }, false);
}

function upsertPendingProgress(text) {
  if (!state.capture) return;

  if (!text) {
    clearPendingProgress(false);
    return;
  }

  if (!state.capture.progressMessageId) {
    const message = {
      id: makeId('progress'),
      role: 'system',
      label: `${toolName(state.currentToolId)} status`,
      content: text,
      ts: Date.now(),
      pending: true,
    };
    state.capture.progressMessageId = message.id;
    addMessage(message, false);
    return;
  }

  updateMessage(state.capture.progressMessageId, { content: text, pending: true }, false);
}

function clearPendingProgress(persist = false) {
  if (!state.capture || !state.capture.progressMessageId) return;
  removeMessage(state.capture.progressMessageId, persist);
  state.capture.progressMessageId = null;
}

function releaseCapture(options = {}) {
  const capture = state.capture;
  if (!capture) return;

  const { interrupted = false, keepPartial = true } = options;
  const assistantText = capture.assistantText;
  const assistantMessageId = capture.assistantMessageId;

  if (assistantMessageId) {
    if (assistantText && keepPartial) {
      updateMessage(assistantMessageId, { content: assistantText, pending: false }, true);
    } else {
      removeMessage(assistantMessageId, true);
    }
  }

  clearPendingProgress(false);
  state.capture = null;
  updateTopbar();

  if (interrupted) {
    updateStatus(`Interrupted ${toolName(state.currentToolId)}`, false);
  } else {
    updateStatus(`Connected to ${toolName(state.currentToolId)}`, true);
  }
}

function pollOutput() {
  if (!state.term || !state.capture) return;

  const capture = state.capture;
  const now = Date.now();
  const rawText = mergeWrappedTerminalLines(
    getBufferSnapshot(state.term, capture.startLine, getBufferLineCount(state.term)),
  ).join('\n');
  const screenText = normalizeTerminalText(getScreenText(state.term));

  if (rawText !== capture.lastRawText) {
    capture.lastRawText = rawText;
    capture.lastActivityAt = now;
  }

  if (screenText !== capture.lastScreenText) {
    capture.lastActivityAt = now;
  }

  const bufferText = cleanupAssistantText(rawText, capture.promptText);
  if (bufferText && bufferText !== capture.assistantText) {
    capture.lastBufferText = bufferText;
    capture.assistantText = bufferText;
    capture.lastContentAt = now;
    upsertPendingAssistant(bufferText);
  }

  if (screenText !== capture.lastScreenText) {
    const visibleResponse = deriveVisibleResponseText(screenText, capture.promptText);
    if (!capture.lastBufferText && visibleResponse) {
      const nextScreenText = capture.screenStreamText
        ? (() => {
            const delta = deriveVisibleDelta(capture.screenStreamText, visibleResponse);
            if (delta) {
              return cleanupAssistantText([
                capture.screenStreamText,
                delta,
              ].filter(Boolean).join('\n'), capture.promptText);
            }
            if (visibleResponse.length >= capture.screenStreamText.length) {
              return visibleResponse;
            }
            return capture.screenStreamText;
          })()
        : visibleResponse;

      if (nextScreenText && nextScreenText !== capture.assistantText) {
        capture.screenStreamText = nextScreenText;
        capture.assistantText = nextScreenText;
        capture.lastContentAt = now;
        upsertPendingAssistant(nextScreenText);
      }
    }

    const progressText = deriveProgressSummary(
      toolName(state.currentToolId),
      screenText,
      capture.promptText,
      capture.assistantText,
    );

    if (progressText !== capture.progressText) {
      capture.progressText = progressText;
      if (progressText) {
        upsertPendingProgress(progressText);
      } else {
        clearPendingProgress(false);
      }
    }

    capture.lastScreenText = screenText;
  }

  if (state.activeApproval) {
    updateStatus('Waiting for approval…', false);
    return;
  }

  if (capture.progressText) {
    updateStatus(capture.progressText.split('\n')[0], false);
  } else if (capture.assistantText) {
    updateStatus(`${toolName(state.currentToolId)} is responding…`, false);
  } else if (captureHasRecentActivity(capture, now)) {
    updateStatus(`${toolName(state.currentToolId)} is working…`, false);
  }

  const idleMs = now - capture.lastActivityAt;
  if (capture.assistantText && idleMs >= STABLE_OUTPUT_MS) {
    releaseCapture();
    return;
  }

  if (!capture.assistantText && capture.progressText && idleMs >= PROGRESS_STALE_MS) {
    releaseCapture({ keepPartial: false });
    return;
  }

  if (!capture.assistantText && !capture.progressText && idleMs >= CAPTURE_STALE_MS) {
    releaseCapture({ keepPartial: false });
  }
}

function renderApprovalPanel() {
  const approval = state.activeApproval;
  if (!approval) {
    elements.approvalPanel.hidden = true;
    elements.approvalActions.innerHTML = '';
    return;
  }

  elements.approvalPanel.hidden = false;
  elements.approvalTitle.textContent = approval.title;
  elements.approvalBody.textContent = approval.body || 'Select an option to continue.';
  elements.approvalActions.innerHTML = '';

  approval.options.forEach((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'approval-btn';
    button.textContent = option.shortcut ? `${option.label} · ${option.shortcut}` : option.label;
    button.addEventListener('click', () => {
      const input = buildApprovalInput(approval, option.id);
      if (!input) {
        showToast('Unable to send this approval choice', true);
        return;
      }

      sendRaw(input);
      state.dismissedApprovalAt = Date.now();
      addMessage({
        id: makeId('decision'),
        role: 'user',
        label: 'choice',
        content: `[Permission] ${option.label}`,
        ts: Date.now(),
      }, true);
      state.activeApproval = null;
      state.activeApprovalFingerprint = null;
      renderApprovalPanel();
      updateStatus(`Waiting for ${toolName(state.currentToolId)}...`, false);
    });
    elements.approvalActions.appendChild(button);
  });
}

function updateApprovalFromScreen() {
  if (!state.term || !state.currentToolId) return;
  const approval = parseApprovalScreen(state.currentToolId, getScreenText(state.term));

  if (!approval) {
    if (state.activeApproval && Date.now() - state.dismissedApprovalAt > 300) {
      state.activeApproval = null;
      state.activeApprovalFingerprint = null;
      renderApprovalPanel();
    }
    return;
  }

  if (approval.fingerprint === state.activeApprovalFingerprint) {
    state.activeApproval = approval;
    renderApprovalPanel();
    return;
  }

  state.activeApproval = approval;
  state.activeApprovalFingerprint = approval.fingerprint;
  addMessage({
    id: makeId('approval'),
    role: 'system',
    label: approval.tool,
    content: [approval.title, approval.body].filter(Boolean).join('\n\n'),
    ts: Date.now(),
  }, true);
  renderApprovalPanel();
}

function findReconnectOverlay(doc) {
  const divs = doc.querySelectorAll('div[style*="position: absolute"][style*="font-size"]');
  for (const div of divs) {
    const text = div.textContent || '';
    if (text.includes('Reconnect')) return div;
  }
  return null;
}

function injectAutoReconnect(iframe) {
  state.reconnectPollId = setInterval(() => {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (!doc) return;
      const overlay = findReconnectOverlay(doc);
      if (!overlay) return;
      const textarea = doc.querySelector('.xterm-helper-textarea');
      if (!textarea) return;
      textarea.focus();
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
      }));
    } catch {
      // ignore
    }
  }, 2000);
}

function forceTerminalRedraw(term) {
  if (!term || !term.cols || !term.rows || typeof term.resize !== 'function') return;
  const cols = term.cols;
  const rows = term.rows;
  term.resize(Math.max(2, cols - 1), rows);
  setTimeout(() => {
    try {
      term.resize(cols, rows);
      if (typeof term.scrollToBottom === 'function') term.scrollToBottom();
    } catch {
      // ignore
    }
  }, 60);
}

function waitForTerm(iframe) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const pollId = setInterval(() => {
      try {
        const term = iframe.contentWindow && iframe.contentWindow.term;
        if (term) {
          clearInterval(pollId);
          resolve(term);
          return;
        }
      } catch {
        // keep polling
      }

      if (Date.now() - startedAt > 15000) {
        clearInterval(pollId);
        reject(new Error('Timed out waiting for terminal'));
      }
    }, 200);
  });
}

async function mountHiddenTerminal(session) {
  clearRuntimeState();

  const iframe = document.createElement('iframe');
  iframe.className = 'hidden-terminal-frame';
  iframe.src = `/terminal/${encodeURIComponent(session.id)}/`;
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
  elements.terminalHost.replaceChildren(iframe);
  state.iframe = iframe;
  updateStatus(`Connecting to ${session.name}...`, false);

  await new Promise((resolve) => {
    iframe.addEventListener('load', resolve, { once: true });
  });

  state.term = await waitForTerm(iframe);
  forceTerminalRedraw(state.term);
  injectAutoReconnect(iframe);
  state.outputPollId = setInterval(pollOutput, 220);
  state.screenPollId = setInterval(updateApprovalFromScreen, 220);
  state.ready = isTerminalReady(state.term);
  updateTopbar();
  updateStatus(`Connected to ${session.name}`, true);
}

function sendRaw(text) {
  if (!state.term) {
    throw new Error('Terminal is not ready');
  }

  if (typeof state.term.input === 'function') {
    state.term.input(text, true);
    return;
  }

  if (typeof state.term.paste === 'function') {
    state.term.paste(text);
    return;
  }

  const textarea = getTerminalTextarea();
  if (textarea) {
    textarea.focus();
    textarea.value = text;
    textarea.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: text,
      inputType: 'insertText',
    }));
    textarea.value = '';
    return;
  }

  throw new Error('Terminal is not ready');
}

function normalizePromptInput(text) {
  return `${text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r')}\r`;
}

async function bindSession(sessionId) {
  const session = findSession(sessionId);
  if (!session || session.type !== 'tool') {
    return;
  }

  if (state.currentSession && state.currentSession.id === session.id && state.ready) {
    return;
  }

  if (state.currentSession) saveUiState();
  state.currentSession = session;
  state.ready = false;
  state.activeApproval = null;
  state.activeApprovalFingerprint = null;
  setBoundSessionId(session.tool, session.id);
  populateSessionSelect(state.currentToolId, session.id);

  const uiState = loadUiState(session.id);
  state.messages = loadMessages(session.id);
  elements.composerInput.value = uiState.draft || '';
  setEmptyState(
    `Continue ${session.name}`,
    'This chat page now sends prompts into the same real terminal tab you already use in the Terminal view.'
  );
  updateTopbar();
  renderMessages();
  renderApprovalPanel();
  await mountHiddenTerminal(session);
}

function clearSessionBinding(toolId) {
  localStorage.removeItem(toolBindingKey(toolId));
}

async function selectTool(toolId, options = {}) {
  if (!toolId) return;
  if (state.currentSession) saveUiState();

  state.currentToolId = toolId;
  localStorage.setItem(lastToolKey(), toolId);
  populateSessionSelect(toolId, '');
  updateTopbar();

  const selectedSessionId = resolveSessionChoice(toolId, options.preferredSessionId || '');
  if (selectedSessionId) {
    await bindSession(selectedSessionId);
    return;
  }

  state.currentSession = null;
  clearRuntimeState();
  state.messages = [];
  renderMessages();
  renderApprovalPanel();

  const sessions = sessionsForTool(toolId);
  if (!sessions.length) {
    setEmptyState(
      `No ${toolName(toolId)} session yet`,
      'Create a normal terminal session here, then Chat will follow the same context as your terminal tab.'
    );
    elements.sessionSelect.innerHTML = '<option value="">No sessions yet</option>';
    elements.sessionSelect.disabled = true;
    clearSessionBinding(toolId);
    updateStatus(`Create a ${toolName(toolId)} session to start chatting`, false);
  } else {
    setEmptyState(
      'Select a session',
      `There are ${sessions.length} ${toolName(toolId)} tabs in this folder. Pick the exact one you want to continue.`
    );
    updateStatus(`Choose a ${toolName(toolId)} session`, false);
  }

  updateTopbar();
}

async function createNewSession() {
  if (!state.currentToolId) return;
  const toolSessions = sessionsForTool(state.currentToolId);
  const name = getNextToolSessionName(toolSessions, toolName(state.currentToolId));
  const data = await fetchJson('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      folder: FOLDER_PATH,
      tool: state.currentToolId,
    }),
  });

  state.sessions = [...state.sessions, data.session];
  populateSessionSelect(state.currentToolId, data.session.id);
  await bindSession(data.session.id);
}

async function sendPrompt() {
  const originalValue = elements.composerInput.value;
  const text = originalValue.trim();
  if (!text) return;
  if (!state.currentSession) {
    showToast('Select a real terminal session first', true);
    return;
  }
  if (!state.ready) {
    showToast('Session is still connecting', true);
    return;
  }
  if (state.capture) {
    if (captureHasRecentActivity()) {
      showToast(`${toolName(state.currentToolId)} is still working. You can wait, Stop, or use Esc if the tool is prompting.`, true);
      return;
    }
    releaseCapture({ keepPartial: true });
  }
  if (state.activeApproval) {
    showToast('Handle the current permission request first', true);
    return;
  }

  const userMessage = {
    id: makeId('user'),
    role: 'user',
    label: 'you',
    content: text,
    ts: Date.now(),
  };

  addMessage(userMessage, true);
  elements.composerInput.value = '';
  saveUiState();
  startCapture(text);
  updateStatus(`Waiting for ${toolName(state.currentToolId)}...`, false);

  try {
    sendRaw(normalizePromptInput(text));
    elements.composerInput.focus();
  } catch (error) {
    state.capture = null;
    removeMessage(userMessage.id, true);
    elements.composerInput.value = originalValue;
    saveUiState();
    throw error;
  }
}

function clearLocalHistory() {
  if (!state.currentSession) return;
  if (!window.confirm('Clear local chat history for this session on this device?')) return;

  localStorage.removeItem(historyKey(state.currentSession.id));
  localStorage.removeItem(uiKey(state.currentSession.id));
  state.messages = [];
  elements.composerInput.value = '';
  renderMessages();
  setEmptyState(
    'History cleared',
    'The real terminal session is still running. New messages will continue in the same Codex or Claude context.'
  );
  showToast('Local history cleared');
}

function handleComposerKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    sendPrompt().catch((error) => showToast(error.message || 'Failed to send', true));
  }
}

async function init() {
  try {
    await loadInitialData();

    const initialToolId = preferredToolId();
    if (state.requestedSessionId && !findSession(state.requestedSessionId)) {
      showToast('That session no longer exists. Pick another tab below.', true);
    }

    await selectTool(initialToolId, { preferredSessionId: state.requestedSessionId || '' });
  } catch (error) {
    updateStatus(error.message || 'Failed to initialize chat', false);
    showToast(error.message || 'Failed to initialize chat', true);
  }
}

function wireEvents() {
  elements.toolSelect.addEventListener('change', (event) => {
    selectTool(event.target.value).catch((error) => showToast(error.message || 'Failed to switch tool', true));
  });

  elements.sessionSelect.addEventListener('change', (event) => {
    const sessionId = event.target.value;
    if (!sessionId) {
      clearSessionBinding(state.currentToolId);
      selectTool(state.currentToolId).catch((error) => showToast(error.message || 'Failed to switch session', true));
      return;
    }
    bindSession(sessionId).catch((error) => showToast(error.message || 'Failed to switch session', true));
  });

  elements.newSessionButton.addEventListener('click', () => {
    createNewSession().catch((error) => showToast(error.message || 'Failed to create session', true));
  });

  elements.clearButton.addEventListener('click', clearLocalHistory);

  elements.sendButton.addEventListener('click', () => {
    sendPrompt().catch((error) => showToast(error.message || 'Failed to send', true));
  });

  elements.stopButton.addEventListener('click', () => {
    if (!state.currentSession) return;
    try {
      sendRaw('\u0003');
      releaseCapture({ interrupted: true, keepPartial: true });
    } catch (error) {
      showToast(error.message || 'Failed to stop tool', true);
    }
  });

  elements.escButton.addEventListener('click', () => {
    if (!state.currentSession) return;
    try {
      sendRaw('\u001b');
      elements.composerInput.focus();
    } catch (error) {
      showToast(error.message || 'Failed to send Escape', true);
    }
  });

  elements.composerInput.addEventListener('keydown', handleComposerKeydown);
  elements.composerInput.addEventListener('input', saveUiState);
  elements.scrollButton.addEventListener('click', () => {
    elements.messageList.scrollTop = elements.messageList.scrollHeight;
  });

  window.addEventListener('beforeunload', () => {
    saveUiState();
    clearRuntimeState();
  });
}

wireEvents();
init();
