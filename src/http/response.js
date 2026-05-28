import { runtime } from "../config/env.js";
import { redactSensitiveText } from "../domain/safety.js";
import { formatBytes } from "../utils/format.js";

const MAX_ERROR_RESPONSE_CHARS = 1000;

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendErrorJson(res, error) {
  const status = error?.status || 500;
  const message = redactSensitiveText(error?.message || String(error || "Unknown error"))
    .slice(0, MAX_ERROR_RESPONSE_CHARS);
  return sendJson(res, status, { error: message });
}

export function sendText(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

export async function readBody(req) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > runtime.maxPayloadBytes) {
        // Aborting the request stream lets the kernel reject the rest of the upload instead of
        // leaving the keep-alive connection waiting for us to read a multi-MB body we will
        // never use.
        req.destroy();
        throw Object.assign(new Error(`Request body exceeds ${formatBytes(runtime.maxPayloadBytes)}`), { status: 413 });
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.status) throw error;
    throw Object.assign(new Error("Failed to read request body"), { status: 400 });
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON request body"), { status: 400 });
  }
}

export function writeStreamEvent(res, event) {
  if (res.destroyed || res.writableEnded) return false;
  try {
    return res.write(`${JSON.stringify(event)}\n`);
  } catch {
    return false;
  }
}
