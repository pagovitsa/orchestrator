const state = {
  config: null,
  sessions: [],
  projects: [],
  currentSession: null,
  selectedFiles: [],
  connections: [],
  connectionJobs: {},
  connectionPollers: {},
  connectionInputs: {},
  focusedConnectionInput: null,
  prompts: [],
  promptDrafts: {},
  activePromptId: null,
  activeTerminalMessage: null,
  runs: new Map(),
  statusText: "Ready",
};

// Active model runs, keyed by session id, so a run keeps streaming in the background while the user
// navigates to other projects. Each run owns its own session object + assistant draft; the UI only
// re-renders when the run's session is the one currently being viewed.
function currentRun() {
  return state.currentSession ? state.runs.get(state.currentSession.id) || null : null;
}

function isViewing(sessionId) {
  return Boolean(state.currentSession && state.currentSession.id === sessionId);
}

const el = {
  sidebar: document.querySelector(".sidebar"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  connectButton: document.getElementById("connectButton"),
  promptButton: document.getElementById("promptButton"),
  connectDialog: document.getElementById("connectDialog"),
  closeConnect: document.getElementById("closeConnect"),
  refreshConnections: document.getElementById("refreshConnections"),
  connectionList: document.getElementById("connectionList"),
  promptDialog: document.getElementById("promptDialog"),
  closePrompts: document.getElementById("closePrompts"),
  promptTabs: document.getElementById("promptTabs"),
  promptEditor: document.getElementById("promptEditor"),
  promptStatus: document.getElementById("promptStatus"),
  savePrompts: document.getElementById("savePrompts"),
  terminalDialog: document.getElementById("terminalDialog"),
  closeTerminal: document.getElementById("closeTerminal"),
  terminalTitle: document.getElementById("terminalTitle"),
  terminalOutput: document.getElementById("terminalOutput"),
  newChat: document.getElementById("newChat"),
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
  composer: document.getElementById("composer"),
  messageInput: document.getElementById("messageInput"),
  attachmentMenuButton: document.getElementById("attachmentMenuButton"),
  attachmentMenu: document.getElementById("attachmentMenu"),
  fileInput: document.getElementById("fileInput"),
  attachmentList: document.getElementById("attachmentList"),
  sendButton: document.getElementById("sendButton"),
};

const authToken = (() => {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("token");
    if (fromUrl) {
      localStorage.setItem("orchToken", fromUrl);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());
      return fromUrl;
    }
    return localStorage.getItem("orchToken") || "";
  } catch {
    return "";
  }
})();

function authHeaders() {
  return authToken ? { authorization: `Bearer ${authToken}` } : {};
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...authHeaders(), ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function setStatus(text) {
  state.statusText = text;
  el.status.title = text;
  el.status.setAttribute("aria-description", text);
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
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

function storeActivePromptDraft() {
  if (!state.activePromptId) return;
  state.promptDrafts[state.activePromptId] = el.promptEditor.value;
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
    return;
  }
  state.activePromptId = prompt.id;
  el.promptEditor.disabled = false;
  el.promptEditor.setAttribute("aria-labelledby", `prompt-tab-${prompt.id}`);
  el.promptEditor.value = state.promptDrafts[prompt.id] ?? prompt.content ?? "";
}

async function loadPromptSettings() {
  const body = await api("/api/prompts");
  state.prompts = body.prompts || [];
  state.promptDrafts = Object.fromEntries(state.prompts.map((prompt) => [prompt.id, prompt.content || ""]));
  if (!state.prompts.some((prompt) => prompt.id === state.activePromptId)) {
    state.activePromptId = state.prompts[0]?.id || null;
  }
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
    const body = await loadPromptSettings();
    el.promptStatus.textContent = body.promptDir ? `Saved in ${body.promptDir}` : "";
  } catch (error) {
    el.promptStatus.classList.add("is-error");
    el.promptStatus.textContent = error.message;
  } finally {
    el.savePrompts.disabled = false;
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
}

function toggleSidebar() {
  setSidebarExpanded(!el.sidebar.classList.contains("is-expanded"));
}

function collapseResponsiveSidebar() {
  if (window.matchMedia("(max-width: 760px)").matches) setSidebarExpanded(false);
}

function modelIcon(id) {
  const icons = {
    claude: "M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9L12 3Z",
    codex: "M5 8l4 4-4 4M12 17h7",
    gemini: "M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z",
    deepseek: "M4 13c2.7-5.2 6.2 5.2 9 0 2.1-4 5-3.6 7 0M5 18h14",
  };
  return icons[id] || "?";
}

function createModelIcon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", modelIcon(id));
  svg.appendChild(path);
  return svg;
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
  trash: ["M3 6h18", "M8 6V4h8v2", "M6 6l1 15h10l1-15", "M10 11v6M14 11v6"],
};

