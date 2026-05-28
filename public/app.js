import { appendMessageError, applyTerminalFlags, autopilotCanResumeFromSummary, autopilotFeedEntryLabel, autopilotNeedsDecision, autopilotStateLabel, createSessionSendGate, extractErrorReason, formatResetCountdown, messageClassNames, messageStateLabel, nextUsageResetMs, normalizeAutopilotFeed, readAttachments, shouldCollapseTerminalContent, streamApi } from "./client-helpers.js";

const state = {
  config: null,
  sessions: [],
  projects: [],
  currentSession: null,
  clientId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  selectedFiles: [],
  connections: [],
  connectionJobs: {},
  connectionPollers: {},
  connectionInputs: {},
  connectionOutputScroll: {},
  focusedConnectionInput: null,
  // <jobId>:<url> we've already auto-opened, so polling re-renders don't keep popping new tabs.
  openedJobSignInUrls: new Set(),
  usage: [],
  usageBudget: null,
  tailscale: null,
  tailscaleSetupDismissed: false,
  tailscaleContinueAfterSetup: false,
  githubStatus: null,
  githubConnected: false,
  prompts: [],
  promptDrafts: {},
  activePromptId: null,
  activeModelId: null,
  activeModelTab: "connection",
  projectMenuProject: null,
  autopilotPhases: new Map(),
  // sessionId -> timer handle; storing the handle (rather than a Set of ids) lets us cancel a
  // scheduled run when the session/project is deleted before the 450 ms delay elapses.
  autopilotTimers: new Map(),
  soundMuted: readBooleanPreference("orch.soundMuted", false),
  speechEnabled: readBooleanPreference("orch.speechEnabled", false),
  audioContext: null,
  speechVoicesPromise: null,
  typingSoundTimers: new Map(),
  activeTerminalMessage: null,
  openTimelineCards: new Set(),
  eventSource: null,
  runs: new Map(),
  pendingSends: createSessionSendGate(),
  statusText: "Ready",
};

function readBooleanPreference(key, fallback = false) {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    return value === "1";
  } catch {
    return fallback;
  }
}

function writeBooleanPreference(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Preferences still work for this tab if persistent storage is unavailable.
  }
}

// Active model runs, keyed by session id, so a run keeps streaming in the background while the user
// navigates to other projects. Each run owns its own session object + assistant draft; the UI only
// re-renders when the run's session is the one currently being viewed.
function currentRun() {
  return state.currentSession ? state.runs.get(state.currentSession.id) || null : null;
}

function isViewing(sessionId) {
  return Boolean(state.currentSession && state.currentSession.id === sessionId);
}

// Keep the screen awake while a run is streaming (e.g. long debates on mobile). Requires a secure
// context (HTTPS or localhost); over plain http on a LAN/Tailscale IP the API is unavailable and this
// silently no-ops.
let screenWakeLock = null;
async function updateWakeLock() {
  const wantLock = [...state.runs.values()].some((run) => run.streaming);
  try {
    if (wantLock && !screenWakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
      screenWakeLock = await navigator.wakeLock.request("screen");
      screenWakeLock.addEventListener("release", () => { screenWakeLock = null; });
    } else if (!wantLock && screenWakeLock) {
      await screenWakeLock.release();
      screenWakeLock = null;
    }
  } catch {
    screenWakeLock = null; // unsupported or non-secure context: ignore
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    updateWakeLock();
    refreshUsage();
  }
});

