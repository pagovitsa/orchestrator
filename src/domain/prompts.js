import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths, sourcePromptFiles, supervisors } from "../config/env.js";

const promptIds = Object.keys(supervisors);
// Manifest sentinel for a copy we must never auto-overwrite (legacy or user-edited).
const USER_OWNED = "user-owned";

function promptPath(id) {
  return path.join(paths.promptDir, `${id}.md`);
}

function manifestPath() {
  return path.join(paths.promptDir, ".seed-manifest.json");
}

function hashContent(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(manifestPath(), "utf8"));
  } catch {
    return {};
  }
}

// Write via a temp file + rename so an interrupted write never leaves a truncated prompt/manifest.
async function writeAtomic(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

// Strict source read for seeding/refresh: returns null if the canonical repo prompt is unreadable,
// so we never overwrite an existing live file with lenient fallback content.
async function readSourcePrompt(id) {
  try {
    const filePath = sourcePromptFiles[id];
    if (filePath) return await readFile(filePath, "utf8");
  } catch {
    // Source unavailable.
  }
  return null;
}

async function readPromptFile(id) {
  try {
    return await readFile(promptPath(id), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function fallbackPrompt(id) {
  for (const filePath of [sourcePromptFiles[id], paths.promptFile]) {
    try {
      if (filePath) return await readFile(filePath, "utf8");
    } catch {
      // Keep trying fallbacks.
    }
  }
  return "# Orchestrator Prompt\n";
}

async function promptDetails(id, manifest = {}) {
  const live = await readPromptFile(id);
  const source = await readSourcePrompt(id);
  const content = live ?? source ?? await fallbackPrompt(id);
  const sourceHash = source === null ? "" : hashContent(source);
  const liveHash = live === null ? "" : hashContent(live);
  return {
    id,
    label: supervisors[id].label,
    path: promptPath(id),
    sourcePath: sourcePromptFiles[id],
    content,
    sourceAvailable: source !== null,
    sourceHash,
    liveHash,
    userOwned: manifest[id] === USER_OWNED,
    outdated: Boolean(source !== null && live !== null && liveHash !== sourceHash),
  };
}

// Seeds /data/prompts from the repo source prompts and refreshes copies the user has not edited.
// A file is "pristine" when its content still matches the hash we last seeded; pristine files are
// rewritten when the source changes, while user-edited files (marked user-owned) are left untouched.
// Run only at startup (before the HTTP server accepts requests) so it cannot race with UI saves.
export async function ensurePromptStore() {
  await mkdir(paths.promptDir, { recursive: true });
  const manifest = await readManifest();
  let manifestChanged = false;

  await Promise.all(promptIds.map(async (id) => {
    const live = await readPromptFile(id);
    const source = await readSourcePrompt(id);

    if (live === null) {
      // No live copy yet: seed from canonical source, or lenient fallback as a last resort.
      const seed = source ?? await fallbackPrompt(id);
      await writeAtomic(promptPath(id), seed);
      manifest[id] = hashContent(seed);
      manifestChanged = true;
      return;
    }

    // Cannot read the canonical source: never touch an existing live file.
    if (source === null) return;

    const liveHash = hashContent(live);
    const sourceHash = hashContent(source);

    if (liveHash === sourceHash) {
      if (manifest[id] !== sourceHash) {
        manifest[id] = sourceHash;
        manifestChanged = true;
      }
      return;
    }

    if (manifest[id] === liveHash) {
      // Pristine but stale: refresh to the current source.
      await writeAtomic(promptPath(id), source);
      manifest[id] = sourceHash;
      manifestChanged = true;
    } else if (manifest[id] === undefined) {
      // Unknown existing copy (pre-manifest/legacy): mark user-owned so it is never auto-overwritten.
      manifest[id] = USER_OWNED;
      manifestChanged = true;
    }
    // Otherwise the manifest holds a different hash or USER_OWNED -> user-edited, leave untouched.
  }));

  if (manifestChanged) {
    await writeAtomic(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export async function loadPrompt(id) {
  const supervisor = supervisors[id] ? id : promptIds[0];
  try {
    return await readFile(promptPath(supervisor), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return fallbackPrompt(supervisor);
  }
}

export async function listPrompts() {
  const manifest = await readManifest();
  return {
    promptDir: paths.promptDir,
    prompts: await Promise.all(promptIds.map((id) => promptDetails(id, manifest))),
  };
}

export async function resetPrompts(body = {}) {
  await mkdir(paths.promptDir, { recursive: true });
  const rawIds = body.ids === undefined
    ? promptIds
    : Array.isArray(body.ids)
      ? body.ids
      : [body.ids];
  const ids = [...new Set(rawIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) throw Object.assign(new Error("Select at least one prompt to reset"), { status: 400 });
  for (const id of ids) {
    if (!supervisors[id]) throw Object.assign(new Error(`Unknown prompt target: ${id}`), { status: 400 });
  }

  const manifest = await readManifest();
  for (const id of ids) {
    const source = await readSourcePrompt(id);
    if (source === null) {
      throw Object.assign(new Error(`${supervisors[id].label} canonical prompt is unavailable`), { status: 404 });
    }
    await writeAtomic(promptPath(id), source);
    manifest[id] = hashContent(source);
  }
  await writeAtomic(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  return listPrompts();
}

export async function savePrompts(body = {}) {
  await mkdir(paths.promptDir, { recursive: true });
  const prompts = body.prompts || {};
  for (const id of Object.keys(prompts)) {
    if (!supervisors[id]) {
      throw Object.assign(new Error(`Unknown prompt target: ${id}`), { status: 400 });
    }
  }

  const edited = promptIds.filter((id) => prompts[id] !== undefined);
  await Promise.all(edited.map(async (id) => {
    const content = String(prompts[id]);
    if (content.length > 200000) {
      throw Object.assign(new Error(`${supervisors[id].label} prompt is too large`), { status: 413 });
    }
    await writeAtomic(promptPath(id), content);
  }));

  if (edited.length) {
    // Mark edited prompts user-owned so startup seeding never overwrites them.
    const manifest = await readManifest();
    for (const id of edited) manifest[id] = USER_OWNED;
    await writeAtomic(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return listPrompts();
}
