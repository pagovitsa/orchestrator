import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { paths, runtime } from "../config/env.js";

const execFileAsync = promisify(execFile);

const PROJECT_GITIGNORE = [
  "# Created by Orchestrator. Ignores app runtime artifacts and local env files.",
  ".orch-ui/",
  ".remember/",
  ".env",
  "",
].join("\n");

// Best-effort `git init` for a freshly created project. Never throws: returns gitInitialized/gitError.
async function initProjectGit(projectPath) {
  try {
    await execFileAsync("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"]);
    return { gitInitialized: false };
  } catch {
    // Not a repo yet: proceed.
  }
  try {
    try {
      await writeFile(path.join(projectPath, ".gitignore"), PROJECT_GITIGNORE, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error; // never clobber an existing .gitignore
    }
    await execFileAsync("git", ["-C", projectPath, "init"]);
    return { gitInitialized: true };
  } catch (error) {
    return { gitInitialized: false, gitError: error.message || String(error) };
  }
}

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
    const result = { project, created: true };
    if (runtime.gitInitProjects) Object.assign(result, await initProjectGit(projectPath));
    return result;
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

export async function deleteProject(name) {
  const project = normalizeProjectName(name);
  const projectPath = resolveCwd(project);
  let existing;
  try {
    existing = await lstat(projectPath);
  } catch (error) {
    if (error.code === "ENOENT") throw Object.assign(new Error("Project not found"), { status: 404 });
    throw error;
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw Object.assign(new Error("Project must be a real folder inside /workspace"), { status: 409 });
  }
  try {
    await rm(projectPath, { recursive: true, force: true });
  } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM") {
      throw Object.assign(
        new Error(`Could not delete "${project}": some files are owned by another user${error.path ? ` (${error.path})` : ""}. Remove them manually.`),
        { status: 409 },
      );
    }
    throw error;
  }
  return { project };
}