const el = {
  sidebar: document.querySelector(".sidebar"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  sidebarBackdrop: document.getElementById("sidebarBackdrop"),
  connectDialog: document.getElementById("connectDialog"),
  githubDialog: document.getElementById("githubDialog"),
  closeGithubDialog: document.getElementById("closeGithubDialog"),
  githubPublicKey: document.getElementById("githubPublicKey"),
  generateGithubKeyButton: document.getElementById("generateGithubKeyButton"),
  copyGithubKeyButton: document.getElementById("copyGithubKeyButton"),
  githubTokenInput: document.getElementById("githubTokenInput"),
  saveGithubTokenButton: document.getElementById("saveGithubTokenButton"),
  testGithubSshButton: document.getElementById("testGithubSshButton"),
  githubStatus: document.getElementById("githubStatus"),
  closeConnect: document.getElementById("closeConnect"),
  refreshConnections: document.getElementById("refreshConnections"),
  connectionList: document.getElementById("connectionList"),
  promptDialog: document.getElementById("promptDialog"),
  closePrompts: document.getElementById("closePrompts"),
  promptTabs: document.getElementById("promptTabs"),
  promptEditor: document.getElementById("promptEditor"),
  promptStatus: document.getElementById("promptStatus"),
  resetPrompt: document.getElementById("resetPrompt"),
  savePrompts: document.getElementById("savePrompts"),
  modelDialog: document.getElementById("modelDialog"),
  closeModelDialog: document.getElementById("closeModelDialog"),
  modelDialogTitle: document.getElementById("modelDialogTitle"),
  modelDialogTabs: document.getElementById("modelDialogTabs"),
  modelConnectionPanel: document.getElementById("modelConnectionPanel"),
  modelPromptPanel: document.getElementById("modelPromptPanel"),
  modelPromptEditor: document.getElementById("modelPromptEditor"),
  modelPromptStatus: document.getElementById("modelPromptStatus"),
  resetModelPrompt: document.getElementById("resetModelPrompt"),
  saveModelPrompt: document.getElementById("saveModelPrompt"),
  terminalDialog: document.getElementById("terminalDialog"),
  closeTerminal: document.getElementById("closeTerminal"),
  terminalTitle: document.getElementById("terminalTitle"),
  terminalTimeline: document.getElementById("terminalTimeline"),
  terminalOutput: document.getElementById("terminalOutput"),
  newChat: document.getElementById("newChat"),
  // The legacy "tailscaleSetup" element is now the settings gear; both Tailscale and GitHub
  // setup hang off the same dropdown menu so the sidebar stays compact.
  settingsMenuButton: document.getElementById("settingsMenuButton"),
  settingsMenu: document.getElementById("settingsMenu"),
  openTailscaleFromSettings: document.getElementById("openTailscaleFromSettings"),
  openGithubFromSettings: document.getElementById("openGithubFromSettings"),
  signOutAllFromSettings: document.getElementById("signOutAllFromSettings"),
  signOutAllStatus: document.getElementById("signOutAllStatus"),
  settingsTailscaleStatus: document.getElementById("settingsTailscaleStatus"),
  settingsGithubStatus: document.getElementById("settingsGithubStatus"),
  githubFinish: document.getElementById("githubFinish"),
  githubSshResult: document.getElementById("githubSshResult"),
  modelConnectStatusDot: document.getElementById("modelConnectStatusDot"),
  modelConnectIntroDetail: document.getElementById("modelConnectIntroDetail"),
  modelConnectSetupBody: document.getElementById("modelConnectSetupBody"),
  modelConnectJobOutput: document.getElementById("modelConnectJobOutput"),
  modelConnectFinish: document.getElementById("modelConnectFinish"),
  tailscaleDialog: document.getElementById("tailscaleDialog"),
  tailscaleForm: document.getElementById("tailscaleForm"),
  closeTailscale: document.getElementById("closeTailscale"),
  skipTailscale: document.getElementById("skipTailscale"),
  saveTailscale: document.getElementById("saveTailscale"),
  tailscaleStateDot: document.getElementById("tailscaleStateDot"),
  tailscaleStateText: document.getElementById("tailscaleStateText"),
  tailscaleSetupHint: document.getElementById("tailscaleSetupHint"),
  tailscaleStatus: document.getElementById("tailscaleStatus"),
  soundToggle: document.getElementById("soundToggle"),
  speechToggle: document.getElementById("speechToggle"),
  projectContextMenu: document.getElementById("projectContextMenu"),
  modalProjectName: document.getElementById("modalProjectName"),
  projectOptions: document.getElementById("projectOptions"),
  modalSupervisorSelect: document.getElementById("modalSupervisorSelect"),
  newChatDialog: document.getElementById("newChatDialog"),
  newChatForm: document.getElementById("newChatForm"),
  cancelNewChat: document.getElementById("cancelNewChat"),
  modalError: document.getElementById("modalError"),
  startNewChat: document.getElementById("startNewChat"),
  sessionList: document.getElementById("sessionList"),
  status: document.getElementById("status"),
  messages: document.getElementById("messages"),
  scrollToBottomButton: document.getElementById("scrollToBottomButton"),
  composer: document.getElementById("composer"),
  messageInput: document.getElementById("messageInput"),
  attachmentMenuButton: document.getElementById("attachmentMenuButton"),
  attachmentMenu: document.getElementById("attachmentMenu"),
  fileInput: document.getElementById("fileInput"),
  attachmentList: document.getElementById("attachmentList"),
  sendButton: document.getElementById("sendButton"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function setStatus(text) {
  state.statusText = text;
  el.status.setAttribute("aria-description", text);
}

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateTimeFormatter.format(date);
}

// Disables `button` and swaps its label while `action()` runs. Guards against double-clicks
// on every wizard primary that triggers a background HTTP call (GitHub key gen / token save /
// SSH test, model Connect, Tailscale Save+test, etc). The button's previous text and disabled
// state are restored even on error; if the panel re-renders mid-action (e.g. a connect kicks
// a fresh job poll), the original button node is no longer in the DOM and the reset is a no-op.
async function withButtonBusy(button, busyLabel, action) {
  if (!button) return action();
  if (button.disabled) return undefined;
  const prevText = button.textContent;
  const prevDisabled = button.disabled;
  button.disabled = true;
  if (busyLabel) button.textContent = busyLabel;
  try {
    return await action();
  } finally {
    button.disabled = prevDisabled;
    if (busyLabel) button.textContent = prevText;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function isNearBottom(element, threshold = 80) {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

function scrollElementToBottom(element) {
  if (!element) return;
  element.scrollTop = element.scrollHeight;
}

function workspaceText(cwd = ".") {
  return cwd === "." ? state.config.workspaceRoot : `${state.config.workspaceRoot}/${cwd}`;
}

function connectionForSupervisor(id) {
  return state.connections.find((connection) => connection.id === id);
}

function isSupervisorConnected(id) {
  return Boolean(connectionForSupervisor(id)?.connected);
}

function firstConnectedSupervisorId() {
  return Object.keys(state.config?.supervisors || {}).find((id) => isSupervisorConnected(id)) || "";
}

function bestSupervisorSelection(preferred) {
  if (preferred && isSupervisorConnected(preferred)) return preferred;
  return firstConnectedSupervisorId();
}

function renderSupervisors() {
  const previous = el.modalSupervisorSelect.value || state.config.defaultSupervisor;
  el.modalSupervisorSelect.innerHTML = "";
  for (const supervisor of Object.values(state.config.supervisors)) {
    const connected = isSupervisorConnected(supervisor.id);
    const option = document.createElement("option");
    option.value = supervisor.id;
    option.disabled = !connected;
    option.textContent = connected ? supervisor.label : `${supervisor.label} - not connected`;
    el.modalSupervisorSelect.appendChild(option);
  }
  const selected = bestSupervisorSelection(previous || state.config.defaultSupervisor);
  if (selected) el.modalSupervisorSelect.value = selected;
  else el.modalSupervisorSelect.selectedIndex = -1;
}

function modalProjectName() {
  return el.modalProjectName.value.trim().replace(/\s+/g, " ");
}

function findSessionByCwd(cwd) {
  return state.sessions.find((session) => session.cwd === cwd || session.project === cwd);
}

function projectExists(cwd) {
  return state.projects.includes(cwd);
}

function renderProjectOptions() {
  el.projectOptions.innerHTML = "";
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project;
    el.projectOptions.appendChild(option);
  }
}

function activePrompt() {
  return state.prompts.find((prompt) => prompt.id === state.activePromptId) || state.prompts[0];
}

function promptForModel(id) {
  return state.prompts.find((prompt) => prompt.id === id);
}

function storeActivePromptDraft() {
  if (!state.activePromptId) return;
  state.promptDrafts[state.activePromptId] = el.promptEditor.value;
}

function storeActiveModelPromptDraft() {
  if (!state.activeModelId || state.activeModelTab !== "prompt") return;
  state.promptDrafts[state.activeModelId] = el.modelPromptEditor.value;
}

function promptStatusText(prompt) {
  if (!prompt) return "";
  if (!prompt.sourceAvailable) return "Canonical source prompt is unavailable.";
  if (prompt.outdated) {
    return prompt.userOwned
      ? "Custom live prompt differs from canonical source."
      : "Live prompt differs from canonical source.";
  }
  return "Matches canonical source.";
}

function setPromptStore(body) {
  state.prompts = body.prompts || [];
  state.promptDrafts = Object.fromEntries(state.prompts.map((prompt) => [prompt.id, prompt.content || ""]));
  if (!state.prompts.some((prompt) => prompt.id === state.activePromptId)) {
    state.activePromptId = state.prompts[0]?.id || null;
  }
}

function renderPromptTabs() {
  el.promptTabs.innerHTML = "";
  for (const prompt of state.prompts) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `prompt-tab-${prompt.id}`;
    button.className = `prompt-tab ${prompt.id === state.activePromptId ? "active" : ""}`;
    button.role = "tab";
    button.setAttribute("aria-selected", String(prompt.id === state.activePromptId));
    button.textContent = prompt.label;
    button.addEventListener("click", () => {
      storeActivePromptDraft();
      state.activePromptId = prompt.id;
      renderPromptTabs();
      renderPromptEditor();
    });
    el.promptTabs.appendChild(button);
  }
}

function renderPromptEditor() {
  const prompt = activePrompt();
  if (!prompt) {
    el.promptEditor.value = "";
    el.promptEditor.disabled = true;
    el.resetPrompt.disabled = true;
    return;
  }
  state.activePromptId = prompt.id;
  el.promptEditor.disabled = false;
  el.resetPrompt.disabled = !prompt.sourceAvailable;
  el.promptEditor.setAttribute("aria-labelledby", `prompt-tab-${prompt.id}`);
  el.promptEditor.value = state.promptDrafts[prompt.id] ?? prompt.content ?? "";
  el.promptStatus.classList.toggle("is-error", !prompt.sourceAvailable);
  el.promptStatus.textContent = promptStatusText(prompt);
}

async function loadPromptSettings() {
  const body = await api("/api/prompts");
  setPromptStore(body);
  renderPromptTabs();
  renderPromptEditor();
  return body;
}

async function openPromptModal() {
  el.promptDialog.showModal();
  el.promptStatus.classList.remove("is-error");
  el.promptStatus.textContent = "Loading prompts...";
  el.promptEditor.disabled = true;
  el.savePrompts.disabled = true;
  try {
    await loadPromptSettings();
  } catch (error) {
    el.promptStatus.classList.add("is-error");
    el.promptStatus.textContent = error.message;
  } finally {
    el.savePrompts.disabled = false;
  }
}

async function resetPromptById(id, { modelDialog = false } = {}) {
  const prompt = promptForModel(id);
  if (!prompt?.sourceAvailable) return;
  const confirmed = window.confirm(`Reset ${prompt.label} prompt to the canonical source?`);
  if (!confirmed) return;
  const status = modelDialog ? el.modelPromptStatus : el.promptStatus;
  const resetButton = modelDialog ? el.resetModelPrompt : el.resetPrompt;
  const saveButton = modelDialog ? el.saveModelPrompt : el.savePrompts;
  resetButton.disabled = true;
  saveButton.disabled = true;
  status.classList.remove("is-error");
  status.textContent = "Resetting prompt...";
  try {
    const body = await api("/api/prompts/reset", {
      method: "POST",
      body: JSON.stringify({ ids: [id] }),
    });
    setPromptStore(body);
    renderPromptTabs();
    renderPromptEditor();
    if (modelDialog) renderModelPromptPanel();
    status.textContent = "Reset to canonical source.";
  } catch (error) {
    status.classList.add("is-error");
    status.textContent = error.message;
  } finally {
    resetButton.disabled = false;
    saveButton.disabled = false;
  }
}

function closePromptModal() {
  el.promptDialog.close();
}

async function savePromptSettings() {
  storeActivePromptDraft();
  el.savePrompts.disabled = true;
  el.promptStatus.classList.remove("is-error");
  el.promptStatus.textContent = "Saving prompts...";
  try {
    await api("/api/prompts", {
      method: "PUT",
      body: JSON.stringify({ prompts: state.promptDrafts }),
    });
    el.promptStatus.textContent = "Saved. Reloading...";
    setTimeout(() => window.location.reload(), 250);
  } catch (error) {
    el.promptStatus.classList.add("is-error");
    el.promptStatus.textContent = error.message;
    el.savePrompts.disabled = false;
  }
}

async function saveActiveModelPrompt() {
  if (!state.activeModelId) return;
  storeActiveModelPromptDraft();
  const id = state.activeModelId;
  el.saveModelPrompt.disabled = true;
  el.modelPromptStatus.classList.remove("is-error");
  el.modelPromptStatus.textContent = "Saving prompt...";
  try {
    await api("/api/prompts", {
      method: "PUT",
      body: JSON.stringify({ prompts: { [id]: state.promptDrafts[id] || "" } }),
    });
    el.modelPromptStatus.textContent = "Saved. Reloading...";
    setTimeout(() => location.reload(), 350);
  } catch (error) {
    el.modelPromptStatus.classList.add("is-error");
    el.modelPromptStatus.textContent = error.message;
    el.saveModelPrompt.disabled = false;
  }
}

function isAttachmentMenuOpen() {
  return !el.attachmentMenu.hidden;
}

function openAttachmentMenu() {
  el.attachmentMenu.hidden = false;
  el.attachmentMenuButton.setAttribute("aria-expanded", "true");
}

function closeAttachmentMenu() {
  el.attachmentMenu.hidden = true;
  el.attachmentMenuButton.setAttribute("aria-expanded", "false");
}

function toggleAttachmentMenu() {
  if (isAttachmentMenuOpen()) closeAttachmentMenu();
  else openAttachmentMenu();
}

function setSidebarExpanded(expanded) {
  el.sidebar.classList.toggle("is-expanded", expanded);
  el.sidebarToggle.setAttribute("aria-expanded", String(expanded));
  // Backdrop visibility mirrors the drawer. CSS only paints/clicks it in mobile; the class is
  // harmless on desktop because the backdrop has display:none outside the media query.
  el.sidebarBackdrop?.classList.toggle("is-visible", expanded);
}

function toggleSidebar() {
  setSidebarExpanded(!el.sidebar.classList.contains("is-expanded"));
}

function collapseResponsiveSidebar() {
  if (window.matchMedia("(max-width: 760px)").matches) setSidebarExpanded(false);
}

function modelIcon(id) {
  const icons = {
    claude: "/icons/claude.svg",
    codex: "/icons/codex.svg",
    gemini: "/icons/gemini.svg",
    deepseek: "/icons/deepseek.svg",
  };
  return icons[id] || "";
}

function createModelIcon(id) {
  const src = modelIcon(id);
  const icon = document.createElement("span");
  icon.className = "model-icon-glyph";
  icon.setAttribute("aria-hidden", "true");
  if (src) icon.style.setProperty("--model-icon-url", `url("${src}")`);
  else icon.textContent = "?";
  return icon;
}

function iconSvg(paths) {
  return [
    '<svg viewBox="0 0 24 24" aria-hidden="true">',
    ...paths.map((d) => `<path d="${d}"></path>`),
    "</svg>",
  ].join("");
}

const icons = {
  send: ["M12 19V5M6 11l6-6 6 6"],
  stop: ["M8 8h8v8H8z"],
  terminal: ["M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9", "M10 21h4"],
  soundOn: [
    "M11 5 6 9H2v6h4l5 4V5z",
    "M15.5 8.5a5 5 0 0 1 0 7",
    "M18.5 5.5a9 9 0 0 1 0 13",
  ],
  soundOff: ["M11 5 6 9H2v6h4l5 4V5z", "M22 9l-6 6M16 9l6 6"],
  speechOn: [
    "M7 8h10",
    "M7 12h7",
    "M21 12c0 4.4-4 8-9 8a10 10 0 0 1-4-.8L3 21l1.6-4A7.3 7.3 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8z",
  ],
  speechOff: [
    "M7 8h6",
    "M7 12h3",
    "M21 12c0 1.6-.5 3.1-1.5 4.3M16.8 19.1A10.4 10.4 0 0 1 12 20a10 10 0 0 1-4-.8L3 21l1.6-4A7.3 7.3 0 0 1 3 12c0-1.6.5-3.1 1.5-4.3M8.2 4.9A10.4 10.4 0 0 1 12 4c5 0 9 3.6 9 8",
    "M3 3l18 18",
  ],
  copy: [
    "M8 8h11v12H8z",
    "M5 16H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1",
  ],
  reload: ["M21 12a9 9 0 1 1-2.6-6.4", "M21 3v6h-6"],
  autopilot: [
    "M12 3v4",
    "M12 17v4",
    "M3 12h4",
    "M17 12h4",
    "M7.8 7.8l2.4 2.4",
    "M13.8 13.8l2.4 2.4",
    "M16.2 7.8l-2.4 2.4",
    "M10.2 13.8l-2.4 2.4",
  ],
};

function renderMediaToggles() {
  el.soundToggle.innerHTML = iconSvg(state.soundMuted ? icons.soundOff : icons.soundOn);
  el.soundToggle.classList.toggle("is-muted", state.soundMuted);
  el.soundToggle.classList.toggle("is-on", !state.soundMuted);
  el.soundToggle.title = state.soundMuted ? "Sounds muted" : "Sounds on";
  el.soundToggle.setAttribute("aria-label", state.soundMuted ? "Unmute sounds" : "Mute sounds");
  el.soundToggle.setAttribute("aria-pressed", String(!state.soundMuted));

  el.speechToggle.innerHTML = iconSvg(state.speechEnabled ? icons.speechOn : icons.speechOff);
  el.speechToggle.classList.toggle("is-muted", !state.speechEnabled);
  el.speechToggle.classList.toggle("is-on", state.speechEnabled);
  el.speechToggle.title = state.speechEnabled ? "Speech on" : "Speech off";
  el.speechToggle.setAttribute("aria-label", state.speechEnabled ? "Mute speech" : "Read answers aloud");
  el.speechToggle.setAttribute("aria-pressed", String(state.speechEnabled));
}

function ensureAudioContext() {
  if (state.soundMuted) return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!state.audioContext) state.audioContext = new AudioContextClass();
  if (state.audioContext.state === "suspended") state.audioContext.resume().catch(() => {});
  return state.audioContext;
}

function playTone({ frequency, duration = 0.06, delay = 0, type = "sine", gain = 0.025 }) {
  const audioContext = ensureAudioContext();
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  const start = audioContext.currentTime + delay;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gainNode.gain.setValueAtTime(0.0001, start);
  gainNode.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playTypingTick() {
  playTone({ frequency: 640, duration: 0.035, type: "triangle", gain: 0.015 });
  playTone({ frequency: 780, duration: 0.028, delay: 0.055, type: "triangle", gain: 0.011 });
}

function shouldPlayProjectAudio(sessionId) {
  return Boolean(sessionId && state.currentSession?.id === sessionId);
}

function startTypingSound(sessionId) {
  if (state.soundMuted || !shouldPlayProjectAudio(sessionId) || state.typingSoundTimers.has(sessionId)) return;
  state.typingSoundTimers.set(sessionId, null);
  playTypingTick();
}

function stopTypingSound(sessionId) {
  state.typingSoundTimers.delete(sessionId);
}

function stopAllTypingSounds() {
  for (const sessionId of state.typingSoundTimers.keys()) stopTypingSound(sessionId);
}

function playRunFinishedSound(kind = "done") {
  if (kind === "error") {
    playTone({ frequency: 240, duration: 0.12, type: "sawtooth", gain: 0.026 });
    playTone({ frequency: 150, duration: 0.16, delay: 0.12, type: "sawtooth", gain: 0.02 });
    return;
  }
  playTone({ frequency: 523.25, duration: 0.08, type: "sine", gain: 0.024 });
  playTone({ frequency: 783.99, duration: 0.12, delay: 0.095, type: "sine", gain: 0.022 });
}

function toggleSoundMute() {
  state.soundMuted = !state.soundMuted;
  writeBooleanPreference("orch.soundMuted", state.soundMuted);
  if (state.soundMuted) stopAllTypingSounds();
  else {
    for (const run of state.runs.values()) {
      if (run.streaming) startTypingSound(run.sessionId);
    }
  }
  renderMediaToggles();
}

function decodeHtmlEntitiesForSpeech(text) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

function sanitizeTextForSpeech(text) {
  const withoutMarkup = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\((?:https?:\/\/|www\.)[^)]*\)/gi, "$1")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, " ");
  return decodeHtmlEntitiesForSpeech(withoutMarkup)
    .replace(/[`"'“”‘’«»]/g, " ")
    .replace(/[!¡#<>()[\]{}*_+=|\\~^$%@;:]/g, " ")
    .replace(/\s+[-–—]\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function answerTextForSpeech(session) {
  const messages = [...(session?.messages || [])].reverse();
  const answer = messages.find((message) =>
    message.role === "assistant" &&
    !message.streaming &&
    !message.error &&
    !message.stopped &&
    String(message.content || "").trim()
  );
  return sanitizeTextForSpeech(answer?.content).slice(0, 4500);
}

function countMatches(text, pattern) {
  return text.match(pattern)?.length || 0;
}

function detectSpeechLanguage(text) {
  const value = String(text || "");
  const scores = [
    { lang: "el-GR", score: countMatches(value, /[\u0370-\u03ff\u1f00-\u1fff]/g) },
    { lang: "ru-RU", score: countMatches(value, /[\u0400-\u04ff]/g) },
    { lang: "ar-SA", score: countMatches(value, /[\u0600-\u06ff]/g) },
    { lang: "he-IL", score: countMatches(value, /[\u0590-\u05ff]/g) },
    { lang: "ko-KR", score: countMatches(value, /[\uac00-\ud7af]/g) },
    { lang: "ja-JP", score: countMatches(value, /[\u3040-\u30ff]/g) },
    { lang: "zh-CN", score: countMatches(value, /[\u3400-\u9fff]/g) },
    { lang: "en-US", score: countMatches(value, /[A-Za-z]/g) },
  ].sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (best?.score > 0) return best.lang;
  return navigator.language || "en-US";
}

function speechLanguagePrefix(lang) {
  return String(lang || "").toLowerCase().split("-")[0];
}

function availableSpeechVoices() {
  if (!("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices?.() || [];
}

function loadSpeechVoices({ timeoutMs = 900 } = {}) {
  const voices = availableSpeechVoices();
  if (voices.length) return Promise.resolve(voices);
  if (state.speechVoicesPromise) return state.speechVoicesPromise;
  state.speechVoicesPromise = new Promise((resolve) => {
    const synthesis = window.speechSynthesis;
    let timeout = null;
    const finish = () => {
      if (timeout) clearTimeout(timeout);
      synthesis.removeEventListener?.("voiceschanged", finish);
      state.speechVoicesPromise = null;
      resolve(availableSpeechVoices());
    };
    timeout = setTimeout(finish, timeoutMs);
    synthesis.addEventListener?.("voiceschanged", finish, { once: true });
  });
  return state.speechVoicesPromise;
}

function selectSpeechVoice(lang, voices = availableSpeechVoices()) {
  if (!("speechSynthesis" in window)) return null;
  const target = String(lang || "").toLowerCase();
  const prefix = speechLanguagePrefix(target);
  return voices.find((voice) => voice.lang.toLowerCase() === target) ||
    voices.find((voice) => speechLanguagePrefix(voice.lang) === prefix) ||
    null;
}

async function speakLatestAnswer(session) {
  if (!state.speechEnabled) return;
  if (!shouldPlayProjectAudio(session?.id)) return;
  if (!("speechSynthesis" in window)) {
    setStatus("Speech is not supported by this browser");
    return;
  }
  const text = answerTextForSpeech(session);
  if (!text) return;
  window.speechSynthesis.cancel();
  const lang = detectSpeechLanguage(text);
  const voices = await loadSpeechVoices();
  if (!state.speechEnabled) return;
  if (!shouldPlayProjectAudio(session?.id)) return;
  const voice = selectSpeechVoice(lang, voices);
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.lang = lang;
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

function toggleSpeechMute() {
  state.speechEnabled = !state.speechEnabled;
  writeBooleanPreference("orch.speechEnabled", state.speechEnabled);
  if (!state.speechEnabled && "speechSynthesis" in window) window.speechSynthesis.cancel();
  renderMediaToggles();
}

function renderModelStatus(connections = state.connections) {
  el.status.innerHTML = "";
  el.status.removeAttribute("title");
  if (state.usageBudget?.warning) {
    el.status.setAttribute("title", `Budget warning: ${formatUsageMoney(state.usageBudget.totalCostUsd, "USD")} spent`);
  }
  for (const connection of connections) {
    const usage = usageForModel(connection.id);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `model-chip ${connection.connected ? "on" : "off"} ${usage?.budgetWarning || state.usageBudget?.warning ? "budget-warning" : ""}`;
    chip.setAttribute("aria-label", usageTitle(connection, usage));

    const dot = document.createElement("span");
    dot.className = "model-chip-dot";
    dot.setAttribute("aria-hidden", "true");

    chip.append(createUsageRing(connection, usage), createUsagePopover(usage), dot);

    // Show the soonest quota-reset countdown right under the chip so the user can plan around
    // it without hovering for the tooltip.
    const resetMs = nextUsageResetMs(usage);
    if (resetMs) {
      const reset = document.createElement("span");
      reset.className = "model-chip-reset";
      reset.textContent = formatResetCountdown(resetMs);
      reset.title = `${connection.label} quota resets in ${formatResetCountdown(resetMs)}`;
      chip.append(reset);
    }
    chip.addEventListener("click", () => openModelModal(connection.id));
    el.status.appendChild(chip);
  }
}

function usageForModel(id) {
  return state.usage.find((item) => item.id === id);
}

function usageTitle(connection, usage) {
  const connected = connection.connected ? "on" : "off";
  if (!usage) return `${connection.label}: ${connected} - usage unknown`;
  const source = usageSourceText(usage);
  const parts = [
    `${connection.label}: ${connected}`,
    source,
    `${usage.runsToday || 0} runs today`,
  ];
  if (usage.active) parts.push("running now");
  if (usage.currentPercent !== null && usage.currentPercent !== undefined) parts.push(`current ${usage.currentPercent}%`);
  if (usage.weeklyPercent !== null && usage.weeklyPercent !== undefined) parts.push(`week ${usage.weeklyPercent}%`);
  if (usage.sonnetWeeklyPercent !== null && usage.sonnetWeeklyPercent !== undefined) parts.push(`sonnet week ${usage.sonnetWeeklyPercent}%`);
  if (usage.lastTokens) parts.push(`${usage.lastTokens.toLocaleString()} tokens last seen`);
  if (usage.lastCostUsd !== null && usage.lastCostUsd !== undefined) parts.push(`last cost $${Number(usage.lastCostUsd).toFixed(4)}`);
  if (usage.costTodayUsd) parts.push(`today cost $${Number(usage.costTodayUsd).toFixed(4)}`);
  if (usage.totalCostUsd) parts.push(`total cost $${Number(usage.totalCostUsd).toFixed(4)}`);
  if (usage.budgetWarning && usage.budgetWarningUsd) parts.push(`budget warning at $${Number(usage.budgetWarningUsd).toFixed(2)}`);
  if (usage.lastKnownLabel) parts.push(usage.lastKnownLabel);
  if (usage.lastProbeAt) parts.push(`checked ${formatDate(usage.lastProbeAt)}`);
  if (usage.lastProbeError) parts.push(`probe error: ${usage.lastProbeError}`);
  if (usage.lastProbeOutput && !usage.lastProbeError) parts.push(usage.lastProbeOutput.split("\n").slice(0, 2).join(" / "));
  return parts.join(" - ");
}

function usageSourceText(usage) {
  if (usage.mode === "provider") {
    const percent = finitePercent(usage.percent);
    return percent === null ? "real provider limit" : `${Math.round(percent)}% spent from provider limit`;
  }
  if (usage.mode === "balance") {
    const spent = formatUsageMoney(usage.balanceSpent, usage.balanceCurrency);
    const remaining = formatUsageMoney(usage.balanceRemaining, usage.balanceCurrency);
    if (spent && remaining) return `DeepSeek spent ${spent} / remaining ${remaining}`;
    return usage.balanceAvailable ? "DeepSeek balance checked, spent baseline pending" : "DeepSeek balance unavailable";
  }
  return usage.lastProbeAt ? "real status checked, no numeric limit returned" : "real limit unknown";
}

function usageDisplayPercent(connection, usage) {
  const percent = finitePercent(usage?.percent);
  if (usage?.mode === "provider" || usage?.mode === "balance") return percent ?? 0;
  return usage?.active && connection.connected ? 100 : 0;
}

function usageColor(percent, usage) {
  if (usage?.active) return "#f4f5f2";
  if (percent >= 90) return "var(--danger)";
  if (percent >= 70) return "#ff9f1c";
  if (percent >= 50) return "#3384ff";
  return "var(--accent)";
}

function createUsageRing(connection, usage) {
  const percent = usageDisplayPercent(connection, usage);
  const ring = document.createElement("span");
  ring.className = `usage-ring ${usage?.mode || "unknown"} ${usage?.active ? "active" : ""}`;
  ring.style.setProperty("--usage-deg", `${percent * 3.6}deg`);
  ring.style.setProperty("--usage-color", usageColor(percent, usage));
  ring.setAttribute("aria-hidden", "true");

  const icon = document.createElement("span");
  icon.className = "model-chip-icon";
  icon.appendChild(createModelIcon(connection.id));
  ring.appendChild(icon);
  return ring;
}

function createUsagePopover(usage) {
  const popover = document.createElement("span");
  popover.className = "usage-popover";
  popover.setAttribute("aria-hidden", "true");
  if (usage?.mode === "balance") {
    const spentPercent = finitePercent(usage.percent);
    const remainingPercent = spentPercent === null ? null : 100 - spentPercent;
    popover.append(
      createUsageBarRow("Left", remainingPercent, formatUsageMoney(usage.balanceRemaining, usage.balanceCurrency)),
    );
    return popover;
  }
  const current = usage?.currentPercent ?? (usage?.mode === "provider" ? usage.percent : null);
  const rows = [
    createUsageBarRow("Current", current),
  ];
  if (usage?.weeklyPercent !== null && usage?.weeklyPercent !== undefined) {
    rows.push(createUsageBarRow("Week", usage.weeklyPercent));
  }
  if (usage?.sonnetWeeklyPercent !== null && usage?.sonnetWeeklyPercent !== undefined) {
    rows.push(createUsageBarRow("Sonnet", usage.sonnetWeeklyPercent));
  }
  if (usage?.costTodayUsd || usage?.totalCostUsd) {
    rows.push(createUsageBarRow("Today", null, formatUsageMoney(usage.costTodayUsd, "USD") || "--"));
    rows.push(createUsageBarRow("Total", null, formatUsageMoney(usage.totalCostUsd, "USD") || "--"));
  }
  popover.append(...rows);
  return popover;
}

function createUsageBarRow(label, value, textOverride = "") {
  const percent = finitePercent(value);
  const row = document.createElement("span");
  row.className = "usage-bar-row";

  const labelEl = document.createElement("span");
  labelEl.className = "usage-bar-label";
  labelEl.textContent = label;

  const track = document.createElement("span");
  track.className = "usage-bar-track";
  const fill = document.createElement("span");
  fill.className = "usage-bar-fill";
  fill.style.width = percent === null || !Number.isFinite(percent) ? "0%" : `${percent}%`;
  track.appendChild(fill);

  const valueEl = document.createElement("span");
  valueEl.className = "usage-bar-value";
  valueEl.textContent = textOverride || (percent === null ? "--" : `${Math.round(percent)}%`);

  row.append(labelEl, track, valueEl);
  return row;
}

function finitePercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function formatUsageMoney(value, currency = "") {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const prefix = currency ? `${currency} ` : "";
  const places = Math.abs(number) > 0 && Math.abs(number) < 1 ? 4 : 2;
  return `${prefix}${number.toFixed(places)}`;
}

function markLocalUsageActive(supervisor, { countRun = true } = {}) {
  if (!supervisor) return;
  let usage = state.usage.find((item) => item.id === supervisor);
  if (!usage) {
    usage = { id: supervisor, percent: null, mode: "unknown", runsToday: 0, active: false };
    state.usage.push(usage);
  }
  usage.active = true;
  if (countRun) usage.runsToday = (usage.runsToday || 0) + 1;
  renderModelStatus();
}

async function openConnectModal() {
  el.connectDialog.showModal();
  await refreshConnections();
}

function setGithubStatus(message, kind = "info") {
  if (!el.githubStatus) return;
  el.githubStatus.textContent = message || "";
  el.githubStatus.dataset.kind = kind;
}

function renderGithubModalState(status) {
  if (!el.githubDialog) return;
  if (status?.publicKey) {
    el.githubPublicKey.value = status.publicKey;
    el.copyGithubKeyButton.disabled = false;
  } else {
    el.githubPublicKey.value = "";
    el.copyGithubKeyButton.disabled = true;
  }
  el.githubTokenInput.placeholder = status?.hasToken ? "Token already saved (paste to replace)" : "ghp_...";
}

async function openGithubModal() {
  if (!el.githubDialog) return;
  setGithubStatus("");
  if (el.githubSshResult) el.githubSshResult.textContent = "";
  el.githubDialog.showModal();
  try {
    const body = await api("/api/connections/github");
    state.githubStatus = body.github;
    renderGithubModalState(body.github);
  } catch (error) {
    state.githubStatus = {};
    setGithubStatus(`Status error: ${error.message}`, "error");
  }
}

function closeGithubModal() {
  el.githubDialog?.close();
}

async function handleGenerateGithubKey() {
  setGithubStatus("Generating SSH keypair...");
  try {
    const body = await api("/api/connections/github/keypair", { method: "POST" });
    state.githubStatus = body.github;
    renderGithubModalState(body.github);
    setGithubStatus(body.github.created ? "Keypair generated. Paste the key into GitHub, then run Test SSH." : "Existing keypair loaded.", "ok");
    void refreshGithubConnectionStatus();
  } catch (error) {
    setGithubStatus(`Generate error: ${error.message}`, "error");
  }
}

async function handleCopyGithubKey() {
  if (!el.githubPublicKey?.value) return;
  try {
    await navigator.clipboard.writeText(el.githubPublicKey.value);
    setGithubStatus("Public key copied.", "ok");
  } catch {
    el.githubPublicKey.select();
    setGithubStatus("Copy failed - selected the key for manual copy", "info");
  }
}

async function handleSaveGithubToken() {
  const token = el.githubTokenInput.value.trim();
  if (!token) { setGithubStatus("Paste a Personal Access Token first", "error"); return; }
  setGithubStatus("Verifying token...");
  try {
    const body = await api("/api/connections/github/token", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    state.githubStatus = body.github;
    renderGithubModalState(body.github);
    el.githubTokenInput.value = "";
    setGithubStatus(`Token verified for ${body.github.viewer?.login || "GitHub user"}.`, "ok");
    void refreshGithubConnectionStatus();
  } catch (error) {
    setGithubStatus(`Token error: ${error.message}`, "error");
  }
}

async function handleTestGithubSsh() {
  if (el.githubSshResult) {
    el.githubSshResult.textContent = "Testing...";
    el.githubSshResult.dataset.kind = "info";
  }
  try {
    const body = await api("/api/connections/github/test-ssh", { method: "POST" });
    const ok = Boolean(body.ssh?.connected);
    const text = ok ? `SSH ok - ${body.ssh.detail}` : `SSH not connected: ${body.ssh?.detail || "unknown"}`;
    if (el.githubSshResult) {
      el.githubSshResult.textContent = text;
      el.githubSshResult.dataset.kind = ok ? "ok" : "error";
    }
  } catch (error) {
    if (el.githubSshResult) {
      el.githubSshResult.textContent = `SSH test error: ${error.message}`;
      el.githubSshResult.dataset.kind = "error";
    }
  }
}

function closeConnectModal() {
  el.connectDialog.close();
}

async function handleSignOutAll() {
  if (!window.confirm("Sign out and revoke every model, GitHub, and Tailscale auth on this server?")) return;
  if (el.signOutAllStatus) {
    el.signOutAllStatus.textContent = "Signing out...";
    el.signOutAllStatus.dataset.state = "warn";
  }
  try {
    await api("/api/connections/sign-out-all", { method: "POST" });
    setStatus("Signed out everywhere");
    await Promise.allSettled([
      refreshModelStatus(),
      refreshGithubConnectionStatus(),
      refreshTailscaleStatus(),
    ]);
    if (el.signOutAllStatus) {
      el.signOutAllStatus.textContent = "";
      el.signOutAllStatus.dataset.state = "";
    }
  } catch (error) {
    setStatus(`Sign-out error: ${error.message}`);
    if (el.signOutAllStatus) {
      el.signOutAllStatus.textContent = "Error";
      el.signOutAllStatus.dataset.state = "warn";
    }
  }
}

async function refreshConnections() {
  el.connectionList.textContent = "Checking...";
  if (el.modelDialog.open && state.activeModelTab === "connection" && el.modelConnectIntroDetail) {
    el.modelConnectIntroDetail.textContent = "Checking connection status...";
  }
  try {
    const body = await api("/api/connections");
    state.connections = body.connections || [];
    for (const connection of state.connections) {
      if (!connection.job) continue;
      state.connectionJobs[connection.id] = connection.job;
      if (connection.job.status === "running") pollConnectionJob(connection.job.id, connection.id);
    }
    renderModelStatus();
    renderSupervisors();
    renderConnectionViews();
    updateModalState();
  } catch (error) {
    el.connectionList.textContent = `Error: ${error.message}`;
    if (el.modelDialog.open && state.activeModelTab === "connection" && el.modelConnectIntroDetail) {
      el.modelConnectIntroDetail.textContent = `Error: ${error.message}`;
    }
  }
}

async function refreshModelStatus() {
  try {
    const [connectionBody, usageBody] = await Promise.all([
      api("/api/connections"),
      api("/api/usage"),
    ]);
    state.connections = connectionBody.connections || [];
    state.usage = usageBody.usage || [];
    state.usageBudget = usageBody.budget || null;
    renderModelStatus();
    renderSupervisors();
    updateModalState();
  } catch (error) {
    setStatus(`Connection status error: ${error.message}`);
    renderModelStatus();
  }
}

async function refreshUsage() {
  try {
    const body = await api("/api/usage");
    state.usage = body.usage || [];
    state.usageBudget = body.budget || null;
    renderModelStatus();
  } catch (error) {
    setStatus(`Usage status error: ${error.message}`);
  }
}

function scheduleUsageRefreshBurst() {
  for (const delay of [0, 2500, 9000, 22000]) {
    setTimeout(() => {
      refreshUsage();
    }, delay);
  }
}

// Tells the server to kick a fresh provider probe (or per-supervisor probe) right now, then
// polls our cached snapshot a few times so the chip catches up as the probe writes back. Used on
// first page load and when a model run completes.
function triggerUsageProbe(supervisor = "") {
  const url = supervisor
    ? `/api/usage/refresh?supervisor=${encodeURIComponent(supervisor)}`
    : "/api/usage/refresh";
  // Fire-and-forget; the probe runs in the background server-side, the burst polls bring fresh
  // numbers to the UI as they land.
  api(url, { method: "POST" }).catch(() => { /* silent: chip stays on cached data */ });
  scheduleUsageRefreshBurst();
}

function renderConnections({ captureScroll = true } = {}) {
  if (captureScroll) captureConnectionOutputScrolls();
  const activeInput = document.activeElement?.dataset?.connectionInput;
  if (activeInput) {
    state.focusedConnectionInput = activeInput;
    state.connectionInputs[activeInput] = document.activeElement.value;
  }

  el.connectionList.innerHTML = "";
  for (const connection of state.connections) {
    el.connectionList.appendChild(createConnectionItem(connection));
  }

  restoreFocusedConnectionInput();
}

function createConnectionItem(connection) {
  const item = document.createElement("section");
  item.className = "connection-item";

  const head = document.createElement("div");
  head.className = "connection-head";

  const name = document.createElement("div");
  name.className = "connection-name";
  name.textContent = connection.label;

  const badge = document.createElement("div");
  badge.className = `connection-state ${connection.connected ? "connected" : ""}`;
  badge.textContent = connection.connected ? "connected" : "not connected";

  const detail = document.createElement("div");
  detail.className = "connection-detail";
  detail.textContent = connection.detail || "";

  head.append(name, badge);
  item.append(head, detail);
  item.append(createConnectionActions(connection));

  const job = state.connectionJobs[connection.id] || connection.job;
  if (job) item.append(createConnectionJobPanel(job, connection.id));

  return item;
}

function renderConnectionViews() {
  captureConnectionOutputScrolls();
  renderConnections({ captureScroll: false });
  renderModelDialog({ captureScroll: false });
  restoreFocusedConnectionInput();
}

function restoreFocusedConnectionInput() {
  if (!state.focusedConnectionInput) return;
  const input = el.connectionList.querySelector(`[data-connection-input="${state.focusedConnectionInput}"]`) ||
    el.modelConnectionPanel.querySelector(`[data-connection-input="${state.focusedConnectionInput}"]`);
  if (!input) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function createConnectionActions(connection) {
  const actions = document.createElement(connection.action === "api-key" ? "form" : "div");
  actions.className = "connection-actions";

  if (connection.action === "api-key") {
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = "DeepSeek API key";
    input.setAttribute("aria-label", "DeepSeek API key");
    input.dataset.connectionKey = connection.id;

    const button = document.createElement("button");
    button.type = "submit";
    button.className = "primary";
    button.textContent = connection.connected ? "Update key" : "Save key";

    actions.addEventListener("submit", (event) => {
      event.preventDefault();
      void withButtonBusy(button, "Saving...", () => startConnection(connection.id));
    });
    actions.append(input, button);
    return actions;
  }

  const job = state.connectionJobs[connection.id] || connection.job;
  const running = job?.status === "running";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary";
  button.disabled = running;
  button.textContent = running ? "Connecting..." : (connection.connected ? "Reconnect" : "Connect");
  button.addEventListener("click", () => {
    void withButtonBusy(button, "Connecting...", () => startConnection(connection.id));
  });
  actions.append(button);
  return actions;
}

function modelDialogConnection() {
  return state.connections.find((connection) => connection.id === state.activeModelId);
}

function setModelDialogTab(tab) {
  storeActiveModelPromptDraft();
  state.activeModelTab = tab;
  renderModelDialog();
}

function renderModelDialogTabs() {
  el.modelDialogTabs.innerHTML = "";
  const tabs = [
    { id: "connection", label: "Connection" },
    { id: "prompt", label: "Prompt" },
  ];
  for (const tab of tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `prompt-tab ${state.activeModelTab === tab.id ? "active" : ""}`;
    button.role = "tab";
    button.setAttribute("aria-selected", String(state.activeModelTab === tab.id));
    button.textContent = tab.label;
    button.addEventListener("click", () => setModelDialogTab(tab.id));
    el.modelDialogTabs.appendChild(button);
  }
}

function renderModelConnectionPanel({ captureScroll = true } = {}) {
  if (captureScroll) captureConnectionOutputScrolls();
  const connection = modelDialogConnection();
  if (!connection) {
    el.modelConnectIntroDetail.textContent = "Connection status unavailable.";
    return;
  }

  const job = state.connectionJobs[connection.id] || connection.job;
  const running = job?.status === "running";

  if (el.modelConnectStatusDot) {
    el.modelConnectStatusDot.dataset.state = connection.connected ? "ok" : (running ? "pending" : "off");
  }

  let detailText;
  if (connection.connected) detailText = `Connected${connection.detail ? ` - ${connection.detail}` : ""}.`;
  else if (running) detailText = "Waiting for login...";
  else detailText = connection.detail || "Not connected yet.";
  el.modelConnectIntroDetail.textContent = detailText;

  el.modelConnectSetupBody.innerHTML = "";
  el.modelConnectSetupBody.appendChild(createConnectionActions(connection));

  if (job) {
    el.modelConnectJobOutput.hidden = false;
    el.modelConnectJobOutput.innerHTML = "";
    el.modelConnectJobOutput.appendChild(createConnectionJobPanel(job, connection.id));
  } else {
    el.modelConnectJobOutput.hidden = true;
    el.modelConnectJobOutput.innerHTML = "";
  }

  restoreFocusedConnectionInput();
}

function renderModelPromptPanel() {
  const prompt = promptForModel(state.activeModelId);
  el.modelPromptStatus.classList.remove("is-error");
  if (!prompt) {
    el.modelPromptEditor.value = "";
    el.modelPromptEditor.disabled = true;
    el.saveModelPrompt.disabled = true;
    el.resetModelPrompt.disabled = true;
    el.modelPromptStatus.textContent = "Loading prompt...";
    return;
  }
  el.modelPromptEditor.disabled = false;
  el.saveModelPrompt.disabled = false;
  el.resetModelPrompt.disabled = !prompt.sourceAvailable;
  el.modelPromptEditor.value = state.promptDrafts[prompt.id] ?? prompt.content ?? "";
  el.modelPromptStatus.classList.toggle("is-error", !prompt.sourceAvailable);
  el.modelPromptStatus.textContent = promptStatusText(prompt);
}

function renderModelDialog({ captureScroll = true } = {}) {
  if (!el.modelDialog.open || !state.activeModelId) return;
  const connection = modelDialogConnection();
  const prompt = promptForModel(state.activeModelId);
  el.modelDialogTitle.textContent = connection?.label || prompt?.label || state.activeModelId;
  renderModelDialogTabs();
  const showPrompt = state.activeModelTab === "prompt";
  el.modelConnectionPanel.hidden = showPrompt;
  el.modelPromptPanel.hidden = !showPrompt;
  if (showPrompt) renderModelPromptPanel();
  else renderModelConnectionPanel({ captureScroll });
}

async function openModelModal(id) {
  state.activeModelId = id;
  state.activeModelTab = "connection";
  el.modelPromptStatus.textContent = "";
  if (!el.modelDialog.open) el.modelDialog.showModal();
  renderModelDialog();
  await Promise.allSettled([
    refreshConnections(),
    state.prompts.length ? Promise.resolve() : loadPromptSettings(),
  ]);
  renderModelDialog();
}

function closeModelModal() {
  storeActiveModelPromptDraft();
  state.activeModelId = null;
  state.activeModelTab = "connection";
  el.modelDialog.close();
}

function rememberConnectionOutputScroll(output, connectionId) {
  if (!connectionId || !output) return;
  state.connectionOutputScroll[connectionId] = {
    top: output.scrollTop,
    stick: isNearBottom(output),
  };
}

function captureConnectionOutputScrolls() {
  for (const output of document.querySelectorAll("[data-connection-output]")) {
    rememberConnectionOutputScroll(output, output.dataset.connectionOutput);
  }
}

function restoreConnectionOutputScroll(output, connectionId) {
  const saved = state.connectionOutputScroll[connectionId];
  const stick = saved?.stick !== false;
  requestAnimationFrame(() => {
    if (!document.contains(output)) return;
    if (stick) {
      scrollElementToBottom(output);
      return;
    }
    output.scrollTop = Math.min(saved?.top || 0, output.scrollHeight);
  });
}

function extractExternalSignInUrls(text) {
  const seen = new Set();
  const urls = [];
  const pattern = /https?:\/\/[^\s<>"'`]+/g;
  for (const match of String(text || "").matchAll(pattern)) {
    const url = match[0].replace(/[)\].,;:]+$/g, "");
    if (!url || seen.has(url)) continue;
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    const host = parsed.hostname.toLowerCase();
    // Skip loopback callback URLs the CLI also prints (codex's localhost:1455, etc) — we only want
    // the real provider sign-in page.
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") continue;
    if (!/^https?:$/.test(parsed.protocol)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function createConnectionJobPanel(job, connectionId) {
  const panel = document.createElement("div");
  panel.className = "connection-job";

  const status = document.createElement("div");
  status.className = `connection-job-status ${job.status}`;
  status.textContent = job.status === "running" ? "Waiting for login..." : job.status;
  panel.appendChild(status);

  // Without the output panel a failed job would be silent — surface the error in a short line.
  if (job.status === "failed" && job.error) {
    const err = document.createElement("div");
    err.className = "connection-job-status failed";
    err.textContent = String(job.error).split("\n")[0].slice(0, 240);
    panel.appendChild(err);
  }

  // Auto-pop the provider sign-in URL the first time the CLI prints it, and offer a button as a
  // popup-blocker fallback. We never render the raw output blob in the wizard.
  const signInUrls = extractExternalSignInUrls(job.output);
  if (signInUrls.length) {
    for (const url of signInUrls) {
      const key = `${job.id}:${url}`;
      if (state.openedJobSignInUrls.has(key)) continue;
      state.openedJobSignInUrls.add(key);
      try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* popup blocked — fallback button below covers it */ }
    }
    if (job.status === "running") {
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "secondary";
      openButton.textContent = "Open sign-in page";
      openButton.addEventListener("click", () => {
        window.open(signInUrls[0], "_blank", "noopener,noreferrer");
      });
      panel.appendChild(openButton);
    }
  }

  if (job.status === "running") {
    const inputRow = document.createElement("div");
    inputRow.className = "connection-input-row";

    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = "Paste code or answer";
    input.setAttribute("aria-label", "Connection input");
    input.dataset.connectionInput = connectionId;
    input.value = state.connectionInputs[connectionId] || "";
    input.addEventListener("focus", () => {
      state.focusedConnectionInput = connectionId;
    });
    input.addEventListener("input", () => {
      state.connectionInputs[connectionId] = input.value;
    });
    input.addEventListener("paste", () => {
      setTimeout(() => {
        state.connectionInputs[connectionId] = input.value;
      });
    });
    // Mouse-down on the Send button would normally steal focus before the click fires; we want
    // the input to keep focus through the click so the user can keep typing without re-clicking it.
    const submitFromInput = () => {
      state.focusedConnectionInput = connectionId;
      sendConnectionInput(job.id, input.value, connectionId);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitFromInput();
      }
    });

    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Send";
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", submitFromInput);

    inputRow.append(input, button);
    panel.appendChild(inputRow);
  }

  return panel;
}

