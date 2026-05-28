import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { paths } from "../config/env.js";
import { resolveCwd } from "./workspace.js";

const execFileAsync = promisify(execFile);

const GITHUB_API_BASE = "https://api.github.com";
const SSH_OPTS = ["-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

function githubDir() {
  return path.join(paths.secretsDir, "github");
}

function privateKeyPath() {
  return path.join(githubDir(), "id_ed25519");
}

function publicKeyPath() {
  return `${privateKeyPath()}.pub`;
}

function tokenPath() {
  return path.join(githubDir(), "token");
}

function sshCommand() {
  // Force git/ssh to use exactly our generated key, no agent, no other identities, no
  // host-key prompt. Quoting the path keeps spaces safe.
  return `ssh -i "${privateKeyPath()}" ${SSH_OPTS.join(" ")}`;
}

async function fileExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function writeFileAtomic(filePath, content, options = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, content, options);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

// Generates an ed25519 keypair if missing. Idempotent: if both files already exist returns the
// current public key without rotating. The private key is created via ssh-keygen so it has the
// canonical OpenSSH PEM/PKCS8 wire format git expects.
export async function ensureKeypair() {
  await mkdir(githubDir(), { recursive: true });
  await chmod(githubDir(), 0o700).catch(() => {});
  if (await fileExists(privateKeyPath()) && await fileExists(publicKeyPath())) {
    const publicKey = (await readFile(publicKeyPath(), "utf8")).trim();
    return { publicKey, created: false };
  }
  // Remove any half-state before regenerating.
  await rm(privateKeyPath(), { force: true });
  await rm(publicKeyPath(), { force: true });
  await execFileAsync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "orch-ui", "-f", privateKeyPath()]);
  await chmod(privateKeyPath(), 0o600).catch(() => {});
  await chmod(publicKeyPath(), 0o644).catch(() => {});
  const publicKey = (await readFile(publicKeyPath(), "utf8")).trim();
  return { publicKey, created: true };
}

export async function readPublicKey() {
  if (!await fileExists(publicKeyPath())) return "";
  return (await readFile(publicKeyPath(), "utf8")).trim();
}

export async function saveToken(token) {
  const clean = String(token || "").trim();
  if (!clean) throw Object.assign(new Error("GitHub token is required"), { status: 400 });
  await writeFileAtomic(tokenPath(), `${clean}\n`, { encoding: "utf8", mode: 0o600 });
  return { saved: true };
}

export async function readToken() {
  if (!await fileExists(tokenPath())) return "";
  return (await readFile(tokenPath(), "utf8")).trim();
}

export async function clearGithubConnection() {
  await rm(tokenPath(), { force: true });
  await rm(privateKeyPath(), { force: true });
  await rm(publicKeyPath(), { force: true });
}

async function githubRequest(token, method, pathPart, body) {
  const response = await fetch(`${GITHUB_API_BASE}${pathPart}`, {
    method,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { payload = { rawBody: text.slice(0, 400) }; }
  if (!response.ok) {
    throw Object.assign(new Error(payload.message || `GitHub HTTP ${response.status}`), {
      status: response.status,
      githubErrors: payload.errors,
    });
  }
  return payload;
}

export async function verifyToken(token) {
  const viewer = await githubRequest(token, "GET", "/user");
  return { login: viewer.login, id: viewer.id, name: viewer.name, htmlUrl: viewer.html_url };
}

// Returns "Hi <login>!" success even though ssh -T exits 1 by design.
export async function testSshAccess() {
  if (!await fileExists(privateKeyPath())) return { connected: false, detail: "Keypair not generated yet" };
  try {
    await execFileAsync("ssh", ["-T", "-i", privateKeyPath(), ...SSH_OPTS, "git@github.com"]);
    return { connected: true, detail: "Authenticated" };
  } catch (error) {
    const stderr = String(error.stderr || error.stdout || "");
    const match = stderr.match(/Hi\s+([\w-]+)!/);
    if (match) return { connected: true, detail: `Authenticated as ${match[1]}`, login: match[1] };
    return { connected: false, detail: stderr.slice(-400) || error.message || "SSH authentication failed" };
  }
}

async function gitInProject(projectPath, args, env = {}) {
  return execFileAsync("git", ["-C", projectPath, ...args], {
    env: { ...process.env, GIT_SSH_COMMAND: sshCommand(), ...env },
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function isRepo(projectPath) {
  try {
    await execFileAsync("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch { return false; }
}

async function gitRemoteUrl(projectPath, remote = "origin") {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectPath, "remote", "get-url", remote]);
    return stdout.trim();
  } catch { return ""; }
}

async function gitHasAnyCommits(projectPath) {
  try {
    await execFileAsync("git", ["-C", projectPath, "rev-parse", "HEAD"]);
    return true;
  } catch { return false; }
}

async function gitDefaultBranch(projectPath) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectPath, "symbolic-ref", "--short", "HEAD"]);
    return stdout.trim();
  } catch { return "main"; }
}

function parseGithubRemote(url) {
  if (!url) return null;
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], name: ssh[2] };
  const https = url.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return { owner: https[1], name: https[2] };
  return null;
}