function renderModelStatus(connections = state.connections) {
  el.status.innerHTML = "";
  el.status.title = state.statusText;
  for (const connection of connections) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `model-chip ${connection.connected ? "on" : "off"}`;
    chip.title = `${connection.label}: ${connection.connected ? "on" : "off"}`;
    chip.setAttribute("aria-label", chip.title);

    const icon = document.createElement("span");
    icon.className = "model-chip-icon";
    icon.appendChild(createModelIcon(connection.id));

    const dot = document.createElement("span");
    dot.className = "model-chip-dot";
    dot.setAttribute("aria-hidden", "true");

    chip.append(icon, dot);
    chip.addEventListener("click", openConnectModal);
    el.status.appendChild(chip);
  }
}

async function openConnectModal() {
  el.connectDialog.showModal();
  await refreshConnections();
}

function closeConnectModal() {
  el.connectDialog.close();
}

async function refreshConnections() {
  el.connectionList.textContent = "Checking...";
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
    renderConnections();
    updateModalState();
  } catch (error) {
    el.connectionList.textContent = `Error: ${error.message}`;
  }
}

async function refreshModelStatus() {
  try {
    const body = await api("/api/connections");
    state.connections = body.connections || [];
    renderModelStatus();
    renderSupervisors();
    updateModalState();
  } catch (error) {
    setStatus(`Connection status error: ${error.message}`);
    renderModelStatus();
  }
}

function renderConnections() {
  const activeInput = document.activeElement?.dataset?.connectionInput;
  if (activeInput) {
    state.focusedConnectionInput = activeInput;
    state.connectionInputs[activeInput] = document.activeElement.value;
  }

  el.connectionList.innerHTML = "";
  for (const connection of state.connections) {
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
    if (connection.links?.length) item.append(createConnectionLinkRow(connection.links));
    item.append(createConnectionActions(connection));

    const job = state.connectionJobs[connection.id] || connection.job;
    if (job) item.append(createConnectionJobPanel(job, connection.id));

    el.connectionList.appendChild(item);
  }

  if (state.focusedConnectionInput) {
    const input = el.connectionList.querySelector(`[data-connection-input="${state.focusedConnectionInput}"]`);
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function createConnectionActions(connection) {
  const actions = document.createElement(connection.action === "api-key" ? "form" : "div");
  actions.className = "connection-actions";

  if (connection.action === "api-key") {
    actions.addEventListener("submit", (event) => {
      event.preventDefault();
      startConnection(connection.id);
    });

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

    const disconnect = createDisconnectButton(connection);
    actions.append(input, button, disconnect);
    return actions;
  }

  const job = state.connectionJobs[connection.id] || connection.job;
  const running = job?.status === "running";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary";
  button.disabled = running;
  button.textContent = running ? "Connecting..." : (connection.connected ? "Reconnect" : "Connect");
  button.addEventListener("click", () => startConnection(connection.id));
  actions.append(button, createDisconnectButton(connection));
  return actions;
}

function createDisconnectButton(connection) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = "Disconnect";
  button.addEventListener("click", () => disconnectConnection(connection.id));
  return button;
}

function createConnectionLinkRow(links) {
  const row = document.createElement("div");
  row.className = "connection-link-row";
  for (const item of links) {
    const link = document.createElement("a");
    link.className = "secondary connection-open-link";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.label || "Open link";
    row.appendChild(link);
  }
  return row;
}

function cleanUrl(raw) {
  return String(raw || "").replace(/[)\].,;:]+$/g, "");
}