async function startConnection(id) {
  const payload = {};
  if (id === "deepseek") {
    const modelInput = el.modelDialog.open && state.activeModelId === id
      ? el.modelConnectionPanel.querySelector(`[data-connection-key="${id}"]`)
      : null;
    const input = modelInput ||
      el.connectionList.querySelector(`[data-connection-key="${id}"]`);
    payload.apiKey = input?.value || "";
  }
  const connection = state.connections.find((item) => item.id === id);
  const previousDetail = connection?.detail;
  try {
    const body = await api(`/api/connections/${id}/start`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (body.job) {
      state.connectionJobs[id] = body.job;
      renderModelStatus();
      renderConnectionViews();
      pollConnectionJob(body.job.id, id);
    } else {
      await refreshConnections();
      scheduleUsageRefreshBurst();
    }
  } catch (error) {
    if (connection) connection.detail = `Error: ${error.message}`;
    renderConnectionViews();
    if (connection) connection.detail = previousDetail;
  }
}

async function sendConnectionInput(jobId, input, connectionId) {
  if (!input.trim()) return;
  // Keep focus on the input through the re-render so the user can keep typing.
  state.focusedConnectionInput = connectionId;
  try {
    const body = await api(`/api/connections/jobs/${jobId}/input`, {
      method: "POST",
      body: JSON.stringify({ input }),
    });
    state.connectionJobs[connectionId] = body.job;
    state.connectionInputs[connectionId] = "";
    renderConnectionViews();
  } catch (error) {
    const job = state.connectionJobs[connectionId];
    if (job) job.output = `${job.output || ""}\nError: ${error.message}\n`;
    renderConnectionViews();
  }
}

function pollConnectionJob(jobId, connectionId) {
  if (state.connectionPollers[jobId]) return;
  const tick = async () => {
    try {
      const body = await api(`/api/connections/jobs/${jobId}`);
      const prev = state.connectionJobs[connectionId];
      state.connectionJobs[connectionId] = body.job;
      // We no longer render the raw CLI output blob in the wizard, so output-only deltas
      // shouldn't kick a re-render that would destroy the user's code/answer input mid-paste.
      // Re-render only when the user-visible state actually changes: status flip, new error,
      // or the very first time a sign-in URL appears (so we can pop the tab).
      const prevHadUrl = prev ? extractExternalSignInUrls(prev.output).length > 0 : false;
      const nextHasUrl = extractExternalSignInUrls(body.job.output).length > 0;
      const visibleChanged = !prev
        || prev.status !== body.job.status
        || prev.error !== body.job.error
        || (!prevHadUrl && nextHasUrl);
      if (visibleChanged) renderConnectionViews();
      if (body.job.status === "running") {
        state.connectionPollers[jobId] = setTimeout(tick, 1500);
        return;
      }
      delete state.connectionPollers[jobId];
      await refreshConnections();
      scheduleUsageRefreshBurst();
    } catch (error) {
      delete state.connectionPollers[jobId];
      const job = state.connectionJobs[connectionId];
      if (job) job.output = `${job.output || ""}\nError: ${error.message}\n`;
      renderConnectionViews();
    }
  };
  state.connectionPollers[jobId] = setTimeout(tick, 900);
}

function projectRows() {
  const rows = [];
  const seen = new Set();
  for (const session of state.sessions) {
    const cwd = session.cwd || session.project || ".";
    rows.push({ ...session, cwd, project: session.project || cwd, hasSession: true });
    seen.add(cwd);
  }
  for (const project of state.projects) {
    if (seen.has(project)) continue;
    rows.push({
      id: null,
      title: project,
      project,
      cwd: project,
      supervisor: state.config?.defaultSupervisor,
      messageCount: 0,
      updatedAt: "",
      hasSession: false,
    });
  }
  return rows.sort((a, b) => {
    if (a.updatedAt && b.updatedAt) return String(b.updatedAt).localeCompare(String(a.updatedAt));
    if (a.updatedAt) return -1;
    if (b.updatedAt) return 1;
    return String(a.project).localeCompare(String(b.project));
  });
}

function isCurrentProject(project) {
  if (!state.currentSession || !project) return false;
  return Boolean(project.id && project.id === state.currentSession.id)
    || Boolean(project.cwd && project.cwd === state.currentSession.cwd)
    || Boolean(project.project && project.project === state.currentSession.project);
}

function projectMenuKey(project) {
  return project?.cwd || project?.project || project?.title || "";
}

function projectIsRunning(project) {
  return Boolean(project?.id && state.runs.get(project.id)?.streaming);
}

function projectAutopilotEnabled(project) {
  return project?.autopilotEnabled === true;
}

function configuredAutopilotFeedLimit() {
  const value = Number(state.config?.autopilotFeedLimit);
  if (!Number.isFinite(value)) return 2;
  return Math.max(0, Math.min(10, Math.round(value)));
}

async function setProjectAutopilot(project, enabled) {
  const key = projectMenuKey(project);
  if (!key || !project?.id) return;
  try {
    const body = await api(`/api/sessions/${project.id}`, {
      method: "PATCH",
      body: JSON.stringify({ autopilotEnabled: enabled }),
    });
    const session = body.session;
    if (session) {
      upsertSessionSummary(session);
      if (isViewing(session.id)) state.currentSession = session;
    }
    renderSessions();
    syncComposerState();
    setStatus(`${key} autopilot ${enabled ? "on" : "paused"}`);
    if (enabled && state.currentSession?.id === project.id) scheduleAutopilot(state.currentSession);
    // Disabling autopilot must drop any in-flight scheduled decision; otherwise the 450 ms timer
    // fires and the server returns 409 "Autopilot is paused".
    if (!enabled) cancelScheduledAutopilot(project.id);
  } catch (error) {
    setStatus(`Autopilot toggle error: ${error.message}`);
  }
}

async function clearAutopilotHistoryFromUi(project) {
  if (!project?.id) return;
  if (projectIsRunning(project)) {
    setStatus("Stop the running model before clearing Autopilot activity");
    return;
  }
  const confirmed = window.confirm(`Clear Autopilot activity for "${project.project || project.title || project.cwd || "this project"}"?`);
  if (!confirmed) return;
  try {
    const body = await api(`/api/sessions/${project.id}/autopilot-history`, { method: "DELETE" });
    if (body.session) {
      if (state.currentSession?.id === project.id) state.currentSession = body.session;
      upsertSessionSummary(body.session);
    }
    renderSessions();
    setStatus("Autopilot activity cleared");
  } catch (error) {
    setStatus(`Autopilot clear error: ${error.message}`);
  }
}

function autopilotContent(decision) {
  const content = String(decision?.content || "").trim();
  if (!content) return "";
  return /^autopilot\s*:/i.test(content) ? content : `Autopilot:\n${content}`;
}

async function maybeRunAutopilot(session) {
  if (!session?.id || !projectAutopilotEnabled(session)) return;
  if (state.runs.has(session.id)) return;
  const projectName = projectMenuKey(session);
  try {
    setStatus(`${projectName} autopilot thinking...`);
    const body = await api(`/api/sessions/${session.id}/autopilot`, { method: "POST" });
    const decision = body.decision || {};
    if (body.session) {
      session = body.session;
      upsertSessionSummary(session);
      if (isViewing(session.id)) state.currentSession = session;
      renderSessions();
    }
    if (!projectAutopilotEnabled(session)) {
      setStatus(`${projectName} autopilot off`);
      return;
    }
    await sendAutopilotDecision(session, decision);
  } catch (error) {
    setStatus(`Autopilot error: ${error.message}`);
  }
}

async function sendAutopilotDecision(session, decision) {
  if (!session?.id || !projectAutopilotEnabled(session)) return false;
  if (state.runs.has(session.id) || state.pendingSends.has(session.id)) return false;
  const projectName = projectMenuKey(session);
  if (decision?.action !== "message") {
    setStatus(`Autopilot stopped: ${decision?.reason || "no next action"}`);
    return false;
  }
  const content = autopilotContent(decision);
  if (!content) {
    setStatus("Autopilot decision had no next message");
    return false;
  }
  setStatus(`${projectName} autopilot sending...`);
  return sendMessageForSession(session, content, [], { source: "autopilot" });
}

function scheduleAutopilot(session) {
  if (!session?.id || !projectAutopilotEnabled(session) || !autopilotNeedsDecision(session)) return;
  if (state.autopilotTimers.has(session.id)) return;
  const handle = setTimeout(() => {
    state.autopilotTimers.delete(session.id);
    maybeRunAutopilot(session);
  }, 450);
  state.autopilotTimers.set(session.id, handle);
}

function cancelScheduledAutopilot(sessionId) {
  const handle = state.autopilotTimers.get(sessionId);
  if (handle !== undefined) {
    clearTimeout(handle);
    state.autopilotTimers.delete(sessionId);
  }
}

async function resumeAutopilotSession(sessionSummary) {
  if (!autopilotCanResumeFromSummary(sessionSummary)) return;
  if (state.runs.has(sessionSummary.id) || state.autopilotTimers.has(sessionSummary.id)) return;
  // Always fetch the canonical session by id. The summary in state.sessions lacks `messages` and
  // `state.currentSession` would be a stale snapshot once we await — both can race with the user
  // switching projects and feed the wrong object to scheduleAutopilot.
  const { session } = await api(`/api/sessions/${sessionSummary.id}`);
  scheduleAutopilot(session);
}

async function resumeAutopilotSessions() {
  // Fan out resume probes in parallel so a workspace with N autopilot sessions does not pay N
  // sequential round-trips at init. allSettled keeps one failure from masking the rest.
  await Promise.allSettled(state.sessions.map((session) => resumeAutopilotSession(session)));
}

function closeProjectContextMenu() {
  if (!el.projectContextMenu) return;
  el.projectContextMenu.hidden = true;
  state.projectMenuProject = null;
}

function positionProjectContextMenu(clientX, clientY) {
  const menu = el.projectContextMenu;
  if (!menu) return;
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, clientX), window.innerWidth - rect.width - margin);
    const top = Math.min(Math.max(margin, clientY), window.innerHeight - rect.height - margin);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  });
}