export async function projectGithubStatus(projectName) {
  const projectPath = resolveCwd(projectName);
  if (!await isRepo(projectPath)) {
    return { project: projectName, isRepo: false, hasOrigin: false, remoteUrl: "", repo: null, defaultBranch: "main", hasCommits: false };
  }
  const remoteUrl = await gitRemoteUrl(projectPath);
  return {
    project: projectName,
    isRepo: true,
    hasOrigin: Boolean(remoteUrl),
    remoteUrl,
    repo: parseGithubRemote(remoteUrl),
    defaultBranch: await gitDefaultBranch(projectPath),
    hasCommits: await gitHasAnyCommits(projectPath),
  };
}

export async function githubConnectionStatus() {
  const hasToken = Boolean(await readToken());
  const publicKey = await readPublicKey();
  return {
    hasToken,
    hasKeypair: Boolean(publicKey),
    publicKey,
  };
}

function sanitizeRepoName(name) {
  const clean = String(name || "").trim().replace(/\s+/g, "-");
  if (!clean) throw Object.assign(new Error("Repository name is required"), { status: 400 });
  if (!/^[a-zA-Z0-9._-]+$/.test(clean)) {
    throw Object.assign(new Error("Repository name can only contain letters, numbers, '.', '_' and '-'"), { status: 400 });
  }
  if (clean.length > 100) throw Object.assign(new Error("Repository name must be 100 characters or less"), { status: 400 });
  return clean;
}

// Publishes a workspace project to a brand-new private GitHub repo. Steps are idempotent where
// safe: git init / initial commit are skipped if the repo already has them; remote is updated
// to the new repo if a stale one existed.
export async function publishProjectToGithub(projectName, { repoName: requestedName, description = "" } = {}) {
  const projectPath = resolveCwd(projectName);
  const repoName = sanitizeRepoName(requestedName || projectName);

  const token = await readToken();
  if (!token) throw Object.assign(new Error("Connect GitHub first"), { status: 409 });
  if (!await fileExists(privateKeyPath())) {
    throw Object.assign(new Error("SSH keypair missing; reconnect GitHub"), { status: 409 });
  }
  const viewer = await verifyToken(token);

  // 1. Ensure the local project is a repo with at least one commit so we have something to push.
  const steps = [];
  if (!await isRepo(projectPath)) {
    await execFileAsync("git", ["-C", projectPath, "init", "-b", "main"]);
    steps.push("git init");
  }
  await gitInProject(projectPath, ["config", "user.email", `${viewer.login}@users.noreply.github.com`]);
  await gitInProject(projectPath, ["config", "user.name", viewer.name || viewer.login]);
  if (!await gitHasAnyCommits(projectPath)) {
    await gitInProject(projectPath, ["add", "."]);
    try {
      await gitInProject(projectPath, ["commit", "-m", "Initial commit by Orch"]);
      steps.push("initial commit");
    } catch (error) {
      // Empty repo (no files at all) — create a placeholder so we have something to push.
      const msg = String(error.stderr || error.stdout || error.message || "");
      if (/nothing to commit/i.test(msg) || /no changes added/i.test(msg)) {
        await writeFile(path.join(projectPath, "README.md"), `# ${repoName}\n\nProject managed via Orch.\n`, { flag: "wx" }).catch(() => {});
        await gitInProject(projectPath, ["add", "."]);
        await gitInProject(projectPath, ["commit", "-m", "Initial commit by Orch"]);
        steps.push("initial commit");
      } else { throw error; }
    }
  }

  // 2. Create the remote private repo (idempotent: if it already exists for this user we
  // surface a 409 rather than silently reusing — the user can pick a different name).
  let repo;
  try {
    repo = await githubRequest(token, "POST", "/user/repos", {
      name: repoName,
      private: true,
      auto_init: false,
      description: description || `${projectName} (Orch)`,
    });
    steps.push(`created github.com/${repo.full_name} (private)`);
  } catch (error) {
    if (error.status === 422 && Array.isArray(error.githubErrors) && error.githubErrors.some((e) => /already exists/i.test(e.message || ""))) {
      throw Object.assign(new Error(`A repository named "${repoName}" already exists on this GitHub account`), { status: 409 });
    }
    throw error;
  }

  // 3. Wire the remote (overwrite any stale URL) and push using the SSH command we built.
  const sshRemoteUrl = `git@github.com:${repo.full_name}.git`;
  const existingRemote = await gitRemoteUrl(projectPath);
  if (!existingRemote) await gitInProject(projectPath, ["remote", "add", "origin", sshRemoteUrl]);
  else if (existingRemote !== sshRemoteUrl) await gitInProject(projectPath, ["remote", "set-url", "origin", sshRemoteUrl]);

  const branch = await gitDefaultBranch(projectPath);
  await gitInProject(projectPath, ["push", "-u", "origin", branch]);
  steps.push(`pushed ${branch} to origin`);

  return {
    project: projectName,
    repo: { owner: repo.owner?.login, name: repo.name, fullName: repo.full_name, htmlUrl: repo.html_url, sshUrl: sshRemoteUrl, private: repo.private },
    defaultBranch: branch,
    steps,
  };
}
