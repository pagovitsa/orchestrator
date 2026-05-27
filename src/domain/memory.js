import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const validScopes = new Set(["user", "project"]);
const validKinds = new Set(["fact", "preference", "decision", "summary", "note"]);
export const memoryNamespaces = ["general", "profile", "tasks", "solutions", "patterns", "feedback", "security", "autopilot"];
const validNamespaces = new Set(memoryNamespaces);
const secretPattern = /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|bearer|password|passwd|secret|private[_ -]?key)\b/i;

function nowIso() {
  return new Date().toISOString();
}

function emptyStore(scope) {
  return {
    schemaVersion: 2,
    scope,
    summary: "",
    memories: [],
    updatedAt: "",
  };
}

function normalizeText(text, maxLength = 2000) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags
    .map((tag) => normalizeText(tag, 48).toLowerCase())
    .filter(Boolean))]
    .slice(0, 12);
}

function normalizeKind(kind) {
  const clean = normalizeText(kind, 32).toLowerCase();
  return validKinds.has(clean) ? clean : "note";
}

function defaultNamespaceFor(kind, scope) {
  if (scope === "user" && (kind === "fact" || kind === "preference")) return "profile";
  if (kind === "decision") return "tasks";
  return "general";
}

export function normalizeMemoryNamespace(namespace, kind = "note", scope = "project") {
  const clean = normalizeText(namespace, 32).toLowerCase();
  return validNamespaces.has(clean) ? clean : defaultNamespaceFor(normalizeKind(kind), scope);
}

function normalizeScope(scope, fallback = "project") {
  const clean = normalizeText(scope, 32).toLowerCase();
  return validScopes.has(clean) ? clean : fallback;
}

function normalizeMemory(memory, scope) {
  const text = normalizeText(memory?.text);
  if (!text) return null;
  const at = memory.createdAt || nowIso();
  return {
    id: /^[a-f0-9-]{36}$/.test(memory.id || "") ? memory.id : randomUUID(),
    scope,
    kind: normalizeKind(memory.kind),
    namespace: normalizeMemoryNamespace(memory.namespace, memory.kind, scope),
    text,
    tags: normalizeTags(memory.tags),
    source: normalizeText(memory.source, 160),
    createdAt: at,
    updatedAt: memory.updatedAt || at,
  };
}

function normalizeStore(raw, scope) {
  const store = emptyStore(scope);
  if (!raw || typeof raw !== "object") return store;
  store.summary = normalizeText(raw.summary, 6000);
  store.updatedAt = raw.updatedAt || "";
  store.memories = Array.isArray(raw.memories)
    ? raw.memories.map((memory) => normalizeMemory(memory, scope)).filter(Boolean)
    : [];
  return store;
}

async function readStore(filePath, scope) {
  try {
    return normalizeStore(JSON.parse(await readFile(filePath, "utf8")), scope);
  } catch (error) {
    if (error.code === "ENOENT") return emptyStore(scope);
    if (error instanceof SyntaxError) return emptyStore(scope);
    throw error;
  }
}

async function writeStore(filePath, store) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  store.updatedAt = nowIso();
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function withStoreLock(filePath, task) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const started = Date.now();
  let handle = null;
  for (;;) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() - started > 5000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
  }
  try {
    return await task();
  } finally {
    await handle?.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

function fileForScope(files, scope) {
  if (scope === "user") return files.globalFile;
  if (scope === "project") return files.projectFile;
  throw new Error(`Unknown memory scope: ${scope}`);
}

function validateFiles(files) {
  if (!files?.globalFile) throw new Error("Missing global memory file");
  if (!files?.projectFile) throw new Error("Missing project memory file");
}

function rejectSecretLikeText(text) {
  if (secretPattern.test(text)) {
    throw Object.assign(new Error("Refusing to store secrets, tokens, passwords, or keys in memory"), { status: 400 });
  }
}

function sortMemories(memories) {
  return [...memories].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

function limitMemories(memories, limit = 25) {
  const count = Math.max(1, Math.min(100, Number(limit) || 25));
  return sortMemories(memories).slice(0, count);
}

function scoreMemory(memory, terms) {
  const haystack = `${memory.text} ${memory.kind} ${memory.namespace || ""} ${(memory.tags || []).join(" ")}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function filterByNamespace(memories, namespace) {
  const clean = normalizeText(namespace, 32).toLowerCase();
  if (!clean || clean === "all") return memories;
  if (!validNamespaces.has(clean)) return [];
  return memories.filter((memory) => memory.namespace === clean);
}

function filterByQuery(memories, query, namespace) {
  const scoped = filterByNamespace(memories, namespace);
  const terms = normalizeText(query, 300).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return sortMemories(scoped);
  return scoped
    .map((memory) => ({ memory, score: scoreMemory(memory, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.memory.updatedAt).localeCompare(String(a.memory.updatedAt)))
    .map((item) => item.memory);
}

function cleanName(value) {
  return normalizeText(value, 80)
    .split(/\s+(?:and|but|because|with|και)\s+/i)[0]
    .replace(/[.!?,;:]+$/g, "")
    .trim();
}

export function extractUserMemoriesFromText(text) {
  const value = String(text || "");
  const patterns = [
    /\b(?:my name is|call me|i am called)\s+([A-Za-z\u0370-\u03ff][A-Za-z\u0370-\u03ff.' -]{0,80})/i,
    /\b(?:με λένε|με λενε|το όνομά μου είναι|το ονομα μου ειναι)\s+([A-Za-z\u0370-\u03ff][A-Za-z\u0370-\u03ff.' -]{0,80})/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const name = cleanName(match?.[1] || "");
    if (name && !secretPattern.test(name)) {
      return [{
        scope: "user",
        kind: "fact",
        namespace: "profile",
        text: `The user's name is ${name}`,
        tags: ["identity", "name"],
        source: "auto-detected from user message",
      }];
    }
  }
  return [];
}