function openProjectContextMenu(event, project) {
  event.preventDefault();
  event.stopPropagation();
  if (!el.projectContextMenu) return;
  closeAttachmentMenu();
  const key = projectMenuKey(project);
  if (!key) return;

  state.projectMenuProject = project;
  const autopilotOn = projectAutopilotEnabled(project);
  const running = projectIsRunning(project);
  const hasAutopilotFeed = normalizeAutopilotFeed(project.autopilotFeed, { limit: configuredAutopilotFeedLimit() }).length > 0;
  el.projectContextMenu.innerHTML = "";

  const autopilot = document.createElement("button");
  autopilot.type = "button";
  autopilot.role = "menuitemcheckbox";
  autopilot.setAttribute("aria-checked", String(autopilotOn));
  autopilot.className = "project-context-item";
  autopilot.innerHTML = `<span>Autopilot</span><strong>${autopilotOn ? "On" : "Off"}</strong>`;
  autopilot.addEventListener("click", () => {
    closeProjectContextMenu();
    void setProjectAutopilot(project, !autopilotOn);
  });

  const supervisorSeparator = document.createElement("div");
  supervisorSeparator.className = "project-context-separator";

  const supervisorHeader = document.createElement("div");
  supervisorHeader.className = "project-context-header";
  supervisorHeader.textContent = "Supervisor";

  const supervisorItems = [];
  for (const supervisor of Object.values(state.config?.supervisors || {})) {
    const item = document.createElement("button");
    item.type = "button";
    item.role = "menuitemradio";
    item.className = "project-context-item";
    const isCurrent = supervisor.id === project.supervisor;
    item.setAttribute("aria-checked", String(isCurrent));
    const connected = isSupervisorConnected(supervisor.id);
    item.disabled = running || (!isCurrent && !connected) || !project.id;
    const status = isCurrent ? "Current" : connected ? "" : "Not connected";
    item.innerHTML = `<span>${supervisor.label}</span>${status ? `<strong>${status}</strong>` : ""}`;
    item.addEventListener("click", async () => {
      closeProjectContextMenu();
      if (isCurrent) return;
      await setProjectSupervisor(project, supervisor.id);
    });
    supervisorItems.push(item);
  }

  const separator = document.createElement("div");
  separator.className = "project-context-separator";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.role = "menuitem";
  remove.className = "project-context-item danger";
  remove.disabled = running;
  remove.innerHTML = `<span>Delete</span>${running ? "<strong>Running</strong>" : ""}`;
  remove.addEventListener("click", async () => {
    closeProjectContextMenu();
    await deleteProjectFromUi(project);
  });

  el.projectContextMenu.append(autopilot, supervisorSeparator, supervisorHeader, ...supervisorItems, separator, remove);
  el.projectContextMenu.hidden = false;
  positionProjectContextMenu(event.clientX, event.clientY);
  autopilot.focus();
}