function extractUrls(text) {
  const urls = [];
  const seen = new Set();
  const pattern = /https?:\/\/[^\s<>"'`]+/g;
  for (const match of String(text || "").matchAll(pattern)) {
    const url = cleanUrl(match[0]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function appendTextWithLinks(container, text) {
  const value = String(text || "");
  const pattern = /https?:\/\/[^\s<>"'`]+/g;
  let index = 0;
  for (const match of value.matchAll(pattern)) {
    const raw = match[0];
    const url = cleanUrl(raw);
    const start = match.index;
    const end = start + url.length;

    if (start > index) container.appendChild(document.createTextNode(value.slice(index, start)));
    if (url) {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = url;
      container.appendChild(anchor);
    }
    index = end;
  }
  if (index < value.length) container.appendChild(document.createTextNode(value.slice(index)));
}

function createConnectionJobPanel(job, connectionId) {
  const panel = document.createElement("div");
  panel.className = "connection-job";

  const status = document.createElement("div");
  status.className = `connection-job-status ${job.status}`;
  status.textContent = job.status === "running" ? "Waiting for login..." : job.status;
  panel.appendChild(status);

  if (job.output) {
    const urls = extractUrls(job.output);
    if (urls.length) {
      panel.appendChild(createConnectionLinkRow(urls.map((url, index) => ({
        label: urls.length === 1 ? "Open link" : `Open link ${index + 1}`,
        url,
      }))));
    }

    const output = document.createElement("div");
    output.className = "connection-output";
    appendTextWithLinks(output, job.output.trim() || job.output);
    panel.appendChild(output);
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
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendConnectionInput(job.id, input.value, connectionId);
        input.value = "";
      }
    });

    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Send";
    button.addEventListener("click", () => {
      sendConnectionInput(job.id, input.value, connectionId);
      input.value = "";
      state.connectionInputs[connectionId] = "";
    });

    inputRow.append(input, button);
    panel.appendChild(inputRow);
  }

  return panel;
}

async function startConnection(id) {
  const payload = {};
  if (id === "deepseek") {
    const input = el.connectionList.querySelector(`[data-connection-key="${id}"]`);
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
      renderConnections();
      pollConnectionJob(body.job.id, id);
    } else {
      await refreshConnections();
    }
  } catch (error) {
    if (connection) connection.detail = `Error: ${error.message}`;
    renderConnections();
    if (connection) connection.detail = previousDetail;
  }
}

async function disconnectConnection(id) {
  const previous = state.connections.find((item) => item.id === id);
  const previousDetail = previous?.detail;
  try {
    const body = await api(`/api/connections/${id}/disconnect`, { method: "POST" });
    state.connectionInputs[id] = "";
    state.focusedConnectionInput = null;
    delete state.connectionJobs[id];
    state.connections = body.connections || state.connections;
    renderModelStatus();
    renderSupervisors();
    renderConnections();
    updateModalState();
  } catch (error) {
    if (previous) previous.detail = `Error: ${error.message}`;
    renderConnections();
    if (previous) previous.detail = previousDetail;
  }
}

async function sendConnectionInput(jobId, input, connectionId) {
  if (!input.trim()) return;
  try {
    const body = await api(`/api/connections/jobs/${jobId}/input`, {
      method: "POST",
      body: JSON.stringify({ input }),
    });
    state.connectionJobs[connectionId] = body.job;
    state.connectionInputs[connectionId] = "";
    if (state.focusedConnectionInput === connectionId) state.focusedConnectionInput = null;
    renderConnections();
  } catch (error) {
    const job = state.connectionJobs[connectionId];
    if (job) job.output = `${job.output || ""}\nError: ${error.message}\n`;
    renderConnections();
  }
}

function pollConnectionJob(jobId, connectionId) {
  if (state.connectionPollers[jobId]) return;
  const tick = async () => {
    try {
      const body = await api(`/api/connections/jobs/${jobId}`);
      state.connectionJobs[connectionId] = body.job;
      renderConnections();
      if (body.job.status === "running") {
        state.connectionPollers[jobId] = setTimeout(tick, 1500);
        return;
      }
      delete state.connectionPollers[jobId];
      await refreshConnections();
    } catch (error) {
      delete state.connectionPollers[jobId];
      const job = state.connectionJobs[connectionId];
      if (job) job.output = `${job.output || ""}\nError: ${error.message}\n`;
      renderConnections();
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
    const row = document.createElement("div");
    row.className = "session-row";

    const running = Boolean(session.id && state.runs.get(session.id)?.streaming);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session ${isCurrentProject(session) ? "active" : ""} ${running ? "running" : ""}`.trim();

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
    meta.textContent = `${session.supervisor || "unknown"} - ${session.cwd || "."} - ${session.messageCount || 0} msgs`;

    button.append(title, meta);
    button.addEventListener("click", () => openProjectSession(session));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "project-delete-button";
    remove.title = `Delete ${session.cwd || session.project}`;
    remove.setAttribute("aria-label", `Delete ${session.cwd || session.project}`);
    remove.disabled = running;
    remove.innerHTML = iconSvg(icons.trash);
    remove.addEventListener("click", () => deleteProjectFromUi(session));

    row.append(button, remove);
    el.sessionList.appendChild(row);
  }
}

function renderMessages() {
  el.messages.innerHTML = "";
  if (!state.currentSession) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Start a new chat.";
    el.messages.appendChild(empty);
    return;
  }
  if (!state.currentSession.messages?.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = `${state.currentSession.supervisor} in ${workspaceText(state.currentSession.cwd)}`;
    el.messages.appendChild(empty);
    return;
  }
  for (const message of state.currentSession.messages) {
    el.messages.appendChild(createMessageElement(message));
  }
  scrollMessagesToBottom();
}

function createMessageElement(message) {
  const article = document.createElement("article");
  article.className = ["message", message.role, message.streaming ? "streaming" : "", message.error ? "error" : ""]
    .filter(Boolean)
    .join(" ");

  const head = document.createElement("div");
  head.className = "message-head";

  const who = document.createElement("span");
  who.textContent = message.role === "assistant" ? (message.supervisor || "assistant") : "You";

  const when = document.createElement("span");
  when.textContent = message.streaming ? "live" : formatDate(message.at);

  const body = document.createElement("div");
  body.className = "message-body";
  renderMessageBody(body, message);

  head.append(who, when);
  article.append(head, body);
  if (message.attachments?.length) article.append(createAttachmentList(message.attachments, false));
  return article;
}

function renderMessageBody(body, message) {
  body.innerHTML = "";

  const text = document.createElement("span");
  text.textContent = message.content || message.status || (message.streaming ? "Starting..." : "");
  body.appendChild(text);

  if (!message.streaming && !message.trace?.length) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "terminal-open-button";
  button.title = "Open terminal";
  button.setAttribute("aria-label", "Open terminal");
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

function terminalText(trace = []) {
  return trace?.length ? trace.join("") : "Waiting for terminal output...";
}

function renderTerminalModal() {
  const message = state.activeTerminalMessage;
  if (!message) {
    el.terminalTitle.textContent = "Terminal";
    el.terminalOutput.textContent = "Waiting for terminal output...";
    return;
  }
  el.terminalTitle.textContent = terminalTitleFor(message);
  el.terminalOutput.textContent = terminalText(message.trace);
  el.terminalOutput.scrollTop = el.terminalOutput.scrollHeight;
}

function openTerminalModal(message) {
  state.activeTerminalMessage = message;
  renderTerminalModal();
  if (!el.terminalDialog.open) el.terminalDialog.showModal();
}

function closeTerminalModal() {
  state.activeTerminalMessage = null;
  if (el.terminalDialog.open) el.terminalDialog.close();
}

function syncOpenTerminal(message) {
  if (state.activeTerminalMessage === message && el.terminalDialog.open) {
    renderTerminalModal();
  }
}

function updateLastMessage(message) {
  const last = el.messages.lastElementChild;
  if (!last?.classList?.contains("message")) {
    renderMessages();
    return;
  }
  last.className = ["message", message.role, message.streaming ? "streaming" : "", message.error ? "error" : ""]
    .filter(Boolean)
    .join(" ");
  const when = last.querySelector(".message-head span:last-child");
  const body = last.querySelector(".message-body");
  if (when) when.textContent = message.streaming ? "live" : formatDate(message.at);
  if (body) renderMessageBody(body, message);
  syncOpenTerminal(message);
  scrollMessagesToBottom();
}

function scrollMessagesToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
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
  if (!state.selectedFiles.length) return;
  el.attachmentList.appendChild(createAttachmentList(state.selectedFiles, true));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function fileToAttachment(file) {
  const buffer = await file.arrayBuffer();
  return {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    dataBase64: arrayBufferToBase64(buffer),
  };
}

async function readAttachments(files) {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (state.config?.maxUploadBytes && totalBytes > state.config.maxUploadBytes) {
    throw new Error(`Attached files exceed ${formatBytes(state.config.maxUploadBytes)}`);
  }
  return Promise.all(files.map(fileToAttachment));
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
}

function syncComposerState() {
  setComposerEnabled(Boolean(state.currentSession));
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

async function openNewChatModal() {
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

async function sendMessage(content, files = []) {
  if (!state.currentSession) {
    setStatus("Create a new chat first");
    await openNewChatModal();
    return;
  }

  const session = state.currentSession;
  if (state.runs.has(session.id)) return; // a run is already streaming for this project
  const supervisor = session.supervisor;
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
    at: new Date().toISOString(),
    streaming: true,
  };

  session.messages ||= [];
  session.messages.push(userMessage, draft);

  const run = { sessionId: session.id, session, draft, supervisor, streaming: true, stopInFlight: false, heartbeat: null };
  state.runs.set(session.id, run);
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
    const attachments = await readAttachments(files);
    if (viewing()) setStatus(`Running ${supervisor}...`);
    await streamApi(`/api/sessions/${run.sessionId}/messages/stream`, {
      content,
      attachments,
    }, {
      session(event) {
        run.session = event.session;
        run.session.messages.push(draft);
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
      done(event) {
        draft.streaming = false;
        run.streaming = false;
        run.session = event.session;
        const last = run.session.messages.at(-1);
        if (last) last.trace = draft.trace;
        if (viewing()) {
          state.currentSession = run.session;
          renderMessages();
          syncOpenTerminal(draft);
          syncComposerState();
          setWorkspaceStatus();
        }
      },
      error(event) {
        draft.streaming = false;
        run.streaming = false;
        run.session = event.session || run.session;
        const last = run.session?.messages?.at(-1);
        if (last) last.trace = draft.trace;
        if (viewing()) {
          state.currentSession = run.session;
          setStatus(`Error: ${event.error}`);
          renderMessages();
          syncOpenTerminal(draft);
        }
      },
      stopped(event) {
        draft.streaming = false;
        run.streaming = false;
        run.session = event.session || run.session;
        const last = run.session?.messages?.at(-1);
        if (last) last.trace = draft.trace;
        if (viewing()) {
          state.currentSession = run.session;
          setStatus(event.error || "Stopped by user");
          renderMessages();
          syncOpenTerminal(draft);
        }
      },
    });
    await refreshSessions();
  } catch (error) {
    draft.error = true;
    draft.streaming = false;
    run.streaming = false;
    draft.status = "";
    draft.content = draft.content || `Error: ${error.message}`;
    if (viewing()) {
      setStatus(`Error: ${error.message}`);
      updateLastMessage(draft);
    }
  } finally {
    clearInterval(run.heartbeat);
    state.runs.delete(run.sessionId);
    renderSessions();
    if (viewing()) syncComposerState();
  }
}

async function streamApi(path, body, handlers = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        handlers.trace?.({ content: "[client] ignored malformed stream line\n" });
        continue;
      }
      handlers[event.type]?.(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer);
      handlers[event.type]?.(event);
    } catch {
      handlers.trace?.({ content: "[client] ignored malformed final stream line\n" });
    }
  }
}

async function init() {
  state.config = await api("/api/config");
  await refreshModelStatus();
  renderSupervisors();
  await refreshSessions();
  if (state.sessions[0]) await loadSession(state.sessions[0].id);
  else {
    state.currentSession = null;
    renderMessages();
    syncComposerState();
    setWorkspaceStatus();
  }
}

el.newChat.addEventListener("click", openNewChatModal);
el.sidebarToggle.addEventListener("click", toggleSidebar);
el.connectButton.addEventListener("click", openConnectModal);
el.promptButton.addEventListener("click", openPromptModal);
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
  if (el.attachmentMenu.hidden) return;
  if (event.target.closest(".attachment-menu-wrap")) return;
  closeAttachmentMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.attachmentMenu.hidden) closeAttachmentMenu();
});
el.closeConnect.addEventListener("click", closeConnectModal);
el.refreshConnections.addEventListener("click", refreshConnections);
el.connectDialog.addEventListener("click", (event) => {
  if (event.target === el.connectDialog) closeConnectModal();
});
el.connectDialog.querySelector("[data-close-connect]").addEventListener("click", closeConnectModal);
el.closePrompts.addEventListener("click", closePromptModal);
el.promptDialog.addEventListener("click", (event) => {
  if (event.target === el.promptDialog) closePromptModal();
});
el.promptDialog.querySelector("[data-close-prompts]").addEventListener("click", closePromptModal);
el.promptEditor.addEventListener("input", storeActivePromptDraft);
el.savePrompts.addEventListener("click", savePromptSettings);
el.closeTerminal.addEventListener("click", closeTerminalModal);
el.terminalDialog.addEventListener("click", (event) => {
  if (event.target === el.terminalDialog) closeTerminalModal();
});
el.terminalDialog.addEventListener("close", () => {
  state.activeTerminalMessage = null;
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
  el.messageInput.value = "";
  state.selectedFiles = [];
  renderSelectedAttachments();
  await sendMessage(content, files);
});
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

init().catch((error) => setStatus(`Init error: ${error.message}`));
