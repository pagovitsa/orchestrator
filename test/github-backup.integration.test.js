import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Runs the real backupProjectToGithub against a real git repo whose origin is a local bare repo, so
// the snapshot + push path is exercised end to end without SSH or network. A fresh subprocess lets us
// point ORCH_WORKSPACE_ROOT at a tmp dir (the workspace real-root is cached on first use).
test("backupProjectToGithub: 409 without a token, then snapshots and pushes to origin", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { promisify } from "node:util";
    import { execFile } from "node:child_process";
    import { pathToFileURL } from "node:url";

    const exec = promisify(execFile);
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "orch-ghbackup-ws-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "orch-ghbackup-data-"));
    const rootUrl = pathToFileURL(process.cwd() + path.sep).href;
    const originalFetch = globalThis.fetch;

    process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORCH_DATA_DIR = dataDir;

    const { ensureKeypair, saveToken, backupProjectToGithub } = await import(new URL("src/domain/github.js", rootUrl));

    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === "https://api.github.com/user") {
        return new Response(JSON.stringify({ login: "ada", id: 1, name: "Ada", html_url: "https://github.com/ada" }), { status: 200 });
      }
      if (target === "https://api.github.com/repos/ada/pub") {
        return new Response(JSON.stringify({ full_name: "ada/pub", private: false, owner: { login: "ada" } }), { status: 200 });
      }
      return new Response("", { status: 404 });
    };

    try {
      // 1. No token connected yet -> 409 before touching the workspace.
      await assert.rejects(() => backupProjectToGithub("demo"), /Connect GitHub first/);

      await ensureKeypair();
      await saveToken("ghp_ok");

      // 2. Stand up an already-published project: real repo with origin pointing at a local bare repo.
      const projectDir = path.join(workspaceRoot, "demo");
      await mkdir(projectDir, { recursive: true });
      const bareRemote = path.join(dataDir, "demo-remote.git");
      await exec("git", ["init", "--bare", "-b", "main", bareRemote]);
      await exec("git", ["-C", projectDir, "init", "-b", "main"]);
      await exec("git", ["-C", projectDir, "config", "user.email", "t@e.st"]);
      await exec("git", ["-C", projectDir, "config", "user.name", "T"]);
      await writeFile(path.join(projectDir, "README.md"), "# demo\n");
      await exec("git", ["-C", projectDir, "add", "-A"]);
      await exec("git", ["-C", projectDir, "commit", "-m", "init"]);
      await exec("git", ["-C", projectDir, "remote", "add", "origin", bareRemote]);
      await exec("git", ["-C", projectDir, "push", "-u", "origin", "main"]);

      // 3. A new uncommitted change is snapshotted, committed, and pushed.
      await writeFile(path.join(projectDir, "feature.txt"), "new work\n");
      const result = await backupProjectToGithub("demo");
      assert.equal(result.mode, "snapshot");
      assert.equal(result.steps.some((step) => /committed working tree/.test(step)), true);
      assert.equal(result.steps.some((step) => /pushed main to origin/.test(step)), true);
      const remoteLog = (await exec("git", ["-C", bareRemote, "log", "--oneline"])).stdout;
      assert.match(remoteLog, /Orch backup/);

      // 4. A second backup with no changes still succeeds and reports nothing to commit.
      const again = await backupProjectToGithub("demo");
      assert.equal(again.steps.some((step) => /no working-tree changes to commit/.test(step)), true);
      assert.equal(again.steps.some((step) => /pushed main to origin/.test(step)), true);

      // 5. Refuse to back up a project whose origin is a PUBLIC github.com repo.
      const pubDir = path.join(workspaceRoot, "pub");
      await mkdir(pubDir, { recursive: true });
      await exec("git", ["-C", pubDir, "init", "-b", "main"]);
      await exec("git", ["-C", pubDir, "config", "user.email", "t@e.st"]);
      await exec("git", ["-C", pubDir, "config", "user.name", "T"]);
      await writeFile(path.join(pubDir, "a.txt"), "x\n");
      await exec("git", ["-C", pubDir, "add", "-A"]);
      await exec("git", ["-C", pubDir, "commit", "-m", "init"]);
      await exec("git", ["-C", pubDir, "remote", "add", "origin", "git@github.com:ada/pub.git"]);
      await assert.rejects(() => backupProjectToGithub("pub"), /public repo/i);

      // 6. Refuse to back up from a detached HEAD (would otherwise push the wrong ref).
      const detDir = path.join(workspaceRoot, "det");
      await mkdir(detDir, { recursive: true });
      const detRemote = path.join(dataDir, "det-remote.git");
      await exec("git", ["init", "--bare", "-b", "main", detRemote]);
      await exec("git", ["-C", detDir, "init", "-b", "main"]);
      await exec("git", ["-C", detDir, "config", "user.email", "t@e.st"]);
      await exec("git", ["-C", detDir, "config", "user.name", "T"]);
      await writeFile(path.join(detDir, "a.txt"), "1\n");
      await exec("git", ["-C", detDir, "add", "-A"]);
      await exec("git", ["-C", detDir, "commit", "-m", "c1"]);
      await writeFile(path.join(detDir, "a.txt"), "2\n");
      await exec("git", ["-C", detDir, "commit", "-am", "c2"]);
      await exec("git", ["-C", detDir, "remote", "add", "origin", detRemote]);
      await exec("git", ["-C", detDir, "checkout", "--detach", "HEAD~1"]);
      await assert.rejects(() => backupProjectToGithub("det"), /detached HEAD/i);

      console.log(JSON.stringify({ ok: true }));
    } finally {
      globalThis.fetch = originalFetch;
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 15000,
  });
  assert.deepEqual(JSON.parse(stdout), { ok: true });
});