async function setProjectSupervisor(project, supervisorId) {
  if (!project?.id) {
    setStatus("Open the chat once before switching supervisor");
    return;
  }
  if (!isSupervisorConnected(supervisorId)) {
    setStatus(`${state.config?.supervisors?.[supervisorId]?.label || supervisorId} is not connected`);
    return;
  }
  try {
    const body = await api(`/api/sessions/${project.id}/supervisor`, {
      method: "POST",
      body: JSON.stringify({ supervisor: supervisorId }),
    });
    const session = body.session;
    if (session) {
      upsertSessionSummary(session);
      if (isViewing(session.id)) state.currentSession = session;
    }
    renderSessions();
    syncComposerState();
    setStatus(`Supervisor switched to ${state.config?.supervisors?.[supervisorId]?.label || supervisorId}`);
  } catch (error) {
    setStatus(`Supervisor change error: ${error.message}`);
  }
}

function renderSessions() {
  el.sessionList.innerHTML = "";
  const rows = projectRows();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = "No projects yet";
    el.sessionList.appendChild(empty);
    return;
  }
  for (const session of rows) {
    const running = projectIsRunning(session);
    const autopilotOn = projectAutopilotEnabled(session);
    const row = document.createElement("div");
    row.className = [
      "session",
      isCurrentProject(session) ? "active" : "",
      running ? "running" : "",
      autopilotOn ? "autopilot-on" : "",
    ].filter(Boolean).join(" ");
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    const autopilotIcon = document.createElement("button");
    autopilotIcon.type = "button";
    autopilotIcon.className = "session-autopilot-icon";
    const label = state.autopilotPhases.get(session.id) || autopilotStateLabel(session.autopilotState, autopilotOn);
    const displayLabel = autopilotOn ? label : "off";
    autopilotIcon.dataset.state = displayLabel;
    autopilotIcon.setAttribute("aria-pressed", String(autopilotOn));
    autopilotIcon.title = session.id
      ? `Autopilot ${displayLabel}. Click to turn ${autopilotOn ? "off" : "on"}.`
      : "Open the project before enabling Autopilot.";
    autopilotIcon.setAttribute("aria-label", session.id ? `Autopilot ${displayLabel}` : "Autopilot unavailable");
    autopilotIcon.disabled = !session.id;
    autopilotIcon.innerHTML = iconSvg(icons.autopilot);
    autopilotIcon.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void setProjectAutopilot(session, !autopilotOn);
    });
    row.appendChild(autopilotIcon);

    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = session.title || "New chat";
    if (running) {
      const dot = document.createElement("span");
      dot.className = "session-running-dot";
      dot.title = "Model running";
      title.prepend(dot);
    }

    const meta = document.createElement("div");
    meta.className = "session-meta";
    const autopilotLabel = autopilotOn ? ` - autopilot ${state.autopilotPhases.get(session.id) || autopilotStateLabel(session.autopilotState, autopilotOn)}` : "";
    meta.textContent = `${session.supervisor || "unknown"} - ${session.messageCount || 0} msgs${autopilotLabel}`;

    row.append(title, meta);
    const feed = normalizeAutopilotFeed(session.autopilotFeed, { limit: configuredAutopilotFeedLimit() });
    if (feed.length) {
      const activity = document.createElement("div");
      activity.className = "session-autopilot-feed";
      activity.textContent = feed.map((entry) => autopilotFeedEntryLabel(entry)).join(" | ");
      activity.title = feed
        .map((entry) => [autopilotFeedEntryLabel(entry), entry.reason].filter(Boolean).join(": "))
        .join("\n");
      row.appendChild(activity);
    }
    row.addEventListener("click", () => openProjectSession(session));
    row.addEventListener("contextmenu", (event) => openProjectContextMenu(event, session));
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openProjectSession(session);
        return;
      }
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      const rect = row.getBoundingClientRect();
      openProjectContextMenu({
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
        clientX: rect.left + Math.min(rect.width - 12, 24),
        clientY: rect.top + Math.min(rect.height - 8, 28),
      }, session);
    });

    el.sessionList.appendChild(row);
  }
}

function renderMessages({ forceScroll = false } = {}) {
  const shouldStick = forceScroll || isNearBottom(el.messages) || el.messages.childElementCount === 0;
  el.messages.innerHTML = "";
  if (!state.currentSession) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Start a new chat.";
    el.messages.appendChild(empty);
    if (shouldStick) scrollMessagesToBottom();
    return;
  }
  if (!state.currentSession.messages?.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = `${state.currentSession.supervisor} in ${workspaceText(state.currentSession.cwd)}`;
    el.messages.appendChild(empty);
    if (shouldStick) scrollMessagesToBottom();
    return;
  }
  for (const message of state.currentSession.messages) {
    el.messages.appendChild(createMessageElement(message));
  }
  if (shouldStick) scrollMessagesToBottom();
  else updateScrollToBottomVisibility();
}

function createMessageElement(message) {
  const article = document.createElement("article");
  article.className = messageClassNames(message);

  const head = document.createElement("div");
  head.className = "message-head";

  const who = document.createElement("span");
  who.textContent = message.role === "assistant" ? (message.supervisor || "assistant") : "You";
  const stateLabel = messageStateLabel(message);
  if (stateLabel && stateLabel !== "live") who.textContent += ` (${stateLabel})`;
  if (message.safetyRedacted) who.textContent += " (redacted)";

  const when = document.createElement("span");
  when.className = "message-time";
  when.textContent = stateLabel === "live" ? "live" : formatDate(message.at);

  const body = document.createElement("div");
  body.className = "message-body";
  renderMessageBody(body, message);

  const headRight = document.createElement("div");
  headRight.className = "message-head-right";
  headRight.append(createMessageActions(message), when);

  head.append(who, headRight);
  article.append(head, body);
  if (message.attachments?.length) article.append(createAttachmentList(message.attachments, false));
  return article;
}

function messageTextForCopy(message) {
  return String(message.content || message.status || "").trim();
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

function showCopiedFeedback(button) {
  const previousLabel = button.dataset.idleLabel || button.getAttribute("aria-label") || "Copy message";
  button.dataset.idleLabel = previousLabel;
  button.classList.add("is-copied");
  button.setAttribute("aria-label", "Copied");
  window.clearTimeout(button._copiedTimer);
  button._copiedTimer = window.setTimeout(() => {
    button.classList.remove("is-copied");
    button.setAttribute("aria-label", previousLabel);
  }, 1200);
}

async function resendUserMessage(message) {
  if (!state.currentSession) return;
  if (state.runs.has(state.currentSession.id)) {
    setStatus("Wait for the current supervisor to finish");
    return;
  }
  const content = messageTextForCopy(message);
  if (!content || (message.attachments?.length && content === "Attached files")) {
    setStatus("Cannot resend an attachment-only message");
    return;
  }
  await sendMessageForSession(state.currentSession, content);
}

function createMessageActionButton({ icon, label, onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-action-button";
  button.setAttribute("aria-label", label);
  button.innerHTML = iconSvg(icon);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await onClick(button);
    } catch (error) {
      setStatus(`Action error: ${error.message}`);
    }
  });
  return button;
}

function createMessageActions(message) {
  const actions = document.createElement("div");
  actions.className = "message-actions";

  const text = messageTextForCopy(message);
  if (text) {
    actions.appendChild(createMessageActionButton({
      icon: icons.copy,
      label: "Copy message",
      onClick: async (button) => {
        await copyTextToClipboard(messageTextForCopy(message));
        showCopiedFeedback(button);
      },
    }));
  }

  if (message.role === "user") {
    actions.appendChild(createMessageActionButton({
      icon: icons.reload,
      label: "Resend message",
      onClick: () => resendUserMessage(message),
    }));
  }

  return actions;
}

const URL_PATTERN = /(https?:\/\/[^\s<>()]+)/g;
const HTML_FENCE_PATTERN = /```(?:html?|xhtml)\s*\n?([\s\S]*?)```/gi;

// Appends text to a node, turning http(s) URLs into target=_blank links. Built via DOM nodes only
// (no innerHTML) and limited to http/https, so message content cannot inject markup.
function appendLinkified(container, value) {
  const text = String(value ?? "");
  let lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,;:!?)'"\]]+$/, "");
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = url;
    container.appendChild(link);
    lastIndex = match.index + url.length;
  }
  if (lastIndex < text.length) container.appendChild(document.createTextNode(text.slice(lastIndex)));
}

function looksLikeStandaloneHtml(value) {
  return /^\s*(?:<!doctype\s+html|<html[\s>]|<body[\s>]|<iframe[\s>])/i.test(value || "");
}

function splitMessageContent(message) {
  const rawContent = String(message.content || message.status || (message.streaming ? "Starting..." : ""));
  if (message.role !== "assistant") return [{ type: "text", content: rawContent }];

  // A failed/stopped assistant turn that produced megabytes of raw transcript would otherwise
  // render the entire dump into the chat bubble. Collapse to the trailing reason; the full
  // payload remains accessible via the terminal button.
  const content = shouldCollapseTerminalContent(message)
    ? extractErrorReason(rawContent, { error: Boolean(message.error) })
    : rawContent;

  const parts = [];
  let lastIndex = 0;
  for (const match of content.matchAll(HTML_FENCE_PATTERN)) {
    if (match.index > lastIndex) parts.push({ type: "text", content: content.slice(lastIndex, match.index) });
    parts.push({ type: "html", content: match[1].trim() });
    lastIndex = match.index + match[0].length;
  }
  if (parts.length) {
    if (lastIndex < content.length) parts.push({ type: "text", content: content.slice(lastIndex) });
    return parts;
  }
  if (looksLikeStandaloneHtml(content.trim())) return [{ type: "html", content: content.trim() }];
  return [{ type: "text", content }];
}

function createHtmlPreview(html) {
  const preview = document.createElement("div");
  preview.className = "html-preview";

  const frame = document.createElement("iframe");
  frame.className = "html-preview-frame";
  frame.title = "HTML preview";
  frame.loading = "lazy";
  frame.referrerPolicy = "no-referrer";
  frame.sandbox = "allow-scripts allow-forms allow-popups allow-modals allow-presentation";
  frame.srcdoc = html;
  preview.appendChild(frame);
  return preview;
}

function renderMessageBody(body, message) {
  body.innerHTML = "";

  for (const part of splitMessageContent(message)) {
    if (part.type === "html") {
      body.appendChild(createHtmlPreview(part.content));
      continue;
    }
    if (!part.content) continue;
    const text = document.createElement("span");
    appendLinkified(text, part.content);
    body.appendChild(text);
  }

  const hasTerminalContent = message.streaming || message.trace?.length || message.timeline?.length;
  const showForCollapsedError = shouldCollapseTerminalContent(message);
  if (!hasTerminalContent && !showForCollapsedError) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "terminal-open-button";
  const title = showForCollapsedError && !hasTerminalContent ? "Show full output" : "Open terminal";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = iconSvg(icons.terminal);
  button.addEventListener("click", () => openTerminalModal(message));
  body.appendChild(button);

  if (!message.streaming) return;
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.className = "stop-run-button";
  stopButton.title = "Stop model";
  stopButton.setAttribute("aria-label", "Stop model");
  stopButton.disabled = Boolean(currentRun()?.stopInFlight);
  stopButton.innerHTML = iconSvg(icons.stop);
  stopButton.addEventListener("click", stopActiveRun);
  body.appendChild(stopButton);
}

function terminalTitleFor(message) {
  const supervisor = message?.supervisor || "model";
  return `${supervisor} terminal`;
}

function terminalText(message) {
  if (message?.trace?.length) return message.trace.join("");
  // For collapsed errors there is no captured trace but the full raw output is in `content`;
  // route it into the terminal modal so the user can still inspect what the model produced.
  if (shouldCollapseTerminalContent(message)) return String(message.content || "");
  return "Waiting for terminal output...";
}

function timelineStatusLabel(status) {
  if (status === "completed") return "done";
  if (status === "failed") return "error";
  if (status === "stopped") return "stopped";
  if (status === "running") return "running";
  return "info";
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds}s`;
}

function formatTimelineTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toISOString().slice(11, 19)}Z`;
}

function formatTimelineMetaValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createTimelineMetaList(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const entries = Object.entries(meta)
    .map(([key, value]) => [key, formatTimelineMetaValue(value)])
    .filter(([, value]) => value);
  if (!entries.length) return null;

  const list = document.createElement("dl");
  list.className = "timeline-meta-lines";
  for (const [key, value] of entries) {
    const term = document.createElement("dt");
    term.textContent = key;
    const detail = document.createElement("dd");
    detail.textContent = value;
    list.append(term, detail);
  }
  return list;
}

function createTimelineCard(event) {
  const details = document.createElement("details");
  details.className = `timeline-card ${event.status || "info"}`;
  details.open = state.openTimelineCards.has(event.id);

  const summary = document.createElement("summary");
  summary.className = "timeline-summary";

  const title = document.createElement("span");
  title.className = "timeline-title";
  title.textContent = event.title || event.kind || "step";

  const meta = document.createElement("span");
  meta.className = "timeline-meta";
  meta.textContent = [
    formatTimelineTime(event.at),
    event.kind || "info",
    timelineStatusLabel(event.status),
    formatDuration(event.durationMs),
  ].filter(Boolean).join(" · ");

  summary.append(title, meta);
  details.appendChild(summary);

  const metaList = createTimelineMetaList(event.meta);
  if (metaList) details.appendChild(metaList);

  const body = document.createElement("pre");
  body.className = "timeline-detail";
  let loaded = false;
  if (details.open) {
    body.textContent = event.detail || "No extra details for this step.";
    loaded = true;
  }
  details.addEventListener("toggle", () => {
    if (details.open) state.openTimelineCards.add(event.id);
    else state.openTimelineCards.delete(event.id);
    if (!details.open || loaded) return;
    body.textContent = event.detail || "No extra details for this step.";
    loaded = true;
  });
  details.appendChild(body);
  return details;
}

