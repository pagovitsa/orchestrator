import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { paths, runtime } from "../config/env.js";

export function resolveCwd(cwd = ".") {
  const resolved = path.resolve(paths.workspaceRoot, cwd || ".");
  if (resolved !== paths.workspaceRoot && !resolved.startsWith(`${paths.workspaceRoot}${path.sep}`)) {
    throw Object.assign(new Error("cwd must stay inside /workspace"), { status: 400 });
  }
  return resolved;
}

export function requireScopedCwd(cwd = ".") {
  const resolved = resolveCwd(cwd);
  if (!runtime.allowWorkspaceRoot && resolved === paths.workspaceRoot) {
    throw Object.assign(new Error("Select a workspace folder before sending a message"), { status: 400 });
  }
  return resolved;
}

export async function listProjects() {
  const entries = await readdir(paths.workspaceRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function normalizeProjectName(name) {
  const clean = String(name || "").trim().replace(/\s+/g, " ");
  if (!clean) throw Object.assign(new Error("Folder name is required"), { status: 400 });
  if (clean.length > 80) throw Object.assign(new Error("Folder name must be 80 characters or less"), { status: 400 });
  if (clean.startsWith(".") || clean === ".." || clean.includes("/") || clean.includes("\\") || clean.includes("\0")) {
    throw Object.assign(new Error("Folder name must be a single folder inside /workspace"), { status: 400 });
  }
  return clean;
}

export async function ensureProject(name) {
  const project = normalizeProjectName(name);
  const projectPath = resolveCwd(project);
  try {
    await mkdir(projectPath, { recursive: false });
    return { project, created: true };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await stat(projectPath);
    if (!existing.isDirectory()) {
      throw Object.assign(new Error("A non-folder item already exists with that name"), { status: 409 });
    }
    return { project, created: false };
  }
}

export async function createProject(name) {
  const result = await ensureProject(name);
  return result.project;
}
