import { runtime } from "../config/env.js";
import { formatBytes } from "../utils/format.js";

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendText(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

export async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > runtime.maxPayloadBytes) {
      throw Object.assign(new Error(`Request body exceeds ${formatBytes(runtime.maxPayloadBytes)}`), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export function writeStreamEvent(res, event) {
  res.write(`${JSON.stringify(event)}\n`);
}
