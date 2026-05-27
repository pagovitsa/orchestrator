function bytesLabel(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function fileToAttachment(file) {
  const buffer = await file.arrayBuffer();
  return {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    dataBase64: arrayBufferToBase64(buffer),
  };
}

export async function readAttachments(files, { maxUploadBytes = 0 } = {}) {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (maxUploadBytes && totalBytes > maxUploadBytes) {
    throw new Error(`Attached files exceed ${bytesLabel(maxUploadBytes)}`);
  }
  return Promise.all(files.map(fileToAttachment));
}

export function messageClassNames(message) {
  return ["message", message.role, message.streaming ? "streaming" : "", message.error ? "error" : "", message.stopped ? "stopped" : ""]
    .filter(Boolean)
    .join(" ");
}

export function applyTerminalFlags(target, draft) {
  if (!target || !draft) return;
  if (draft.error) target.error = true;
  if (draft.stopped) target.stopped = true;
}

export function createSessionSendGate() {
  const pending = new Set();
  return {
    tryStart(sessionId) {
      if (!sessionId || pending.has(sessionId)) return false;
      pending.add(sessionId);
      return true;
    },
    finish(sessionId) {
      pending.delete(sessionId);
    },
    has(sessionId) {
      return pending.has(sessionId);
    },
  };
}

const terminalStreamEvents = new Set(["done", "error", "stopped"]);

function handleStreamEvent(event, handlers) {
  handlers[event.type]?.(event);
  return terminalStreamEvents.has(event.type);
}

export async function streamApi(path, body, handlers = {}, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminalEvent = false;

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
      sawTerminalEvent = handleStreamEvent(event, handlers) || sawTerminalEvent;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer);
      sawTerminalEvent = handleStreamEvent(event, handlers) || sawTerminalEvent;
    } catch {
      handlers.trace?.({ content: "[client] ignored malformed final stream line\n" });
    }
  }

  if (!sawTerminalEvent) throw new Error("Stream ended before completion");
}
