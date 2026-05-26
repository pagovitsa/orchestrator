import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths, sourcePromptFiles, supervisors } from "../config/env.js";

const promptIds = Object.keys(supervisors);

function promptPath(id) {
  return path.join(paths.promptDir, `${id}.md`);
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

async function promptFileExists(id) {
  try {
    return (await stat(promptPath(id))).isFile();
  } catch {
    return false;
  }
}

export async function ensurePromptStore() {
  await mkdir(paths.promptDir, { recursive: true });
  await Promise.all(promptIds.map(async (id) => {
    if (await promptFileExists(id)) return;
    await writeFile(promptPath(id), await fallbackPrompt(id), "utf8");
  }));
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
  await ensurePromptStore();
  return {
    promptDir: paths.promptDir,
    prompts: await Promise.all(promptIds.map(async (id) => ({
      id,
      label: supervisors[id].label,
      path: promptPath(id),
      sourcePath: sourcePromptFiles[id],
      content: await loadPrompt(id),
    }))),
  };
}

export async function savePrompts(body = {}) {
  await ensurePromptStore();
  const prompts = body.prompts || {};
  for (const id of Object.keys(prompts)) {
    if (!supervisors[id]) {
      throw Object.assign(new Error(`Unknown prompt target: ${id}`), { status: 400 });
    }
  }
  await Promise.all(promptIds.map(async (id) => {
    if (prompts[id] === undefined) return;
    const content = String(prompts[id]);
    if (content.length > 200000) {
      throw Object.assign(new Error(`${supervisors[id].label} prompt is too large`), { status: 413 });
    }
    await writeFile(promptPath(id), content, "utf8");
  }));
  return listPrompts();
}