export async function readMemory(files, { scope = "all", query = "", namespace = "all", limit = 25 } = {}) {
  validateFiles(files);
  const cleanScope = normalizeText(scope, 16).toLowerCase();
  const result = {};
  if (cleanScope === "all" || cleanScope === "user") {
    const store = await readStore(files.globalFile, "user");
    result.user = {
      summary: store.summary,
      memories: limitMemories(filterByQuery(store.memories, query, namespace), limit),
    };
  }
  if (cleanScope === "all" || cleanScope === "project") {
    const store = await readStore(files.projectFile, "project");
    result.project = {
      summary: store.summary,
      memories: limitMemories(filterByQuery(store.memories, query, namespace), limit),
    };
  }
  return result;
}

export async function rememberMemory(files, args = {}) {
  validateFiles(files);
  const scope = normalizeScope(args.scope);
  const text = normalizeText(args.text);
  if (!text) throw Object.assign(new Error("Memory text is required"), { status: 400 });
  rejectSecretLikeText(text);
  const filePath = fileForScope(files, scope);
  return withStoreLock(filePath, async () => {
    const store = await readStore(filePath, scope);
    const normalizedText = text.toLowerCase();
    const existing = store.memories.find((memory) => memory.text.toLowerCase() === normalizedText);
    if (existing) {
      existing.kind = normalizeKind(args.kind || existing.kind);
      existing.namespace = normalizeMemoryNamespace(args.namespace || existing.namespace, existing.kind, scope);
      existing.tags = normalizeTags([...(existing.tags || []), ...(Array.isArray(args.tags) ? args.tags : [])]);
      existing.source = normalizeText(args.source || existing.source, 160);
      existing.updatedAt = nowIso();
      await writeStore(filePath, store);
      return { status: "updated", memory: existing };
    }
    const memory = normalizeMemory({
      text,
      kind: args.kind,
      namespace: args.namespace,
      tags: args.tags,
      source: args.source,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }, scope);
    store.memories.push(memory);
    await writeStore(filePath, store);
    return { status: "stored", memory };
  });
}

export async function forgetMemory(files, args = {}) {
  validateFiles(files);
  const scope = normalizeScope(args.scope);
  const id = normalizeText(args.id, 80);
  const exactText = normalizeText(args.exactText);
  if (!id && !exactText) throw Object.assign(new Error("Provide memory id or exactText to forget"), { status: 400 });
  const filePath = fileForScope(files, scope);
  return withStoreLock(filePath, async () => {
    const store = await readStore(filePath, scope);
    const before = store.memories.length;
    store.memories = store.memories.filter((memory) => {
      if (id && memory.id === id) return false;
      if (exactText && memory.text.toLowerCase() === exactText.toLowerCase()) return false;
      return true;
    });
    const removed = before - store.memories.length;
    if (removed) await writeStore(filePath, store);
    return { status: removed ? "forgotten" : "not_found", removed };
  });
}

export async function updateMemorySummary(files, args = {}) {
  validateFiles(files);
  const scope = normalizeScope(args.scope);
  const summary = normalizeText(args.summary, 6000);
  rejectSecretLikeText(summary);
  const filePath = fileForScope(files, scope);
  return withStoreLock(filePath, async () => {
    const store = await readStore(filePath, scope);
    store.summary = summary;
    await writeStore(filePath, store);
    return { status: "updated", scope, summary };
  });
}