function renderTerminalTimeline(timeline = []) {
  el.terminalTimeline.innerHTML = "";
  if (!timeline.length) {
    el.terminalTimeline.hidden = true;
    return;
  }
  el.terminalTimeline.hidden = false;
  for (const event of timeline) el.terminalTimeline.appendChild(createTimelineCard(event));
}

function renderTerminalModal() {
  const message = state.activeTerminalMessage;
  const shouldStick = isNearBottom(el.terminalOutput);
  if (!message) {
    el.terminalTitle.textContent = "Terminal";
    renderTerminalTimeline([]);
    el.terminalOutput.textContent = "Waiting for terminal output...";
    if (shouldStick) scrollElementToBottom(el.terminalOutput);
    return;
  }
  el.terminalTitle.textContent = terminalTitleFor(message);
  renderTerminalTimeline(message.timeline || []);
  el.terminalOutput.textContent = terminalText(message);
  if (shouldStick) scrollElementToBottom(el.terminalOutput);
}

function openTerminalModal(message) {
  if (state.activeTerminalMessage !== message) state.openTimelineCards.clear();
  state.activeTerminalMessage = message;
  renderTerminalModal();
  if (!el.terminalDialog.open) el.terminalDialog.showModal();
  requestAnimationFrame(() => scrollElementToBottom(el.terminalOutput));
}

function closeTerminalModal() {
  state.activeTerminalMessage = null;
  state.openTimelineCards.clear();
  if (el.terminalDialog.open) el.terminalDialog.close();
}

function syncOpenTerminal(message) {
  if (state.activeTerminalMessage === message && el.terminalDialog.open) {
    renderTerminalModal();
  }
}

function updateLastMessage(message) {
  const shouldStick = isNearBottom(el.messages);
  const last = el.messages.lastElementChild;
  if (!last?.classList?.contains("message")) {
    renderMessages();
    return;
  }
  last.className = messageClassNames(message);
  const when = last.querySelector(".message-time");
  const body = last.querySelector(".message-body");
  if (when) when.textContent = message.streaming ? "live" : formatDate(message.at);
  if (body) renderMessageBody(body, message);
  syncOpenTerminal(message);
  if (shouldStick) scrollMessagesToBottom();
}

function scrollMessagesToBottom() {
  scrollElementToBottom(el.messages);
  updateScrollToBottomVisibility();
}

function createAttachmentList(attachments, removable) {
  const list = document.createElement("div");
  list.className = removable ? "selected-attachment-list" : "message-attachment-list";
  for (const [index, attachment] of attachments.entries()) {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.title = attachment.path || attachment.name;

    const name = document.createElement("span");
    name.textContent = `${attachment.name} (${formatBytes(attachment.size)})`;
    chip.appendChild(name);

    if (removable) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "x";
      remove.title = "Remove";
      remove.addEventListener("click", () => {
        state.selectedFiles.splice(index, 1);
        renderSelectedAttachments();
      });
      chip.appendChild(remove);
    }

    list.appendChild(chip);
  }
  return list;
}

function renderSelectedAttachments() {
  el.attachmentList.innerHTML = "";
  if (state.selectedFiles.length) {
    el.attachmentList.appendChild(createAttachmentList(state.selectedFiles, true));
  }
  resizeComposerInput();
}

function setComposerEnabled(enabled) {
  const run = currentRun();
  const busy = Boolean(run?.streaming);
  const stopping = Boolean(run?.stopInFlight);
  el.messageInput.disabled = !enabled || busy;
  el.attachmentMenuButton.disabled = !enabled || busy;
  el.fileInput.disabled = !enabled || busy;
  el.sendButton.disabled = !enabled || stopping;
  el.sendButton.classList.toggle("is-stop", busy);
  el.sendButton.title = busy ? "Stop model" : "Send";
  el.sendButton.setAttribute("aria-label", busy ? "Stop model" : "Send message");
  el.sendButton.innerHTML = iconSvg(busy ? icons.stop : icons.send);
  if (!enabled || busy) closeAttachmentMenu();
  resizeComposerInput();
}

function syncComposerState() {
  setComposerEnabled(Boolean(state.currentSession));
}

function resizeComposerInput() {
  if (!el.messageInput) return;
  const style = getComputedStyle(el.messageInput);
  const lineHeight = Number.parseFloat(style.lineHeight) || 24;
  const maxHeight = lineHeight * 10;
  const minHeight = lineHeight;
  if (!el.messageInput.value) {
    el.messageInput.style.height = `${minHeight}px`;
    el.messageInput.style.overflowY = "hidden";
    return;
  }
  el.messageInput.style.height = "auto";
  const nextHeight = Math.max(minHeight, Math.min(el.messageInput.scrollHeight, maxHeight));
  el.messageInput.style.height = `${Math.ceil(nextHeight)}px`;
  el.messageInput.style.overflowY = el.messageInput.scrollHeight > maxHeight + 1 ? "auto" : "hidden";
}

function focusComposerFromClick(event) {
  if (el.messageInput.disabled || currentRun()?.streaming) return;
  if (event.target.closest("button, input, select, textarea, a, [role='menu'], .attachment-chip")) return;
  el.messageInput.focus();
}

function isEditableElement(node) {
  if (!node || node === document.body || node === document.documentElement) return false;
  const tagName = node.tagName;
  return node.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

function focusComposerInput() {
  if (!state.currentSession || currentRun()?.streaming || el.messageInput.disabled) return;
  if (document.visibilityState !== "visible") return;
  if (document.querySelector("dialog[open]")) return;
  const active = document.activeElement;
  if (active !== el.messageInput && isEditableElement(active)) return;
  el.messageInput.focus({ preventScroll: true });
  const end = el.messageInput.value.length;
  el.messageInput.setSelectionRange(end, end);
}

async function stopActiveRun() {
  const run = currentRun();
  if (!run || !run.streaming || run.stopInFlight) return;
  run.stopInFlight = true;
  syncComposerState();
  const last = state.currentSession?.messages?.at(-1);
  if (last?.streaming) updateLastMessage(last);
  setStatus("Stopping model...");
  try {
    await api(`/api/sessions/${run.sessionId}/stop`, { method: "POST" });
  } catch (error) {
    setStatus(`Stop error: ${error.message}`);
    run.stopInFlight = false;
    syncComposerState();
  }
}

async function refreshSessions() {
  const [sessionBody, projectBody] = await Promise.all([
    api("/api/sessions"),
    api("/api/projects"),
  ]);
  state.sessions = sessionBody.sessions || [];
  state.projects = projectBody.projects || [];
  renderProjectOptions();
  renderSessions();
}

function tailscaleConfigured() {
  return Boolean(state.tailscale?.configured);
}

function tailscaleStateLabel(tailscale = state.tailscale) {
  if (!tailscale) return "Checking";
  if (tailscale.state === "ready") return `Ready - ${tailscale.httpsHost || tailscale.hostname}`;
  if (tailscale.state === "needs-login") return "Needs login - open the auth URL";
  if (tailscale.state === "needs-relogin") return "Tailnet identity lost - paste a fresh key";
  if (tailscale.state === "restarting") return "Restarting with new key...";
  if (tailscale.configured) return `Saved - ${tailscale.httpsHost || tailscale.hostname}`;
  if (tailscale.state === "starting") return "Registering with Tailscale...";
  if (tailscale.state === "waiting") return "Waiting for setup";
  if (tailscale.state === "error") return tailscale.detail || "Needs attention";
  return "Not configured";
}

function renderTailscaleButton() {
  if (!el.settingsTailscaleStatus) return;
  const configured = tailscaleConfigured();
  el.settingsTailscaleStatus.textContent = configured ? "On" : "Off";
  el.settingsTailscaleStatus.dataset.state = configured ? "ok" : "warn";
  updateSettingsButtonState();
}

function updateSettingsButtonState() {
  if (!el.settingsMenuButton) return;
  const githubOk = state.githubConnected === true;
  const tailscaleOk = tailscaleConfigured();
  el.settingsMenuButton.classList.toggle("is-warning", !tailscaleOk || !githubOk);
  const parts = [`Tailscale ${tailscaleOk ? "on" : "off"}`, `GitHub ${githubOk ? "on" : "off"}`];
  el.settingsMenuButton.title = parts.join(" - ");
}

function closeSettingsMenu() {
  if (!el.settingsMenu || el.settingsMenu.hidden) return;
  el.settingsMenu.hidden = true;
  el.settingsMenuButton?.setAttribute("aria-expanded", "false");
}

async function refreshGithubConnectionStatus() {
  try {
    const body = await api("/api/connections/github");
    state.githubConnected = Boolean(body.github?.hasToken && body.github?.hasKeypair);
  } catch {
    state.githubConnected = false;
  }
  if (el.settingsGithubStatus) {
    el.settingsGithubStatus.textContent = state.githubConnected ? "On" : "Off";
    el.settingsGithubStatus.dataset.state = state.githubConnected ? "ok" : "warn";
  }
  updateSettingsButtonState();
}

function toggleSettingsMenu() {
  if (!el.settingsMenu) return;
  const willOpen = el.settingsMenu.hidden;
  if (willOpen) {
    el.settingsMenu.hidden = false;
    el.settingsMenuButton?.setAttribute("aria-expanded", "true");
    void refreshGithubConnectionStatus();
  } else {
    closeSettingsMenu();
  }
}

function renderTailscaleDialog() {
  const tailscale = state.tailscale || {};
  const configured = tailscaleConfigured();
  const errored = tailscale.state === "error";
  el.tailscaleStateText.textContent = tailscaleStateLabel(tailscale);
  el.tailscaleStateText.parentElement.classList.toggle("configured", configured);
  el.tailscaleStateText.parentElement.classList.toggle("error", errored);

  // Adapt the hint + button label to whatever state the sidecar is in. The button always submits
  // the form (no key input anymore) and the server writes a fresh setup.env + logout sentinel,
  // which the sidecar consumes to logout/wipe/restart into a clean browser-auth flow.
  let hint;
  let buttonText;
  if (tailscale.state === "ready") {
    hint = "Tailscale is connected. Click Re-register to wipe the persisted identity and start over.";
    buttonText = "Re-register";
  } else if (tailscale.state === "needs-login" || tailscale.state === "needs-relogin") {
    hint = "The sidecar is waiting for browser authorization. If a tab didn't open, use the Open auth page button below.";
    buttonText = "Reset & try again";
  } else if (tailscale.state === "starting" || tailscale.state === "restarting") {
    hint = "Sidecar starting; registration usually takes 10-30s.";
    buttonText = "Start setup";
  } else {
    hint = "Click Start setup. The sidecar opens a Tailscale browser tab where you authorize this device. The hostname is always orch-ui.";
    buttonText = "Start setup";
  }
  if (el.tailscaleSetupHint) el.tailscaleSetupHint.textContent = hint;
  el.saveTailscale.textContent = buttonText;

  renderTailscaleAuthUrl(tailscale);
  updateTailscaleFormState();
}

// Surface the Tailscale browser-auth URL when the sidecar reports NeedsLogin. We auto-open it
// once per URL, then keep a re-open button visible in case the popup was blocked. The block sits
// inside the modal between the status row and the inputs.
function renderTailscaleAuthUrl(tailscale) {
  if (!el.tailscaleStateText) return;
  const url = String(tailscale?.authURL || "").trim();
  let block = document.getElementById("tailscaleAuthUrlBlock");
  if (!url || tailscale?.state === "ready") {
    if (block) block.remove();
    return;
  }
  if (!block) {
    block = document.createElement("div");
    block.id = "tailscaleAuthUrlBlock";
    block.className = "tailscale-auth-url";
    el.tailscaleStateText.parentElement.insertAdjacentElement("afterend", block);
  }
  if (block.dataset.lastUrl !== url) {
    block.dataset.lastUrl = url;
    block.innerHTML = "";
    const note = document.createElement("p");
    note.className = "modal-hint";
    note.textContent = "Tailscale needs you to authorize this device. Opening the auth page in a new tab.";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "primary";
    openBtn.textContent = "Open auth page";
    openBtn.addEventListener("click", () => window.open(url, "_blank", "noopener,noreferrer"));
    block.append(note, openBtn);
    state.tailscaleOpenedAuthUrls = state.tailscaleOpenedAuthUrls || new Set();
    if (!state.tailscaleOpenedAuthUrls.has(url)) {
      state.tailscaleOpenedAuthUrls.add(url);
      try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* popup blocked - button covers it */ }
    }
  }
}

function updateTailscaleFormState() {
  // No more input field; the button is always enabled. The status row mirrors whatever detail
  // the sidecar last published (or a placeholder when nothing's running yet).
  el.saveTailscale.disabled = false;
  el.tailscaleStatus.classList.remove("is-error");
  el.tailscaleStatus.textContent = state.tailscale?.detail || tailscaleStateLabel();
}

async function refreshTailscaleStatus() {
  try {
    const body = await api("/api/tailscale");
    state.tailscale = body.tailscale || null;
  } catch (error) {
    state.tailscale = {
      configured: false,
      state: "error",
      detail: error.message,
      hostname: "orch-ui",
      httpsHost: "",
      authKeyConfigured: false,
    };
  }
  renderTailscaleButton();
  if (el.tailscaleDialog?.open) renderTailscaleDialog();
}

function setTailscaleStatusMsg(message, isError = false) {
  if (!el.tailscaleStatus) return;
  el.tailscaleStatus.textContent = message || "";
  el.tailscaleStatus.classList.toggle("is-error", Boolean(message) && isError);
}

async function openTailscaleModal({ continueAfterSetup = false } = {}) {
  state.tailscaleContinueAfterSetup = continueAfterSetup;
  await refreshTailscaleStatus();
  renderTailscaleDialog();
  el.tailscaleDialog.showModal();
  startTailscaleStatusWatch();
}

// While the modal is open we poll /api/tailscale every 3s so the user sees registration progress
// (Starting -> NeedsLogin -> Running) without clicking Refresh. Auto-closes once the sidecar
// reports state=ready with a real httpsHost; continueAfterSetup then opens the new-chat modal.
function startTailscaleStatusWatch() {
  stopTailscaleStatusWatch();
  state.tailscaleStatusWatch = setInterval(async () => {
    if (!el.tailscaleDialog?.open) {
      stopTailscaleStatusWatch();
      return;
    }
    await refreshTailscaleStatus();
    if (state.tailscale?.state === "ready" && state.tailscale.httpsHost) {
      const continueAfterSetup = state.tailscaleContinueAfterSetup;
      stopTailscaleStatusWatch();
      closeTailscaleModal();
      setStatus(`Tailscale ready - ${state.tailscale.httpsHost}`);
      if (continueAfterSetup) await openNewChatModal({ force: true });
    }
  }, 3000);
}

function stopTailscaleStatusWatch() {
  if (state.tailscaleStatusWatch) {
    clearInterval(state.tailscaleStatusWatch);
    state.tailscaleStatusWatch = null;
  }
}

function closeTailscaleModal() {
  el.tailscaleDialog.close();
  state.tailscaleContinueAfterSetup = false;
  stopTailscaleStatusWatch();
}

async function saveTailscaleFromUi() {
  if (el.saveTailscale.disabled) return;
  el.saveTailscale.disabled = true;
  el.tailscaleStatus.classList.remove("is-error");
  el.tailscaleStatus.textContent = "Restarting Tailscale sidecar. A browser tab will open to authorize this device.";
  try {
    // No key in the body: server writes a hostname-only setup.env, drops a logout-pending
    // sentinel so the sidecar wipes its persisted identity, and then runs `tailscale up` without
    // --auth-key, which emits an AuthURL the wizard auto-opens.
    const body = await api("/api/tailscale", {
      method: "POST",
      body: JSON.stringify({}),
    });
    state.tailscale = body.tailscale;
    state.tailscaleSetupDismissed = false;
    renderTailscaleButton();
    // Don't close the modal — the status watcher polls every 3s and auto-closes on state=ready.
    el.tailscaleStateText.textContent = "Restarting sidecar...";
    setStatus("Tailscale sidecar restarting; waiting for browser auth");
  } catch (error) {
    el.tailscaleStatus.classList.add("is-error");
    el.tailscaleStatus.textContent = error.message;
    updateTailscaleFormState();
  } finally {
    el.saveTailscale.disabled = false;
  }
}

