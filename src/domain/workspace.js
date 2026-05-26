import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { paths, runtime } from "../config/env.js";

let cachedWorkspaceRealRoot = "";

function isInside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function workspaceRealRoot() {
  if (!cachedWorkspaceRealRoot) cachedWorkspaceRealRoot = realpathSync.native(paths.workspaceRoot);
  return cachedWorkspaceRealRoot;
}

function nearestExistingRealPath(candidate) {
  let current = candidate;
  for (;;) {
    try {
      return realpathSync.native(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export function resolveCwd(cwd = ".") {
  const resolved = path.resolve(paths.workspaceRoot, cwd || ".");
  if (!isInside(resolved, paths.workspaceRoot)) {
    throw Object.assign(new Error("cwd must stay inside /workspace"), { status: 400 });
  }

  try {
    const realRoot = workspaceRealRoot();
    const realResolved = nearestExistingRealPath(resolved);
    if (!isInside(realResolved, realRoot)) {
      throw Object.assign(new Error("cwd must stay inside /workspace"), { status: 400 });
    }
  } catch (error) {
    if (error.status) throw error;
    if (error.code !== "ENOENT") throw error;
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
    const existing = await lstat(projectPath);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw Object.assign(new Error("A non-folder item already exists with that name"), { status: 409 });
    }
    resolveCwd(project);
    return { project, created: false };
  }
}

export async function createProject(name) {
  const result = await ensureProject(name);
  return result.project;
}