async function skipTailscaleSetup() {
  const continueAfterSetup = state.tailscaleContinueAfterSetup;
  state.tailscaleSetupDismissed = true;
  closeTailscaleModal();
  if (continueAfterSetup) await openNewChatModal({ force: true });
}

function updateModalState() {
  const projectName = modalProjectName();
  const existingSession = findSessionByCwd(projectName);
  const existingProject = projectExists(projectName);
  const selectedSupervisor = el.modalSupervisorSelect.value;
  const supervisorConnected = isSupervisorConnected(selectedSupervisor);
  const needsSupervisor = Boolean(projectName && !existingSession);
  el.startNewChat.disabled = !projectName || (needsSupervisor && !supervisorConnected);
  el.startNewChat.textContent = existingSession || existingProject ? "Open" : "Start";
  el.modalError.classList.toggle("is-error", !projectName);
  if (!projectName) {
    el.modalError.textContent = "Enter a project folder.";
  } else if (existingSession) {
    el.modalError.textContent = "Existing project conversation will be opened.";
  } else if (!supervisorConnected) {
    el.modalError.classList.add("is-error");
    el.modalError.textContent = "Connect a model before starting a new chat.";
  } else if (existingProject) {
    el.modalError.textContent = "Existing folder will be opened.";
  } else {
    el.modalError.textContent = "New project folder will be created.";
  }
}

async function loadSession(id) {
  // If a run is streaming for this session, use its live in-memory copy (with the draft) rather than
  // the server copy, which lacks in-progress output. Covers every entry point (sidebar, modal).
  const run = state.runs.get(id);
  state.currentSession = run ? run.session : (await api(`/api/sessions/${id}`)).session;
  renderSessions();
  renderMessages();
  syncComposerState();
  setWorkspaceStatus();
  collapseResponsiveSidebar();
  scheduleAutopilot(state.currentSession);
}

async function createSession({ supervisor, cwd }) {
  if (!isSupervisorConnected(supervisor)) {
    const label = state.config.supervisors[supervisor]?.label || "Selected model";
    throw new Error(`${label} is not connected. Connect it before starting a chat.`);
  }
  const body = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ supervisor, cwd }),
  });
  state.currentSession = body.session;
  await refreshSessions();
  renderMessages();
  syncComposerState();
  setWorkspaceStatus();
  collapseResponsiveSidebar();
}

async function openProjectSession(project) {
  if (isCurrentProject(project)) {
    renderSessions();
    collapseResponsiveSidebar();
    return;
  }
  // If the target project has a run in flight, show its live in-memory session (with the streaming
  // draft) instead of re-fetching the server copy, which would not yet have the in-progress output.
  if (project.id && state.runs.has(project.id)) {
    state.currentSession = state.runs.get(project.id).session;
    renderSessions();
    renderMessages();
    syncComposerState();
    setWorkspaceStatus();
    collapseResponsiveSidebar();
    return;
  }
  if (project.id) {
    await loadSession(project.id);
    return;
  }
  const supervisor = firstConnectedSupervisorId();
  if (!supervisor) {
    setStatus("Connect a model before starting a project chat");
    await openConnectModal();
    return;
  }
  try {
    await createSession({
      supervisor,
      cwd: project.cwd,
    });
  } catch (error) {
    setStatus(`Error: ${error.message}`);
    await refreshModelStatus();
    await openConnectModal();
  }
}

async function deleteProjectFromUi(project) {
  const projectName = project.cwd || project.project || project.title;
  if (!projectName) return;
  if (project.id && state.runs.get(project.id)?.streaming) {
    setStatus("Stop the running model before deleting this project");
    return;
  }
  const confirmed = window.confirm(`Delete project "${projectName}"?\n\nThis removes the project folder and its chat history.`);
  if (!confirmed) return;
  try {
    const body = await api(`/api/projects/${encodeURIComponent(projectName)}`, { method: "DELETE" });
    state.projects = body.projects || [];
    state.sessions = body.sessions || [];
    if (project.id) {
      state.autopilotPhases.delete(project.id);
      cancelScheduledAutopilot(project.id);
    }
    if (isCurrentProject(project)) {
      state.currentSession = null;
      renderMessages();
      syncComposerState();
      setWorkspaceStatus();
    }
    renderProjectOptions();
    renderSessions();
    setStatus(`Deleted ${projectName}`);
  } catch (error) {
    setStatus(`Delete error: ${error.message}`);
  }
}

async function openNewChatModal({ force = false } = {}) {
  if (!force && !tailscaleConfigured() && !state.tailscaleSetupDismissed) {
    await openTailscaleModal({ continueAfterSetup: true });
    return;
  }
  await Promise.all([refreshSessions(), refreshModelStatus()]);
  el.modalError.textContent = "";
  el.modalProjectName.value = "";
  renderSupervisors();
  const selected = bestSupervisorSelection(state.config.defaultSupervisor);
  if (selected) el.modalSupervisorSelect.value = selected;
  updateModalState();
  el.newChatDialog.showModal();
  el.modalProjectName.focus();
}

function closeNewChatModal() {
  el.newChatDialog.close();
}

function setWorkspaceStatus() {
  const mode = state.config?.allowWrite ? "write" : "read-only";
  if (!state.currentSession) {
    setStatus(`Ready - ${mode}`);
    return;
  }
  setStatus(`${state.currentSession.supervisor} - ${mode} - ${state.currentSession.cwd || "."}`);
}

function browserContext() {
  return {
    origin: window.location.origin,
    protocol: window.location.protocol,
    host: window.location.host,
    hostname: window.location.hostname,
  };
}

async function sendMessage(content, files = [], options = {}) {
  if (!state.currentSession) {
    setStatus("Create a new chat first");
    await openNewChatModal();
    return false;
  }
  return sendMessageForSession(state.currentSession, content, files, options);
}

async function sendMessageForSession(targetSession, content, files = [], options = {}) {
  const session = targetSession;
  if (!session?.id) return false;
  const supervisor = session.supervisor;
  const viewingSession = () => isViewing(session.id);
  if (state.runs.has(session.id) || !state.pendingSends.tryStart(session.id)) {
    if (viewingSession()) setStatus("A run is already in progress");
    return false;
  }
  if (viewingSession()) setStatus(files.length ? "Reading files..." : `Running ${supervisor}...`);
  let attachments;
  try {
    attachments = await readAttachments(files, { maxUploadBytes: state.config?.maxUploadBytes });
  } catch (error) {
    state.pendingSends.finish(session.id);
    if (viewingSession()) setStatus(`Error: ${error.message}`);
    return false;
  }
  let autopilotCandidate = null;
  const userMessage = {
    role: "user",
    content: content || (files.length ? "Attached files" : ""),
    attachments: files.map((file) => ({ name: file.name, size: file.size, type: file.type || "" })),
    at: new Date().toISOString(),
  };
  const draft = {
    role: "assistant",
    supervisor,
    content: "",
    status: "Starting...",
    trace: [],
    timeline: [],
    at: new Date().toISOString(),
    streaming: true,
  };

  session.messages ||= [];
  session.messages.push(userMessage, draft);
  options.onAccepted?.();

  const run = { sessionId: session.id, session, draft, supervisor, streaming: true, stopInFlight: false, heartbeat: null };
  state.runs.set(session.id, run);
  state.pendingSends.finish(session.id);
  markLocalUsageActive(supervisor);
  updateWakeLock();
  startTypingSound(run.sessionId);
  const viewing = () => isViewing(run.sessionId);
  if (viewing()) renderMessages();
  renderSessions();
  syncComposerState();
  if (viewing()) setStatus(files.length ? "Reading files..." : `Running ${supervisor}...`);

  const startedAt = Date.now();
  run.heartbeat = setInterval(() => {
    if (!draft.streaming || draft.content) return;
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    const elapsed = minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
    draft.status = `${supervisor} is working... ${elapsed}`;
    if (viewing()) {
      updateLastMessage(draft);
      setStatus(`Running ${supervisor}... ${elapsed}`);
    }
  }, 1000);

  try {
    if (viewing()) setStatus(`Running ${supervisor}...`);
    await streamApi(`/api/sessions/${run.sessionId}/messages/stream`, {
      clientId: state.clientId,
      browser: browserContext(),
      source: options.source === "autopilot" ? "autopilot" : "manual",
      content,
      attachments,
    }, {
      session(event) {
        run.session = mergeStreamingSession(event.session, run.session, draft);
        if (viewing()) {
          state.currentSession = run.session;
          renderMessages();
          syncComposerState();
        }
      },
      chunk(event) {
        draft.status = "";
        draft.content += event.content;
        if (viewing()) updateLastMessage(draft);
      },
      trace(event) {
        draft.trace.push(String(event.content || ""));
        let totalChars = draft.trace.reduce((total, item) => total + item.length, 0);
        while (draft.trace.length > 1 && totalChars > 60000) {
          totalChars -= draft.trace.shift().length;
        }
        if (viewing()) {
          updateLastMessage(draft);
          syncOpenTerminal(draft);
        }
      },
      task(event) {
        appendTimelineToDraft(draft, event.event);
        if (viewing()) {
          updateLastMessage(draft);
          syncOpenTerminal(draft);
        }
      },
      "idle-warning"(event) {
        draft.status = event.warning || "Autopilot idle timeout soon";
        if (viewing()) {
          updateLastMessage(draft);
          setStatus(draft.status);
        }
      },
      done(event) {
        stopTypingSound(run.sessionId);
        draft.streaming = false;
        run.streaming = false;
        run.session = event.session;
        const last = run.session.messages.at(-1);
        if (last) {
          last.trace = draft.trace;
          last.timeline = draft.timeline;
        }
        autopilotCandidate = run.session;
        if (shouldPlayProjectAudio(run.sessionId)) playRunFinishedSound("done");
        speakLatestAnswer(run.session);
        if (viewing()) {
          state.currentSession = run.session;
          renderMessages();
          syncOpenTerminal(draft);
          syncComposerState();
          setWorkspaceStatus();
        }
      },
      error(event) {
        stopTypingSound(run.sessionId);
        draft.streaming = false;
        draft.error = true;
        run.streaming = false;
        run.session = event.session || run.session;
        const last = run.session?.messages?.at(-1);
        if (last) {
          applyTerminalFlags(last, draft);
          last.trace = draft.trace;
          last.timeline = draft.timeline;
        }
        if (shouldPlayProjectAudio(run.sessionId)) playRunFinishedSound("error");
        if (viewing()) {
          state.currentSession = run.session;
          setStatus(`Error: ${event.error}`);
          renderMessages();
          syncOpenTerminal(draft);
        }
      },
      stopped(event) {
        stopTypingSound(run.sessionId);
        draft.streaming = false;
        draft.stopped = true;
        run.streaming = false;
        run.session = event.session || run.session;
        const last = run.session?.messages?.at(-1);
        if (last) {
          applyTerminalFlags(last, draft);
          last.trace = draft.trace;
          last.timeline = draft.timeline;
        }
        if (shouldPlayProjectAudio(run.sessionId)) playRunFinishedSound("done");
        if (viewing()) {
          state.currentSession = run.session;
          setStatus(event.error || "Stopped by user");
          renderMessages();
          syncOpenTerminal(draft);
        }
      },
    });
    await refreshSessions();
    await refreshUsage();
  } catch (error) {
    stopTypingSound(run.sessionId);
    if (shouldPlayProjectAudio(run.sessionId)) playRunFinishedSound("error");
    draft.error = true;
    draft.streaming = false;
    run.streaming = false;
    draft.status = "";
    draft.content = appendMessageError(draft.content, error.message);
    if (viewing()) {
      setStatus(`Error: ${error.message}`);
      updateLastMessage(draft);
    }
  } finally {
    clearInterval(run.heartbeat);
    stopTypingSound(run.sessionId);
    state.runs.delete(run.sessionId);
    updateWakeLock();
    renderSessions();
    if (viewing()) {
      syncComposerState();
      focusComposerInput();
    }
    await refreshUsage();
    if (autopilotCandidate) scheduleAutopilot(autopilotCandidate);
  }
  return true;
}

function sessionSummaryFromSession(session) {
  const messages = session?.messages || [];
  const autopilotFeed = normalizeAutopilotFeed(session.autopilotFeed || [], { limit: configuredAutopilotFeedLimit() });
  return {
    id: session.id,
    title: session.project || session.title || session.cwd || "New chat",
    project: session.project || session.title || session.cwd || ".",
    supervisor: session.supervisor,
    cwd: session.cwd || ".",
    createdAt: session.createdAt || messages[0]?.at || "",
    updatedAt: session.updatedAt || messages.at(-1)?.at || new Date().toISOString(),
    messageCount: messages.length,
    autopilotEnabled: session.autopilotEnabled === true,
    autopilotState: session.autopilotState,
    autopilotFeed,
  };
}

function upsertSessionSummary(session) {
  if (!session?.id) return;
  const summary = sessionSummaryFromSession(session);
  const index = state.sessions.findIndex((item) => item.id === session.id);
  if (index >= 0) state.sessions[index] = { ...state.sessions[index], ...summary };
  else state.sessions.unshift(summary);
}

function cloneLiveSession(session) {
  return {
    ...session,
    messages: Array.isArray(session?.messages) ? [...session.messages] : [],
  };
}

function messageIdentity(message = {}) {
  return [
    message.role || "",
    String(message.content || message.modelContent || "").slice(0, 1000),
    Array.isArray(message.attachments) ? String(message.attachments.length) : "0",
  ].join("\u0000");
}

function messageIdentityCounts(messages = []) {
  const counts = new Map();
  for (const message of messages) {
    const key = messageIdentity(message);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function mergeStreamingSession(serverSession, localSession, draft) {
  const session = cloneLiveSession(serverSession || localSession || {});
  const messages = session.messages || [];
  const serverCounts = messageIdentityCounts(messages);
  for (const message of localSession?.messages || []) {
    if (!message || message === draft || message.streaming) continue;
    const key = messageIdentity(message);
    const count = serverCounts.get(key) || 0;
    if (count > 0) {
      serverCounts.set(key, count - 1);
      continue;
    }
    messages.push(message);
  }
  attachDraftToSession(session, draft);
  return session;
}

function cloneLiveDraft(draft, session) {
  return {
    role: "assistant",
    supervisor: draft?.supervisor || session?.supervisor || "assistant",
    content: draft?.content || "",
    status: draft?.status || "Starting...",
    trace: Array.isArray(draft?.trace) ? [...draft.trace] : [],
    timeline: Array.isArray(draft?.timeline) ? [...draft.timeline] : [],
    at: draft?.at || new Date().toISOString(),
    streaming: true,
  };
}

function attachDraftToSession(session, draft) {
  session.messages ||= [];
  const last = session.messages.at(-1);
  if (last?.streaming) session.messages[session.messages.length - 1] = draft;
  else session.messages.push(draft);
}

function appendTraceToDraft(draft, content) {
  draft.trace ||= [];
  draft.trace.push(String(content || ""));
  let totalChars = draft.trace.reduce((total, item) => total + item.length, 0);
  while (draft.trace.length > 1 && totalChars > 60000) {
    totalChars -= draft.trace.shift().length;
  }
}

function appendTimelineToDraft(draft, event) {
  if (!draft || !event?.id) return;
  draft.timeline ||= [];
  const index = draft.timeline.findIndex((item) => item.id === event.id);
  if (index >= 0) {
    draft.timeline[index] = {
      ...draft.timeline[index],
      ...event,
      at: draft.timeline[index].at || event.at,
      detail: event.detail || draft.timeline[index].detail || "",
    };
  } else {
    draft.timeline.push(event);
  }
  if (draft.timeline.length > 80) draft.timeline = draft.timeline.slice(-80);
}

function syncLiveSessionView(run, { forceRender = false } = {}) {
  upsertSessionSummary(run.session);
  if (isViewing(run.sessionId)) {
    state.currentSession = run.session;
    if (forceRender) renderMessages();
    syncComposerState();
  }
  renderSessions();
}

function handleLiveSession(event) {
  if (!event.session?.id) return;
  const existing = state.runs.get(event.sessionId);
  const draft = cloneLiveDraft(event.draft, event.session);
  const session = mergeStreamingSession(event.session, existing?.session, draft);
  if (existing?.heartbeat) clearInterval(existing.heartbeat);
  const run = {
    sessionId: event.sessionId,
    session,
    draft,
    supervisor: session.supervisor,
    streaming: true,
    stopInFlight: false,
    heartbeat: null,
    remote: true,
  };
  state.runs.set(event.sessionId, run);
  markLocalUsageActive(session.supervisor, { countRun: false });
  updateWakeLock();
  startTypingSound(run.sessionId);
  syncLiveSessionView(run, { forceRender: true });
}

function handleLiveChunk(event) {
  const run = state.runs.get(event.sessionId);
  if (!run?.draft) return;
  run.draft.status = "";
  run.draft.content += event.content || "";
  if (isViewing(run.sessionId)) updateLastMessage(run.draft);
}

function handleLiveTrace(event) {
  const run = state.runs.get(event.sessionId);
  if (!run?.draft) return;
  appendTraceToDraft(run.draft, event.content);
  if (isViewing(run.sessionId)) {
    updateLastMessage(run.draft);
    syncOpenTerminal(run.draft);
  }
}

function handleLiveTask(event) {
  const run = state.runs.get(event.sessionId);
  if (!run?.draft) return;
  appendTimelineToDraft(run.draft, event.event);
  if (isViewing(run.sessionId)) {
    updateLastMessage(run.draft);
    syncOpenTerminal(run.draft);
  }
}

function finishLiveRun(event) {
  const run = state.runs.get(event.sessionId);
  const session = event.session ? cloneLiveSession(event.session) : run?.session;
  if (!session?.id) return;
  const draft = run?.draft;
  if (draft) {
    draft.streaming = false;
    if (event.type === "error") draft.error = true;
    if (event.type === "stopped") draft.stopped = true;
  }
  const last = session.messages?.at(-1);
  applyTerminalFlags(last, draft);
  if (last && draft?.trace?.length) last.trace = [...draft.trace];
  if (last && draft?.timeline?.length) last.timeline = [...draft.timeline];
  if (run?.heartbeat) clearInterval(run.heartbeat);
  stopTypingSound(event.sessionId);
  state.runs.delete(event.sessionId);
  upsertSessionSummary(session);
  if (event.type === "error") {
    if (shouldPlayProjectAudio(event.sessionId)) playRunFinishedSound("error");
  } else {
    if (shouldPlayProjectAudio(event.sessionId)) playRunFinishedSound("done");
    if (event.type === "done") speakLatestAnswer(session);
  }
  updateWakeLock();
  renderSessions();
  if (isViewing(event.sessionId)) {
    state.currentSession = session;
    if (event.type === "error") setStatus(`Error: ${event.error}`);
    else if (event.type === "stopped") setStatus(event.error || "Stopped by user");
    else setWorkspaceStatus();
    renderMessages();
    if (draft) syncOpenTerminal(draft);
    syncComposerState();
    focusComposerInput();
  }
  refreshSessions().catch((error) => setStatus(`Session refresh error: ${error.message}`));
  // Trigger a fresh probe for the supervisor that just finished, so its chip catches the new
  // current/weekly percent and reset times instead of waiting for the next background poll.
  // The burst inside triggerUsageProbe also covers refreshUsage().
  triggerUsageProbe(session.supervisor);
  if (event.type === "done") scheduleAutopilot(session);
}

function handleLiveAutopilot(event) {
  const project = event.project || state.currentSession?.cwd || "project";
  let liveSession = null;
  if (event.session) {
    liveSession = cloneLiveSession(event.session);
    upsertSessionSummary(liveSession);
    if (isViewing(event.sessionId)) {
      state.currentSession = liveSession;
      renderMessages();
      syncComposerState();
    }
  }
  if (event.phase === "thinking") {
    state.autopilotPhases.set(event.sessionId, "running");
    renderSessions();
    setStatus(`${project} autopilot thinking...`);
    return;
  }
  if (event.phase === "history-cleared") {
    state.autopilotPhases.delete(event.sessionId);
    renderSessions();
    if (isViewing(event.sessionId)) setWorkspaceStatus();
    return;
  }
  if (event.phase === "retry") {
    state.autopilotPhases.set(event.sessionId, "running");
    renderSessions();
    const seconds = Math.max(0, Math.ceil((Number(event.delayMs) || 0) / 1000));
    setStatus(`${project} autopilot retry ${event.attempt || "?"}/${event.attempts || "?"}${seconds ? ` in ${seconds}s` : ""}`);
    return;
  }
  if (event.phase === "error") {
    state.autopilotPhases.set(event.sessionId, "failed");
    renderSessions();
    setStatus(`Autopilot error: ${event.error || "failed"}`);
    return;
  }
  if (event.phase === "idle-warning") {
    state.autopilotPhases.set(event.sessionId, "running");
    renderSessions();
    setStatus(event.warning || "Autopilot idle timeout soon");
    return;
  }
  if (event.phase === "state") {
    state.autopilotPhases.delete(event.sessionId);
    renderSessions();
    if (liveSession) scheduleAutopilot(liveSession);
    return;
  }
  if (event.phase === "decision") {
    const decision = event.decision || {};
    state.autopilotPhases.set(event.sessionId, decision.action === "message" ? "ready" : "stopped");
    renderSessions();
    setStatus(decision.action === "message"
      ? `${project} autopilot decided: ${decision.kind || "message"}`
      : `Autopilot stopped: ${decision.reason || "no next action"}`);
    if (decision.action === "message" && liveSession) {
      setTimeout(() => {
        if (!state.runs.has(event.sessionId) && !state.pendingSends.has(event.sessionId)) {
          void sendAutopilotDecision(liveSession, decision);
        }
      }, 1000);
    }
  }
}

function applyLiveEvent(event) {
  if (!event?.type || !event.sessionId) return;
  if (event.clientId === state.clientId && state.runs.has(event.sessionId)) return;
  if (event.type === "session") handleLiveSession(event);
  else if (event.type === "chunk") handleLiveChunk(event);
  else if (event.type === "trace") handleLiveTrace(event);
  else if (event.type === "task") handleLiveTask(event);
  else if (event.type === "idle-warning") setStatus(event.warning || "Autopilot idle timeout soon");
  else if (event.type === "autopilot") handleLiveAutopilot(event);
  else if (event.type === "done" || event.type === "error" || event.type === "stopped") finishLiveRun(event);
}

function connectLiveEvents() {
  if (!("EventSource" in window)) return;
  if (state.eventSource) state.eventSource.close();
  const source = new EventSource("/api/events");
  state.eventSource = source;
  source.onmessage = (message) => {
    try {
      applyLiveEvent(JSON.parse(message.data));
    } catch {
      // Ignore malformed live events; the next valid event or reconnect replay will repair the view.
    }
  };
  source.onerror = () => {
    setStatus("Live feed reconnecting...");
  };
}

async function init() {
  renderMediaToggles();
  state.config = await api("/api/config");
  await refreshTailscaleStatus();
  await refreshGithubConnectionStatus();
  await refreshModelStatus();
  // First page load: ask the server to capture fresh provider usage right now instead of waiting
  // for the next 5-minute background poll, so the chips reflect reality on day-one of the session.
  triggerUsageProbe();
  renderSupervisors();
  await refreshSessions();
  if (state.sessions[0]) await loadSession(state.sessions[0].id);
  else {
    state.currentSession = null;
    renderMessages();
    syncComposerState();
    setWorkspaceStatus();
  }
  // Open the SSE stream before kicking off resume probes so server-side events fired during the
  // resume window (e.g. a run finishing as we reconnect) are not dropped.
  connectLiveEvents();
  await resumeAutopilotSessions();
}

function updateScrollToBottomVisibility() {
  if (!el.scrollToBottomButton || !el.messages) return;
  // Only offer the shortcut when there's enough scroll to bother — empty/short conversations
  // would feel cluttered by the floating button.
  const overflowing = el.messages.scrollHeight > el.messages.clientHeight + 24;
  const atBottom = isNearBottom(el.messages);
  el.scrollToBottomButton.hidden = !overflowing || atBottom;
}

el.scrollToBottomButton?.addEventListener("click", () => {
  scrollElementToBottom(el.messages);
  updateScrollToBottomVisibility();
});
el.messages?.addEventListener("scroll", updateScrollToBottomVisibility, { passive: true });
window.addEventListener("resize", updateScrollToBottomVisibility);

el.newChat.addEventListener("click", openNewChatModal);
el.settingsMenuButton?.addEventListener("click", (event) => {
  event.preventDefault();
  toggleSettingsMenu();
});
el.openTailscaleFromSettings?.addEventListener("click", () => {
  closeSettingsMenu();
  void openTailscaleModal();
});
el.openGithubFromSettings?.addEventListener("click", () => {
  closeSettingsMenu();
  void openGithubModal();
});
el.signOutAllFromSettings?.addEventListener("click", () => {
  closeSettingsMenu();
  void withButtonBusy(el.signOutAllFromSettings, null, handleSignOutAll);
});
el.sidebarToggle.addEventListener("click", toggleSidebar);
// Tapping anywhere outside the drawer (on the backdrop scrim) closes it on mobile.
el.sidebarBackdrop?.addEventListener("click", () => setSidebarExpanded(false));
el.soundToggle.addEventListener("click", toggleSoundMute);
el.speechToggle.addEventListener("click", toggleSpeechMute);
el.attachmentMenuButton.addEventListener("click", (event) => {
  event.preventDefault();
  toggleAttachmentMenu();
});
el.attachmentMenu.addEventListener("click", (event) => {
  const item = event.target.closest("button");
  if (!item) return;
  const action = item.dataset.attachAction;
  closeAttachmentMenu();
  if (action === "files") el.fileInput.click();
});
document.addEventListener("click", (event) => {
  if (!el.projectContextMenu.hidden && !event.target.closest(".project-context-menu")) closeProjectContextMenu();
  if (!el.attachmentMenu.hidden && !event.target.closest(".attachment-menu-wrap")) closeAttachmentMenu();
  if (el.settingsMenu && !el.settingsMenu.hidden && !event.target.closest(".settings-menu-wrap")) closeSettingsMenu();
});
document.addEventListener("contextmenu", (event) => {
  if (event.target.closest(".session") || event.target.closest(".project-context-menu")) return;
  closeProjectContextMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.attachmentMenu.hidden) closeAttachmentMenu();
  if (event.key === "Escape" && !el.projectContextMenu.hidden) closeProjectContextMenu();
});
window.addEventListener("resize", closeProjectContextMenu);
window.addEventListener("beforeunload", () => state.eventSource?.close());
el.sessionList.addEventListener("scroll", closeProjectContextMenu);
el.closeGithubDialog?.addEventListener("click", closeGithubModal);
el.githubDialog?.addEventListener("click", (event) => {
  if (event.target === el.githubDialog) closeGithubModal();
});
el.githubDialog?.querySelector("[data-close-github]")?.addEventListener("click", closeGithubModal);
el.generateGithubKeyButton?.addEventListener("click", () => {
  void withButtonBusy(el.generateGithubKeyButton, "Generating...", handleGenerateGithubKey);
});
el.copyGithubKeyButton?.addEventListener("click", () => {
  void withButtonBusy(el.copyGithubKeyButton, "Copying...", handleCopyGithubKey);
});
el.saveGithubTokenButton?.addEventListener("click", () => {
  void withButtonBusy(el.saveGithubTokenButton, "Verifying...", handleSaveGithubToken);
});
el.testGithubSshButton?.addEventListener("click", () => {
  void withButtonBusy(el.testGithubSshButton, "Testing...", handleTestGithubSsh);
});
el.githubFinish?.addEventListener("click", closeGithubModal);

el.closeConnect.addEventListener("click", closeConnectModal);
el.refreshConnections.addEventListener("click", refreshConnections);
el.connectDialog.addEventListener("click", (event) => {
  if (event.target === el.connectDialog) closeConnectModal();
});
el.connectDialog.querySelector("[data-close-connect]").addEventListener("click", closeConnectModal);
el.modelConnectFinish?.addEventListener("click", closeModelModal);
el.closePrompts.addEventListener("click", closePromptModal);
el.promptDialog.addEventListener("click", (event) => {
  if (event.target === el.promptDialog) closePromptModal();
});
el.promptDialog.querySelector("[data-close-prompts]").addEventListener("click", closePromptModal);
el.promptEditor.addEventListener("input", storeActivePromptDraft);
el.resetPrompt.addEventListener("click", () => resetPromptById(state.activePromptId));
el.savePrompts.addEventListener("click", savePromptSettings);
el.closeModelDialog.addEventListener("click", closeModelModal);
el.modelDialog.addEventListener("click", (event) => {
  if (event.target === el.modelDialog) closeModelModal();
});
el.modelDialog.addEventListener("close", () => {
  storeActiveModelPromptDraft();
  state.activeModelId = null;
  state.activeModelTab = "connection";
});
el.modelPromptEditor.addEventListener("input", storeActiveModelPromptDraft);
el.resetModelPrompt.addEventListener("click", () => resetPromptById(state.activeModelId, { modelDialog: true }));
el.saveModelPrompt.addEventListener("click", saveActiveModelPrompt);
el.closeTerminal.addEventListener("click", closeTerminalModal);
el.terminalDialog.addEventListener("click", (event) => {
  if (event.target === el.terminalDialog) closeTerminalModal();
});
el.terminalDialog.addEventListener("close", () => {
  state.activeTerminalMessage = null;
});
el.closeTailscale.addEventListener("click", closeTailscaleModal);
el.skipTailscale.addEventListener("click", skipTailscaleSetup);
el.tailscaleDialog.addEventListener("click", (event) => {
  if (event.target === el.tailscaleDialog) closeTailscaleModal();
});
el.tailscaleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveTailscaleFromUi();
});
el.modalProjectName.addEventListener("input", updateModalState);
el.modalSupervisorSelect.addEventListener("change", updateModalState);
el.cancelNewChat.addEventListener("click", closeNewChatModal);
el.newChatDialog.addEventListener("click", (event) => {
  if (event.target === el.newChatDialog) closeNewChatModal();
});
el.newChatForm.querySelector("[data-close-modal]").addEventListener("click", closeNewChatModal);
el.newChatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  updateModalState();
  if (el.startNewChat.disabled) return;
  try {
    const projectName = modalProjectName();
    const existingSession = findSessionByCwd(projectName);
    if (existingSession) {
      await loadSession(existingSession.id);
      closeNewChatModal();
      return;
    }
    const project = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: projectName }),
    });
    await createSession({
      supervisor: el.modalSupervisorSelect.value || state.config.defaultSupervisor,
      cwd: project.project,
    });
    closeNewChatModal();
  } catch (error) {
    el.modalError.classList.add("is-error");
    el.modalError.textContent = error.message;
  }
});
el.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (currentRun()?.streaming) {
    await stopActiveRun();
    return;
  }
  const content = el.messageInput.value.trim();
  const files = [...state.selectedFiles];
  if (!content && !files.length) return;
  await sendMessage(content, files, {
    onAccepted() {
      el.messageInput.value = "";
      state.selectedFiles = [];
      renderSelectedAttachments();
      resizeComposerInput();
    },
  });
});
el.composer.querySelector(".composer-shell").addEventListener("click", focusComposerFromClick);
el.messageInput.addEventListener("input", resizeComposerInput);
el.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    el.composer.requestSubmit();
  }
});
el.fileInput.addEventListener("change", () => {
  state.selectedFiles.push(...Array.from(el.fileInput.files || []));
  el.fileInput.value = "";
  renderSelectedAttachments();
});

setInterval(() => {
  if (document.visibilityState === "visible") refreshUsage();
}, 30000);

init().catch((error) => setStatus(`Init error: ${error.message}`));
