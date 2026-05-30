import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safeUploadName, isTextAttachment, saveAttachments } from "../src/domain/attachments.js";
import {
  appendAutopilotHistory,
  autopilotFeedLimit,
  autopilotMemoryArgs,
  autopilotNeedsDecision,
  clearAutopilotHistory,
  consecutiveAutopilotRunFailures,
  decideAutopilotNext,
  decideAutopilotNextWithRetry,
  isAutopilotIdleTimeoutMessage,
  isRetriableAutopilotError,
  normalizeAutopilotRetryConfig,
  summarizeAutopilotFeed,
} from "../src/domain/autopilot.js";
import { normalizeHookEvent } from "../src/domain/hooks.js";
import {
  normalizeWorkflowStatus,
  transitionWorkflowStatus,
  workflowCanRun,
  workflowStateLabel,
} from "../src/domain/workflow-state.js";
import { paths, runtime } from "../src/config/env.js";
import {
  extractUserMemoriesFromText,
  normalizeMemoryNamespace,
  readMemory,
  rememberMemory,
} from "../src/domain/memory.js";
import { createTimelineEvent, mergeTimelineEvent } from "../src/domain/run-timeline.js";
import { applySessionPatch, clearStaleAutopilotRuns, createSession, loadSession, projectLabel, rememberPathForCwd, saveSession } from "../src/domain/sessions.js";
import { containsSensitiveText, redactSensitiveStrings, redactSensitiveText } from "../src/domain/safety.js";
import { idleTimeoutDecision, normalizeIdleTimeoutConfig } from "../src/domain/idle-timeout.js";
import { mcpToolCatalog, writeScopedPeerConfigs } from "../src/supervisors/mcp.js";
import { formatMemoryContext } from "../src/supervisors/runner.js";
import {
  calculateBalanceUsage,
  clearStaleActiveRuns,
  listUsage,
  parseClaudeUsagePayload,
  parseCodexRateLimitPayload,
  parseGeminiQuotaPayload,
  parseUsageProbeOutput,
  recordRunEnd,
  recordRunStart,
  recordUsageSignal,
  usageSnapshot,
} from "../src/domain/usage.js";
import { normalizeProjectName } from "../src/domain/workspace.js";
import {
  ensureKeypair,
  githubConnectionStatus,
  githubSupervisorEnvSync,
  projectGithubStatus,
  publishProjectToGithub,
  readToken,
  saveToken,
  clearGithubConnection,
  verifyToken,
} from "../src/domain/github.js";

test("normalizeProjectName accepts a single folder name", () => {
  assert.equal(normalizeProjectName("  my project  "), "my project");
});

test("normalizeProjectName rejects traversal and hidden folders", () => {
  assert.throws(() => normalizeProjectName("../secret"), /single folder/);
  assert.throws(() => normalizeProjectName(".hidden"), /single folder/);
  assert.throws(() => normalizeProjectName(""), /required/);
});

test("safeUploadName keeps uploads inside a flat safe name", () => {
  assert.equal(safeUploadName("../../Receipt ?.pdf"), "Receipt _.pdf");
  assert.equal(safeUploadName(""), "attachment");
});

test("isTextAttachment recognizes common source formats", () => {
  assert.equal(isTextAttachment("server.js", ""), true);
  assert.equal(isTextAttachment("image.png", "image/png"), false);
  assert.equal(isTextAttachment("notes.bin", "text/plain"), true);
});

test("applySessionPatch keeps supervisor and workspace fixed when locked", () => {
  const session = { title: "Chat", supervisor: "claude", cwd: "demo", messages: [] };

  assert.throws(
    () => applySessionPatch(session, { supervisor: "codex" }, { allowIdentityChange: false }),
    /supervisor is fixed/,
  );
  assert.throws(
    () => applySessionPatch(session, { cwd: "other" }, { allowIdentityChange: false }),
    /workspace is fixed/,
  );

  applySessionPatch(session, { title: "Renamed" }, { allowIdentityChange: false });
  assert.equal(session.title, "demo");
});

test("projectLabel returns project-oriented history labels", () => {
  assert.equal(projectLabel("test"), "test");
  assert.equal(projectLabel("."), "workspace");
});

test("saveSession treats incoming messages as authoritative", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "orchestrator", ".tmp-sessions-"));
  try {
    paths.workspaceRoot = dir;
    await mkdir(path.join(dir, "project-a"), { recursive: true });
    const session = {
      id: "11111111-1111-4111-8111-111111111111",
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        { role: "user", content: "keep", at: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", content: "delete me", at: "2026-01-01T00:00:01.000Z" },
      ],
    };

    await saveSession(session);
    session.messages = [session.messages[0]];
    await saveSession(session);

    const loaded = await loadSession(session.id);
    assert.deepEqual(loaded.messages.map((message) => message.content), ["keep"]);
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSession serializes concurrent creates for the same project to a single id", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "orchestrator", ".tmp-sessions-"));
  try {
    paths.workspaceRoot = dir;
    await mkdir(path.join(dir, "project-a"), { recursive: true });
    const [first, second, third] = await Promise.all([
      createSession({ supervisor: "codex", cwd: "project-a" }),
      createSession({ supervisor: "codex", cwd: "project-a" }),
      createSession({ supervisor: "codex", cwd: "project-a" }),
    ]);
    assert.equal(first.id, second.id);
    assert.equal(second.id, third.id);
    const loaded = await loadSession(first.id);
    assert.equal(loaded.id, first.id);
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSession shares a lock across cwd aliases that resolve to the same project", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "orchestrator", ".tmp-sessions-"));
  try {
    paths.workspaceRoot = dir;
    await mkdir(path.join(dir, "project-a"), { recursive: true });
    const [first, second] = await Promise.all([
      createSession({ supervisor: "codex", cwd: "project-a" }),
      createSession({ supervisor: "codex", cwd: "./project-a" }),
    ]);
    assert.equal(first.id, second.id);
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSession refuses partial session objects without messages", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "orchestrator", ".tmp-sessions-"));
  try {
    paths.workspaceRoot = dir;
    await mkdir(path.join(dir, "project-a"), { recursive: true });
    await assert.rejects(
      () => saveSession({
        id: "33333333-3333-4333-8333-333333333333",
        supervisor: "codex",
        cwd: "project-a",
      }),
      /session\.messages must be an array/,
    );
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSession writes remember files atomically", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "orchestrator", ".tmp-sessions-"));
  try {
    paths.workspaceRoot = dir;
    await mkdir(path.join(dir, "project-a"), { recursive: true });
    const session = {
      id: "22222222-2222-4222-8222-222222222222",
      supervisor: "codex",
      cwd: "project-a",
      messages: [{ role: "user", content: "atomic", at: "2026-01-01T00:00:00.000Z" }],
    };

    await saveSession(session);

    const filePath = rememberPathForCwd(session.cwd);
    const files = await readdir(path.dirname(filePath));
    assert.ok(files.includes(path.basename(filePath)));
    assert.equal(files.some((file) => file.startsWith(`${path.basename(filePath)}.`) && file.endsWith(".tmp")), false);
    const loaded = await loadSession(session.id);
    assert.deepEqual(loaded.messages.map((message) => message.content), ["atomic"]);
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory keeps user facts global across project files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-memory-"));
  try {
    const globalFile = path.join(dir, "user.json");
    const projectA = path.join(dir, "a", "orchestrator-memory.json");
    const projectB = path.join(dir, "b", "orchestrator-memory.json");

    await rememberMemory({ globalFile, projectFile: projectA }, {
      scope: "user",
      kind: "fact",
      namespace: "profile",
      text: "The user's name is Kostas",
      tags: ["identity", "name"],
    });
    await rememberMemory({ globalFile, projectFile: projectA }, {
      scope: "project",
      kind: "decision",
      text: "Use SQLite for the prototype",
    });

    const projectBMemory = await readMemory({ globalFile, projectFile: projectB }, { scope: "all" });
    assert.equal(projectBMemory.user.memories[0].text, "The user's name is Kostas");
    assert.equal(projectBMemory.user.memories[0].namespace, "profile");
    assert.deepEqual(projectBMemory.user.memories[0].tags, ["identity", "name"]);
    assert.equal(projectBMemory.project.memories.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory writes recover from a stale steal-lock left by a crashed stealer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-memory-"));
  try {
    const files = {
      globalFile: path.join(dir, "user.json"),
      projectFile: path.join(dir, "project.json"),
    };
    await mkdir(path.dirname(files.projectFile), { recursive: true });
    const lockPath = `${files.projectFile}.lock`;
    const stealPath = `${lockPath}.steal`;
    let deadPid = 999999;
    for (let candidate = 999999; candidate > 1000; candidate -= 1) {
      try { process.kill(candidate, 0); } catch (error) {
        if (error.code === "ESRCH") { deadPid = candidate; break; }
      }
    }
    // Both the main lock AND the steal lock are stale (crashed stealer scenario). Without the
    // .steal recovery path, acquireFileLock would spin until the 10s outer timeout.
    await writeFile(lockPath, String(deadPid), "utf8");
    await writeFile(stealPath, String(deadPid), "utf8");
    const { utimes } = await import("node:fs/promises");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    await utimes(stealPath, old, old);

    const started = Date.now();
    await rememberMemory(files, { scope: "project", kind: "fact", text: "we use redis" });
    assert.ok(Date.now() - started < 5_000, `stale .steal recovery took too long: ${Date.now() - started}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory writes recover from a stale lock left by a dead process", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-memory-"));
  try {
    const files = {
      globalFile: path.join(dir, "user.json"),
      projectFile: path.join(dir, "project.json"),
    };
    // Simulate a crashed prior writer: drop a lock file naming a PID we can confirm is dead.
    await mkdir(path.dirname(files.projectFile), { recursive: true });
    const lockPath = `${files.projectFile}.lock`;
    let deadPid = 999999;
    for (let candidate = 999999; candidate > 1000; candidate -= 1) {
      try { process.kill(candidate, 0); } catch (error) {
        if (error.code === "ESRCH") { deadPid = candidate; break; }
      }
    }
    await writeFile(lockPath, String(deadPid), "utf8");
    const oldTime = new Date(Date.now() - 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(lockPath, oldTime, oldTime);

    // Write should steal the stale lock and succeed within the normal timeout, not hang/retry forever.
    const started = Date.now();
    await rememberMemory(files, {
      scope: "project",
      kind: "fact",
      text: "we use postgres for production",
    });
    assert.ok(Date.now() - started < 5_000, `recovery took too long: ${Date.now() - started}ms`);

    const memory = await readMemory(files, { scope: "project" });
    assert.equal(memory.project.memories[0].text, "we use postgres for production");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory namespaces filter durable project knowledge", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-memory-"));
  try {
    const files = {
      globalFile: path.join(dir, "user.json"),
      projectFile: path.join(dir, "project.json"),
    };
    await rememberMemory(files, {
      scope: "project",
      kind: "decision",
      namespace: "solutions",
      text: "Use lazy terminal details for long traces",
    });
    await rememberMemory(files, {
      scope: "project",
      kind: "note",
      namespace: "feedback",
      text: "The user prefers compact status cards",
    });

    const solutions = await readMemory(files, { scope: "project", namespace: "solutions" });
    assert.equal(solutions.project.memories.length, 1);
    assert.equal(solutions.project.memories[0].namespace, "solutions");

    const profileDefault = normalizeMemoryNamespace("", "fact", "user");
    assert.equal(profileDefault, "profile");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory refuses to store secret-like text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-memory-"));
  try {
    const files = {
      globalFile: path.join(dir, "user.json"),
      projectFile: path.join(dir, "project.json"),
    };
    await assert.rejects(
      () => rememberMemory(files, { scope: "user", text: "My api key is sk-secret" }),
      /Refusing to store secrets/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("safety scanner detects and redacts credential-shaped text", () => {
  const input = "Authorization: Bearer abcdefghijklmnop\napi_key = sk-secret123456";

  assert.equal(containsSensitiveText(input), true);
  assert.equal(containsSensitiveText("The key is simply to wait"), false);
  const redacted = redactSensitiveText(input);
  assert.match(redacted, /Authorization: \[redacted\]/);
  assert.match(redactSensitiveText("Authorization: Basic dXNlcjpwYXNzMTIz"), /Authorization: (Basic )?\[redacted\]/);
  assert.match(redacted, /api_key = \[redacted\]/);
  assert.doesNotMatch(redacted, /abcdefghijklmnop/);
  assert.doesNotMatch(redacted, /sk-secret123456/);
});

test("safety scanner redacts sensitive object keys", () => {
  assert.deepEqual(redactSensitiveStrings({
    model: "deepseek-v4-pro",
    password: "super-secret-value",
    nested: { apiToken: "abcdef123456" },
  }), {
    model: "deepseek-v4-pro",
    password: "[redacted]",
    nested: { apiToken: "[redacted]" },
  });
});

test("saveSession redacts secrets before persistence", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "orchestrator", ".tmp-sessions-"));
  try {
    paths.workspaceRoot = dir;
    await mkdir(path.join(dir, "project-a"), { recursive: true });
    const session = {
      id: "44444444-4444-4444-8444-444444444444",
      supervisor: "codex",
      cwd: "project-a",
      messages: [{ role: "user", content: "token: sk-secret123456", at: "2026-01-01T00:00:00.000Z" }],
    };

    await saveSession(session);
    const loaded = await loadSession(session.id);
    assert.equal(loaded.messages[0].content, "token: [redacted]");
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveAttachments refuses text files with secrets before writing", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "orchestrator", ".tmp-attachments-"));
  try {
    paths.workspaceRoot = dir;
    await mkdir(path.join(dir, "project-a"), { recursive: true });
    await assert.rejects(
      () => saveAttachments(
        { id: "55555555-5555-4555-8555-555555555555", cwd: "project-a" },
        [{
          name: ".env",
          type: "text/plain",
          dataBase64: Buffer.from("DEEPSEEK_API_KEY=sk-secret123456").toString("base64"),
        }],
      ),
      /Refusing to store attachment/,
    );
    assert.deepEqual(await readdir(path.join(dir, "project-a", ".orch-ui", "uploads", "55555555-5555-4555-8555-555555555555")).catch(() => []), []);
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveAttachments accepts placeholder config while redacting inline preview", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "orchestrator", ".tmp-attachments-"));
  try {
    paths.workspaceRoot = dir;
    await mkdir(path.join(dir, "project-a"), { recursive: true });
    const [attachment] = await saveAttachments(
      { id: "66666666-6666-4666-8666-666666666666", cwd: "project-a" },
      [{
        name: ".env.example",
        type: "text/plain",
        dataBase64: Buffer.from("API_KEY=your_api_key_here").toString("base64"),
      }],
    );

    assert.equal(attachment.name, ".env.example");
    assert.equal(attachment.inlineText, "API_KEY=[redacted]");
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveAttachments respects inline attachment character budget", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const originalInlineChars = runtime.maxInlineAttachmentChars;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "orchestrator", ".tmp-attachments-"));
  try {
    paths.workspaceRoot = dir;
    runtime.maxInlineAttachmentChars = 5;
    await mkdir(path.join(dir, "project-a"), { recursive: true });
    const attachments = await saveAttachments(
      { id: "77777777-7777-4777-8777-777777777777", cwd: "project-a" },
      [
        {
          name: "first.txt",
          type: "text/plain",
          dataBase64: Buffer.from("abcdef").toString("base64"),
        },
        {
          name: "second.txt",
          type: "text/plain",
          dataBase64: Buffer.from("ghijkl").toString("base64"),
        },
      ],
    );

    assert.equal(attachments[0].inlineText, "abcde");
    assert.equal(attachments[0].inlineTruncated, true);
    assert.equal(attachments[1].inlineText, undefined);
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    runtime.maxInlineAttachmentChars = originalInlineChars;
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory extracts a stated user name for global recall", () => {
  const memories = extractUserMemoriesFromText("hey, my name is KOstas and I like dark mode");

  assert.equal(memories.length, 1);
  assert.equal(memories[0].scope, "user");
  assert.equal(memories[0].namespace, "profile");
  assert.equal(memories[0].text, "The user's name is KOstas");
  assert.deepEqual(memories[0].tags, ["identity", "name"]);
});

test("run timeline events merge updates by id", () => {
  const timeline = mergeTimelineEvent([], {
    id: "cmd-1",
    kind: "command",
    status: "running",
    title: "npm test",
    detail: "[cwd] /workspace/app",
  });
  const merged = mergeTimelineEvent(timeline, {
    id: "cmd-1",
    kind: "command",
    status: "completed",
    title: "npm test",
    durationMs: 1234,
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "completed");
  assert.equal(merged[0].detail, "[cwd] /workspace/app");
  assert.equal(merged[0].durationMs, 1234);
});

test("run timeline event meta is redacted before storage", () => {
  const event = createTimelineEvent({
    id: "tool-1",
    kind: "tool",
    status: "completed",
    title: "tool",
    detail: "Authorization: Bearer abcdefghijklmnop",
    meta: {
      model: "deepseek-v4-pro",
      authorization: "Bearer sk-secret-token-123456",
      nested: { password: "super-secret-value" },
    },
  });

  assert.equal(event.meta.model, "deepseek-v4-pro");
  assert.equal(event.meta.authorization, "[redacted]");
  assert.equal(event.meta.nested.password, "[redacted]");
  assert.match(event.detail, /Authorization: \[redacted\]/);
  assert.doesNotMatch(event.detail, /abcdefghijklmnop/);
});

test("formatMemoryContext injects namespaced memories for supervisors", () => {
  const text = formatMemoryContext({
    user: {
      summary: "Prefers concise answers",
      memories: [{ namespace: "profile", kind: "fact", text: "The user's name is Kostas", tags: ["identity"] }],
    },
    project: {
      memories: [{ namespace: "solutions", kind: "decision", text: "Use run timeline cards" }],
    },
  });

  assert.match(text, /DURABLE MEMORY/);
  assert.match(text, /user\/profile\/fact/);
  assert.match(text, /project\/solutions\/decision/);
});

test("mcpToolCatalog groups peers and shared tools", () => {
  const catalog = mcpToolCatalog("claude");
  assert.ok(catalog.some((tool) => tool.group === "peer-model" && tool.name === "pal-codex"));
  assert.ok(catalog.some((tool) => tool.group === "memory" && tool.name === "memory"));
  assert.ok(catalog.some((tool) => tool.group === "browser" && tool.name === "playwright"));
});

test("writeScopedPeerConfigs can attach shared tools without recursive peers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-mcp-shared-"));
  const original = {
    dataDir: paths.dataDir,
    homeDir: paths.homeDir,
    mcpConfigDir: paths.mcpConfigDir,
    enabledTools: runtime.enabledTools,
  };
  const projectName = `project-shared-tools-${path.basename(dir)}`;
  try {
    paths.dataDir = path.join(dir, "data");
    paths.homeDir = path.join(dir, "home");
    paths.mcpConfigDir = path.join(dir, "mcp");
    runtime.enabledTools = ["memory", "playwright"];

    await mkdir(path.join(paths.workspaceRoot, projectName), { recursive: true });
    const scoped = await writeScopedPeerConfigs(
      { id: "session-shared-tools", supervisor: "codex", cwd: projectName },
      { includePeerServers: false },
    );
    const claudeConfig = JSON.parse(await readFile(scoped.claudeConfigPath, "utf8"));
    const serverNames = Object.keys(claudeConfig.mcpServers).sort();

    assert.deepEqual(serverNames, ["memory", "playwright"]);
    assert.equal(claudeConfig.mcpServers.playwright.command, "playwright-mcp");
    assert.equal(serverNames.some((name) => name.startsWith("pal-")), false);
  } finally {
    paths.dataDir = original.dataDir;
    paths.homeDir = original.homeDir;
    paths.mcpConfigDir = original.mcpConfigDir;
    runtime.enabledTools = original.enabledTools;
    await rm(path.join(paths.workspaceRoot, projectName), { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("autopilot history and memory args are bounded", () => {
  const session = {};
  for (let index = 0; index < 55; index += 1) {
    appendAutopilotHistory(session, {
      action: "message",
      kind: "continue",
      reason: `next ${index}`,
      content: "continue carefully",
    });
  }

  assert.equal(session.autopilotHistory.length, 50);
  assert.equal(session.autopilotHistory.at(-1).reason, "next 54");
  appendAutopilotHistory(session, { action: "stop", kind: "stop", reason: "token=secret-value", content: "password=secret value should not persist" });
  assert.match(session.autopilotHistory.at(-1).reason, /\[redacted\]/i);
  assert.match(session.autopilotHistory.at(-1).content, /\[redacted\]/i);
  const memory = autopilotMemoryArgs({ action: "message", kind: "continue", reason: "phase done token=secret-value" });
  assert.equal(memory.namespace, "autopilot");
  assert.deepEqual(memory.tags, ["autopilot", "continue"]);
  assert.match(memory.text, /\[redacted\]/i);
});

test("autopilot feed summaries are configurable, bounded, and redacted", () => {
  const feed = summarizeAutopilotFeed([
    { at: "2026-05-27T10:00:00.000Z", action: "message", kind: "continue", reason: "first", content: "hidden" },
    { at: "2026-05-27T10:01:00.000Z", action: "stop", kind: "stop", reason: "password=secret value should not leak" },
    { at: "2026-05-27T10:02:00.000Z", action: "message", kind: "answer", reason: "x".repeat(120) },
  ], { limit: 3 });

  assert.equal(feed.length, 3);
  assert.equal(feed[0].kind, "answer");
  assert.equal(feed[0].reason.length, 80);
  assert.equal(feed[0].content, undefined);
  assert.match(feed[1].reason, /\[redacted\]/i);
  assert.equal(summarizeAutopilotFeed(feed, { limit: 0 }).length, 0);
  assert.equal(autopilotFeedLimit(99), 10);
  assert.equal(autopilotFeedLimit(-1), 0);
  assert.deepEqual(summarizeAutopilotFeed(null), []);
});

test("clearAutopilotHistory removes persisted feed source", () => {
  const session = { autopilotHistory: [{ reason: "done" }], autopilotFeed: [{ reason: "done" }] };
  clearAutopilotHistory(session);
  assert.deepEqual(session.autopilotHistory, []);
  assert.deepEqual(session.autopilotFeed, []);
});

test("autopilot workflow state normalizes and gates runnable states", () => {
  const created = normalizeWorkflowStatus({ state: "CREATED" });
  assert.equal(created.state, "created");
  assert.equal(workflowCanRun(created, true), true);
  assert.equal(workflowCanRun({ state: "paused" }, true), false);
  assert.equal(workflowCanRun({ state: "completed" }, true), true);
  assert.equal(workflowStateLabel({ state: "completed" }), "ready");
});

test("autopilot workflow state enforces allowed transitions", () => {
  const running = transitionWorkflowStatus({ state: "created" }, "running", "deciding");
  assert.equal(running.state, "running");
  assert.equal(running.reason, "deciding");
  assert.equal(transitionWorkflowStatus(running, "created", "retry").state, "created");
  assert.equal(transitionWorkflowStatus(running, "completed").state, "completed");
  assert.equal(transitionWorkflowStatus({ state: "created" }, "completed").state, "completed");
  assert.equal(transitionWorkflowStatus({ state: "created" }, "failed").state, "failed");
  assert.throws(
    () => transitionWorkflowStatus({ state: "paused" }, "completed"),
    /Invalid workflow transition/,
  );
});

test("autopilot idle timeout warns then stops only autopilot-sourced runs", () => {
  const config = normalizeIdleTimeoutConfig({ timeoutMs: 1000, warningMs: 300 });
  const base = { source: "autopilot", lastActivityMs: 1000 };
  const shortDecisionConfig = normalizeIdleTimeoutConfig({ timeoutMs: 30, warningMs: 60 });

  assert.deepEqual(idleTimeoutDecision({ source: "manual", lastActivityMs: 1000 }, 5000, config), { action: "none" });
  assert.equal(idleTimeoutDecision(base, 1600, config).action, "none");
  const warning = idleTimeoutDecision(base, 1700, config);
  assert.equal(warning.action, "warn");
  assert.equal(warning.remainingMs, 300);
  assert.deepEqual(shortDecisionConfig, { timeoutMs: 30, warningMs: 29 });
  assert.equal(idleTimeoutDecision({ ...base, idleWarningSent: true }, 1800, config).action, "none");
  assert.equal(idleTimeoutDecision(base, 2000, config).action, "stop");
});

test("applySessionPatch updates persisted autopilot workflow state", () => {
  const session = {
    id: "77777777-7777-4777-8777-777777777777",
    supervisor: "codex",
    cwd: "project-a",
    messages: [],
    autopilotEnabled: false,
    autopilotState: { state: "paused" },
  };

  applySessionPatch(session, { autopilotEnabled: true }, { allowIdentityChange: false });
  assert.equal(session.autopilotEnabled, true);
  assert.equal(session.autopilotState.state, "created");
  assert.equal(workflowCanRun(session.autopilotState, session.autopilotEnabled), true);

  applySessionPatch(session, { autopilotEnabled: false }, { allowIdentityChange: false });
  assert.equal(session.autopilotEnabled, false);
  assert.equal(session.autopilotState.state, "paused");
});

test("clearStaleAutopilotRuns persists restart cleanup for running workflow state", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "orchestrator", ".tmp-sessions-"));
  try {
    paths.workspaceRoot = dir;
    await mkdir(path.join(dir, "project-a"), { recursive: true });
    const session = {
      id: "99999999-9999-4999-8999-999999999999",
      schemaVersion: 1,
      title: "project-a",
      project: "project-a",
      supervisor: "codex",
      cwd: "project-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messages: [
        {
          role: "user",
          at: "2026-01-01T00:01:00.000Z",
          content: "Autopilot:\nRun the next check.",
        },
      ],
      autopilotEnabled: true,
      autopilotState: { state: "running", reason: "deciding" },
    };
    await mkdir(path.dirname(rememberPathForCwd("project-a")), { recursive: true });
    await writeFile(rememberPathForCwd("project-a"), JSON.stringify(session), "utf8");

    const cleared = await clearStaleAutopilotRuns("restart cleanup");
    const loaded = await loadSession(session.id);

    assert.deepEqual(cleared, ["project-a"]);
    assert.equal(loaded.autopilotEnabled, true);
    assert.equal(loaded.autopilotState.state, "created");
    assert.equal(loaded.autopilotState.reason, "restart cleanup");
    assert.equal(loaded.messages.at(-1).role, "assistant");
    assert.equal(loaded.messages.at(-1).stopped, true);
    assert.match(loaded.messages.at(-1).content, /interrupted before returning a final answer/i);
    assert.equal(autopilotNeedsDecision(loaded), true);
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSession preserves running state for startup cleanup", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "orchestrator", ".tmp-sessions-"));
  try {
    paths.workspaceRoot = dir;
    await mkdir(path.join(dir, "project-a"), { recursive: true });
    const session = {
      id: "88888888-8888-4888-8888-888888888888",
      supervisor: "codex",
      cwd: "project-a",
      messages: [],
      autopilotEnabled: true,
      autopilotState: { state: "running" },
    };

    await saveSession(session);
    const loaded = await loadSession(session.id);
    assert.equal(loaded.autopilotEnabled, true);
    assert.equal(loaded.autopilotState.state, "running");
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("hook events are normalized for best-effort logging", () => {
  const event = normalizeHookEvent({
    type: "run.start",
    sessionId: "abc",
    project: "demo",
    supervisor: "codex",
    status: "running",
    detail: "x".repeat(2000),
  });

  assert.equal(event.type, "run.start");
  assert.equal(event.detail.length, 1200);
});

test("parseUsageProbeOutput extracts numeric status without secrets", () => {
  const parsed = parseUsageProbeOutput(
    "Current session usage: 32%\nWeekly limit usage: 73%\nTokens used: 12,345\nAuthorization: Bearer secret-token",
  );

  assert.equal(parsed.percent, 73);
  assert.equal(parsed.currentPercent, 32);
  assert.equal(parsed.weeklyPercent, 73);
  assert.equal(parsed.tokens, 12345);
  assert.match(parsed.output, /Authorization: \.\.\.redacted/);
  assert.doesNotMatch(parsed.output, /secret-token/);
});

test("parseUsageProbeOutput keeps missing percentages unknown", () => {
  const parsed = parseUsageProbeOutput("Signed in with Google /auth\nPlan: Pro");

  assert.equal(parsed.percent, null);
  assert.equal(parsed.currentPercent, null);
  assert.equal(parsed.weeklyPercent, null);
});

test("parseUsageProbeOutput treats remaining percentages as spent usage", () => {
  const parsed = parseUsageProbeOutput("Current remaining: 68%\nWeekly limit left: 27%");

  assert.equal(parsed.percent, 73);
  assert.equal(parsed.currentPercent, 32);
  assert.equal(parsed.weeklyPercent, 73);
});

test("calculateBalanceUsage tracks DeepSeek spent from observed balance", () => {
  assert.deepEqual(calculateBalanceUsage(null, "17.55"), {
    observedMax: 17.55,
    remaining: 17.55,
    spent: 0,
    usagePercent: 0,
  });

  const spent = calculateBalanceUsage(20, "17.55");
  assert.equal(spent.observedMax, 20);
  assert.equal(spent.remaining, 17.55);
  assert.equal(Math.round(spent.spent * 100) / 100, 2.45);
  assert.equal(spent.usagePercent, 12);

  assert.deepEqual(calculateBalanceUsage(20, "25.00"), {
    observedMax: 25,
    remaining: 25,
    spent: 0,
    usagePercent: 0,
  });
});

async function withUsageDataDir(fn) {
  const originalDataDir = paths.dataDir;
  const originalBudgetWarningUsd = runtime.budgetWarningUsd;
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-usage-"));
  try {
    paths.dataDir = dir;
    runtime.budgetWarningUsd = 0;
    return await fn(dir);
  } finally {
    paths.dataDir = originalDataDir;
    runtime.budgetWarningUsd = originalBudgetWarningUsd;
    await rm(dir, { recursive: true, force: true });
  }
}

test("recordUsageSignal accumulates per-run token and cost deltas once", async () => {
  await withUsageDataDir(async () => {
    await recordRunStart("deepseek");
    await recordUsageSignal("deepseek", { tokens: 1000 });
    await recordUsageSignal("deepseek", { tokens: 1500 });
    await recordUsageSignal("deepseek", { tokens: 1500 });
    await recordRunEnd("deepseek");
    await recordUsageSignal("deepseek", { tokens: 2000 });

    await recordRunStart("deepseek");
    await recordUsageSignal("deepseek", { tokens: 200 });

    await recordRunStart("claude");
    await recordUsageSignal("claude", { costUsd: 0.05 });
    await recordUsageSignal("claude", { costUsd: 0.05 });
    await recordRunEnd("claude");
    await recordRunStart("claude");
    await recordUsageSignal("claude", { costUsd: 0.02 });

    const usage = await listUsage();
    const deepseek = usage.find((item) => item.id === "deepseek");
    const claude = usage.find((item) => item.id === "claude");

    assert.equal(deepseek.totalTokens, 1700);
    assert.equal(deepseek.tokensToday, 1700);
    assert.equal(Math.round(claude.totalCostUsd * 100), 7);
    assert.equal(Math.round(claude.costTodayUsd * 100), 7);
  });
});

test("usageSnapshot reports aggregate budget warnings", async () => {
  await withUsageDataDir(async () => {
    runtime.budgetWarningUsd = 0.1;
    await recordRunStart("claude");
    await recordUsageSignal("claude", { costUsd: 0.08 });

    let snapshot = await usageSnapshot();
    assert.equal(snapshot.budget.warning, false);
    assert.equal(Math.round(snapshot.budget.totalCostUsd * 100), 8);

    await recordRunEnd("claude");
    await recordRunStart("claude");
    await recordUsageSignal("claude", { costUsd: 0.03 });
    snapshot = await usageSnapshot();

    assert.equal(snapshot.budget.warning, true);
    assert.equal(Math.round(snapshot.budget.totalCostUsd * 100), 11);
    assert.equal(snapshot.usage.find((item) => item.id === "claude").budgetWarning, true);
  });
});

test("readStore recovers from a corrupt usage.json instead of throwing", async () => {
  await withUsageDataDir(async (dir) => {
    await writeFile(path.join(dir, "usage.json"), "{not valid json", "utf8");
    await recordRunStart("codex");
    const usage = await listUsage();
    const codex = usage.find((item) => item.id === "codex");
    assert.equal(codex.active, true);
    const persisted = JSON.parse(await readFile(path.join(dir, "usage.json"), "utf8"));
    assert.equal(persisted.schemaVersion, 1);
  });
});

test("writeStore + Gemini token writes never leave a temp file behind on success", async () => {
  await withUsageDataDir(async (dir) => {
    await recordRunStart("claude");
    await recordRunEnd("claude");
    const entries = await readdir(dir);
    const stragglers = entries.filter((name) => name.includes(".tmp"));
    assert.deepEqual(stragglers, [], `unexpected temp files: ${stragglers.join(", ")}`);
  });
});

test("clearStaleActiveRuns resets persisted active usage after restart", async () => {
  await withUsageDataDir(async () => {
    await recordRunStart("codex");

    let usage = await listUsage();
    assert.equal(usage.find((item) => item.id === "codex").active, true);

    const changed = await clearStaleActiveRuns("restart cleanup");
    usage = await listUsage();
    const codex = usage.find((item) => item.id === "codex");

    assert.equal(changed, true);
    assert.equal(codex.active, false);
    assert.equal(codex.lastError, "restart cleanup");
  });
});

test("parseCodexRateLimitPayload uses the highest real Codex limit window", () => {
  const parsed = parseCodexRateLimitPayload({
    rateLimits: {
      limitId: "codex",
      planType: "pro",
      primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1779882800 },
      secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1780178031 },
    },
  });

  assert.equal(parsed.percent, 12);
  assert.equal(parsed.currentPercent, 6);
  assert.equal(parsed.weeklyPercent, 12);
  assert.match(parsed.label, /Codex rate limits/);
  assert.match(parsed.label, /plan pro/);
});

test("parseClaudeUsagePayload reads Claude Code OAuth usage windows", () => {
  const parsed = parseClaudeUsagePayload({
    five_hour: { utilization: 14, resets_at: "2026-05-27T11:50:00.587591+00:00" },
    seven_day: { utilization: 100, resets_at: "2026-05-27T22:00:00.587612+00:00" },
    seven_day_sonnet: { utilization: 21, resets_at: "2026-05-27T22:00:00.587621+00:00" },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 2000,
      used_credits: 0,
      currency: "EUR",
    },
  });

  assert.equal(parsed.percent, 100);
  assert.equal(parsed.currentPercent, 14);
  assert.equal(parsed.weeklyPercent, 100);
  assert.equal(parsed.sonnetWeeklyPercent, 21);
  assert.match(parsed.label, /Claude usage/);
  assert.match(parsed.output, /5h 14%/);
  assert.match(parsed.output, /7d 100%/);
  assert.match(parsed.output, /sonnet 21%/);
  assert.match(parsed.output, /usage credits EUR 0\/2000/);
});

test("parseGeminiQuotaPayload converts Gemini remaining fractions to used percent", () => {
  const parsed = parseGeminiQuotaPayload({
    buckets: [
      { modelId: "gemini-2.5-pro", remainingFraction: 0.9266667, resetTime: "2026-05-27T20:50:02Z" },
      { modelId: "gemini-3-flash-preview", remainingFraction: 0.655, resetTime: "2026-05-27T09:16:34Z" },
    ],
  }, {
    paidTier: { name: "Gemini Code Assist in Google One AI Pro" },
  });

  assert.equal(parsed.percent, 35);
  assert.equal(parsed.currentPercent, 35);
  assert.equal(parsed.weeklyPercent, null);
  assert.match(parsed.label, /Gemini quota/);
  assert.match(parsed.label, /Gemini Code Assist in Google One AI Pro/);
});

test("decideAutopilotNext makes no network call and hands the next step to the supervisor", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  runtime.deepseekApiKey = "test-deepseek-key";
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model to decide the next step");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "claude",
      cwd: "billing-ui",
      messages: [
        { role: "user", content: "Focus on the invoice edge case." },
        { role: "assistant", supervisor: "claude", content: "I changed the invoice totals." },
        { role: "user", content: "Also keep the mobile layout stable." },
        { role: "assistant", supervisor: "claude", modelContent: "Done; tests pass and layout is stable." },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.content, /Review the latest result, repo state, and any existing plan/i);
    assert.match(decision.content, /identify or update the plan first/i);
    assert.match(decision.content, /verification/i);
    assert.match(decision.reason, /supervisor chooses/i);
  } finally {
    runtime.deepseekApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext recovers from idle timeout markers", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  runtime.deepseekApiKey = "test-deepseek-key";
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model to recover from an idle timeout");
  };

  try {
    const timeoutMessage = {
      role: "assistant",
      supervisor: "codex",
      content: "Autopilot idle timeout",
      stopped: true,
    };
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        { role: "assistant", supervisor: "codex", content: "The Docker gate is still running; next check the failing db test." },
        timeoutMessage,
      ],
    });

    // The idle-timeout marker is a watchdog abort, not a terminal error: autopilot keeps the
    // session alive and judges the last real assistant turn (the Docker gate) instead.
    assert.equal(fetchCalled, false);
    assert.equal(isAutopilotIdleTimeoutMessage(timeoutMessage), true);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.reason, /supervisor chooses/i);
    assert.match(decision.content, /Docker is available inside the orch-ui supervisor container/);
    assert.match(decision.content, /docker version/);
  } finally {
    runtime.deepseekApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext takes the next listed phase when the assistant says work is done", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model to pick the next listed phase");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        {
          role: "assistant",
          supervisor: "codex",
          content: [
            "Phase F is done and committed.",
            "",
            "Remaining useful next phases:",
            "- `F2` - settings version-downgrade guard.",
            "- `F3` - fsync + single-instance lock on the settings store.",
          ].join("\n"),
        },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.reason, /supervisor chooses/i);
    assert.match(decision.content, /Continue with the next stage of the current plan/i);
    assert.match(decision.content, /F2 - settings version-downgrade guard/);
    assert.match(decision.content, /targeted verification/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext does not invent edits for verification-only remaining work", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model for a verification-only continuation");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "framework",
      messages: [
        {
          role: "user",
          content: "Build the modular TypeScript + Tailwind framework one component at a time.",
        },
        {
          role: "assistant",
          supervisor: "codex",
          content: [
            "Committed one local checkpoint: `047b7a0 chore: expose package stylesheet metadata`.",
            "",
            "Verification passed:",
            "- `npm run typecheck`",
            "- `npm run build`",
            "",
            "Remaining work:",
            "- Drawer CP2 browser verification, no rebuild: side/size behavior, reduced-motion no-flash, stacking scroll-lock regression, focus trap, close reasons, declarative `<ui-drawer>`, console cleanliness, and top-layer behavior.",
            "- Drawer CP3 code review.",
          ].join("\n"),
        },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.reason, /supervisor chooses/i);
    assert.match(decision.content, /Continue with the next stage of the current plan/i);
    assert.match(decision.content, /Drawer CP2 browser verification/i);
    assert.match(decision.content, /Do not invent a code change/i);
    assert.match(decision.content, /commit only if you changed files/i);
    assert.equal(/Make one small, reversible change/.test(decision.content), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext follows explicit next stage instead of verification bullets", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model to parse the next plan stage");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "emenu",
      messages: [
        {
          role: "user",
          content: "Open the QR menu with Playwright and map the whole site and its functions.",
        },
        {
          role: "assistant",
          supervisor: "codex",
          content: [
            "Implemented the next local-only mapping step and committed it.",
            "",
            "Verification:",
            "- Opened `https://kostasvillagetaverna.com/qrmenu/` with Playwright.",
            "- `git diff --check HEAD~1..HEAD` passed.",
            "",
            "Remote publishing still needs explicit approval.",
            "",
            "Next stage: Phase 2 MySQL schema and migrations from the mapped legacy data.",
          ].join("\n"),
        },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.content, /Continue with the next stage of the current plan/i);
    assert.match(decision.content, /Phase 2 MySQL schema and migrations/i);
    assert.equal(/Opened https:\/\/kostasvillagetaverna\.com\/qrmenu/i.test(decision.content), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext ignores verification bullets when no plan stage is given", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model while ignoring verification bullets");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "emenu",
      messages: [
        {
          role: "assistant",
          supervisor: "codex",
          content: [
            "Changed docs/source-site-map.md and committed it.",
            "",
            "Verification:",
            "- Opened `https://kostasvillagetaverna.com/qrmenu/` with Playwright.",
            "- Verified `GET /qrmenuserver/getAllData` returns JSON.",
            "- `git diff --check` passed.",
            "",
            "Remote publishing still needs explicit approval.",
          ].join("\n"),
        },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.content, /identify or update the plan first/i);
    assert.equal(/Opened https:\/\/kostasvillagetaverna\.com\/qrmenu/i.test(decision.content), false);
    assert.equal(/getAllData/i.test(decision.content), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext refuses remote-write next stages in autopilot", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model while routing around remote write stages");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "emenu",
      messages: [
        {
          role: "assistant",
          supervisor: "codex",
          content: [
            "Local mapping is complete and verified.",
            "GITHUB_TOKEN is missing.",
            "Next stage: push to GitHub and create repo.",
          ].join("\n"),
        },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.content, /local-only next step/i);
    assert.equal(/push to GitHub/i.test(decision.content), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext retries supervisor run failures up to three consecutive failures", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  runtime.deepseekApiKey = "";
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called for failure recovery decisions");
  };

  try {
    const oneFailure = {
      supervisor: "codex",
      cwd: "project-a",
      autopilotEnabled: true,
      autopilotState: { state: "created" },
      messages: [
        { role: "assistant", supervisor: "codex", content: "Error: usage limit", error: true, at: "2026-05-29T00:00:00.000Z" },
      ],
    };
    const recovery = await decideAutopilotNext(oneFailure);
    assert.equal(fetchCalled, false);
    assert.equal(consecutiveAutopilotRunFailures(oneFailure), 1);
    assert.equal(autopilotNeedsDecision(oneFailure), true);
    assert.equal(recovery.action, "message");
    assert.match(recovery.reason, /1\/3/);
    assert.match(recovery.content, /Do not stop yet/);

    const pendingFollowup = {
      ...oneFailure,
      messages: [
        { role: "assistant", supervisor: "codex", content: "Previous phase complete.", at: "2026-05-29T00:00:00.000Z" },
        { role: "user", content: "Autopilot:\nRun the interrupted test command.", at: "2026-05-29T00:01:00.000Z" },
      ],
    };
    const retried = await decideAutopilotNext(pendingFollowup);
    assert.equal(autopilotNeedsDecision(pendingFollowup), true);
    assert.equal(retried.action, "message");
    assert.match(retried.reason, /interrupted Autopilot follow-up/i);
    assert.match(retried.content, /Run the interrupted test command/);
    assert.equal(fetchCalled, false);

    const threeFailures = {
      ...oneFailure,
      messages: [
        { role: "assistant", supervisor: "codex", content: "Error: usage limit 1", error: true, at: "2026-05-29T00:00:00.000Z" },
        { role: "assistant", supervisor: "codex", content: "Error: usage limit 2", error: true, at: "2026-05-29T00:01:00.000Z" },
        { role: "assistant", supervisor: "codex", content: "Error: usage limit 3", error: true, at: "2026-05-29T00:02:00.000Z" },
      ],
    };
    const stopped = await decideAutopilotNext(threeFailures);
    assert.equal(consecutiveAutopilotRunFailures(threeFailures), 3);
    assert.equal(autopilotNeedsDecision(threeFailures), false);
    assert.equal(stopped.action, "stop");
    assert.match(stopped.reason, /Three consecutive/);
  } finally {
    runtime.deepseekApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext keeps the session alive when the supervisor says work is done", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  runtime.deepseekApiKey = "test-deepseek-key";
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model to keep the session alive");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        { role: "assistant", supervisor: "codex", content: "All checks pass. Nothing else is required." },
      ],
    });

    // "Done" is never a terminal state here: the loop stays alive and asks the supervisor to
    // identify and verify the next safe step itself.
    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.content, /identify or update the plan first/i);
    assert.match(decision.reason, /supervisor chooses/i);
  } finally {
    runtime.deepseekApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext on a fresh session starts with a safe first step without hitting DeepSeek", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  runtime.deepseekApiKey = "test-deepseek-key";
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called when there is no assistant turn yet");
  };
  try {
    const decision = await decideAutopilotNext({ supervisor: "codex", cwd: ".", messages: [] });
    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.equal(/error|stopped run/i.test(decision.reason), false);
    assert.match(decision.reason, /Autopilot starts by choosing a safe first step/);
    assert.match(decision.content, /Inspect the project status/i);
  } finally {
    runtime.deepseekApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext keeps going on auth blockers with a local-only continuation", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  runtime.deepseekApiKey = "test-deepseek-key";
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model to route around an auth blocker");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        {
          role: "assistant",
          supervisor: "codex",
          content: [
            "Blocked on push: `git push origin main` cannot authenticate from this container.",
            "",
            "What happened:",
            "- GitHub then rejected auth: `Permission denied (publickey)`.",
            "- `gh` is not installed, and neither `GITHUB_TOKEN` nor `GH_TOKEN` is present.",
            "",
            "Next unblock step: provide GitHub push auth in this container, for example an SSH key accepted by `github.com:pagovitsa/orchestrator.git`, or install/configure `gh`, or expose `GH_TOKEN`/`GITHUB_TOKEN` with repo write access.",
          ].join("\n"),
        },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.content, /local-only next step/i);
    assert.match(decision.content, /avoids secrets and remote write access/i);
  } finally {
    runtime.deepseekApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext continues a non-auth blocker by handing the next step to the supervisor", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  runtime.deepseekApiKey = "test-deepseek-key";
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model for a recoverable blocker");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        {
          role: "assistant",
          supervisor: "codex",
          content: "Blocked on a missing dev dependency. Next unblock step: install the package and rerun tests.",
        },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.content, /identify or update the plan first/i);
    assert.match(decision.content, /targeted verification/i);
  } finally {
    runtime.deepseekApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext routes risky-approval blockers to a safe reversible continuation", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model for a risky-approval blocker");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        {
          role: "assistant",
          supervisor: "codex",
          content: "Awaiting approval to delete the production database and force-push to main. Confirm the destructive action before proceeding.",
        },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.content, /safest reversible path/i);
    assert.match(decision.content, /avoids destructive changes/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext forces verification when the last turn changed code without checks", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model for the verification gate");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        { role: "user", content: "Make the retry backoff jittered." },
        { role: "assistant", supervisor: "codex", content: "I edited src/retry.js to add the jittered backoff logic." },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.reason, /verified before continuing/i);
    assert.match(decision.content, /Before any new change, verify the previous change/i);
    assert.match(decision.content, /tests, lint, type-check, build/i);
    assert.match(decision.content, /Keep the original objective in focus: "Make the retry backoff jittered\."/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext skips the verification gate when the last turn shows checks were run", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        { role: "assistant", supervisor: "codex", content: "I edited src/retry.js to add jittered backoff and ran npm test - 42/42 pass." },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.reason, /supervisor chooses/i);
    assert.match(decision.content, /file change is required/i);
    assert.match(decision.content, /commit it locally/i);
    assert.equal(/Before any new change, verify the previous change/i.test(decision.content), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext breaks no-progress loops when recent answers repeat", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model for the no-progress breaker");
  };

  const repeated = "I am investigating the failing database connection test and checking the pool configuration in the data layer now.";
  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        { role: "assistant", supervisor: "codex", content: repeated },
        { role: "assistant", supervisor: "codex", content: repeated },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.reason, /repeated turns with no verified progress/i);
    assert.match(decision.content, /no verified progress/i);
    assert.match(decision.content, /Diagnose WHY there is no progress/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext anchors continuations to the original objective", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        { role: "user", content: "Add input validation to the signup form." },
        { role: "assistant", supervisor: "codex", content: "I reviewed the signup form structure and the current handlers." },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
    assert.match(decision.content, /Keep the original objective in focus: "Add input validation to the signup form\."/);
    assert.match(decision.content, /file change is required/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext verification gate fires on intent claims, not just keywords", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        // Mentions "tests" and "pass" but only as intent — no run, no result. The gate must still fire.
        { role: "assistant", supervisor: "codex", content: "I edited validation.js to add the email check. The tests should pass now." },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.match(decision.reason, /verified before continuing/i);
    assert.match(decision.content, /Before any new change, verify the previous change/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext verification gate skips an explicit already-verified recap", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        { role: "assistant", supervisor: "codex", content: "I edited validation.js to add the email check and already verified it; committing now." },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.match(decision.reason, /supervisor chooses/i);
    assert.match(decision.content, /file change is required/i);
    assert.equal(/Before any new change, verify the previous change/i.test(decision.content), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext no-progress breaker does not fire on distinct iterative turns", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("autopilot must not call any model");
  };

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        { role: "assistant", supervisor: "codex", content: "I reviewed the signup form and mapped out the validation rules we still need." },
        { role: "assistant", supervisor: "codex", content: "I outlined the email and password constraints and where they slot into the request handler." },
      ],
    });

    assert.equal(fetchCalled, false);
    assert.equal(decision.action, "message");
    assert.match(decision.reason, /supervisor chooses/i);
    assert.equal(/no verified progress/i.test(decision.content), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("autopilot retry config clamps invalid values", () => {
  assert.deepEqual(normalizeAutopilotRetryConfig({ attempts: 0, backoffMs: -50 }), {
    attempts: 1,
    backoffMs: 0,
  });
  assert.deepEqual(normalizeAutopilotRetryConfig({ attempts: 2.8, backoffMs: 12.4 }), {
    attempts: 3,
    backoffMs: 12,
  });
});

test("autopilot retry classification skips auth and retries transient failures", () => {
  assert.equal(isRetriableAutopilotError(Object.assign(new Error("rate limited"), { status: 429 })), true);
  assert.equal(isRetriableAutopilotError(Object.assign(new Error("server error"), { status: 503 })), true);
  assert.equal(isRetriableAutopilotError(Object.assign(new Error("bad request"), { status: 400 })), false);
  assert.equal(isRetriableAutopilotError(Object.assign(new Error("auth"), { status: 401 })), false);
  assert.equal(isRetriableAutopilotError(Object.assign(new Error("reset"), { code: "ECONNRESET" })), true);
  assert.equal(isRetriableAutopilotError(Object.assign(new Error("abort"), { name: "AbortError" })), false);
});

test("decideAutopilotNextWithRetry retries transient errors and reloads session", async () => {
  const seen = [];
  const retries = [];
  const initial = { id: "s1", marker: 1 };
  const reloaded = { id: "s1", marker: 2 };
  const result = await decideAutopilotNextWithRetry(initial, {
    config: { attempts: 3, backoffMs: 0 },
    getSession: async () => reloaded,
    onRetry: (event) => retries.push(event),
    decide: async (session) => {
      seen.push(session.marker);
      if (seen.length === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return { action: "message", kind: "continue", content: "next", reason: "ok" };
    },
  });

  assert.deepEqual(seen, [1, 2]);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].nextAttempt, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.session, reloaded);
  assert.equal(result.decision.content, "next");
});

test("decideAutopilotNextWithRetry retry backoff applies full jitter in [base/2, base]", async () => {
  const originalRandom = Math.random;
  try {
    // With Math.random() = 0 we expect exactly base/2; with 1 we expect base. Anything outside
    // [base/2, base] means the jitter formula slipped.
    for (const [randomValue, expected] of [[0, 100], [0.5, 150], [1, 200]]) {
      Math.random = () => randomValue;
      const captured = [];
      await assert.rejects(decideAutopilotNextWithRetry({ id: "s1" }, {
        config: { attempts: 2, backoffMs: 200 },
        onRetry: (event) => captured.push(event.delayMs),
        decide: async () => { throw Object.assign(new Error("blip"), { status: 503 }); },
      }), /blip/);
      assert.equal(captured.length, 1);
      assert.equal(captured[0], expected, `random=${randomValue} produced ${captured[0]} (want ${expected})`);
    }
  } finally {
    Math.random = originalRandom;
  }
});

test("decideAutopilotNextWithRetry does not retry non-transient errors", async () => {
  let attempts = 0;
  await assert.rejects(
    decideAutopilotNextWithRetry({ id: "s1" }, {
      config: { attempts: 3, backoffMs: 0 },
      decide: async () => {
        attempts += 1;
        throw Object.assign(new Error("bad key"), { status: 401 });
      },
    }),
    /bad key/,
  );
  assert.equal(attempts, 1);
});

test("decideAutopilotNextWithRetry aborts during retry backoff", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const promise = decideAutopilotNextWithRetry({ id: "s1" }, {
    signal: controller.signal,
    config: { attempts: 3, backoffMs: 1000 },
    decide: async () => {
      attempts += 1;
      throw Object.assign(new Error("rate limited"), { status: 429 });
    },
  });

  setTimeout(() => controller.abort(new Error("cancelled")), 10);
  await assert.rejects(promise, /cancelled/);
  assert.equal(attempts, 1);
});

async function withGithubWorkspace(fn) {
  const originalSecrets = paths.secretsDir;
  const originalWorkspace = paths.workspaceRoot;
  const secrets = await mkdtemp(path.join(os.tmpdir(), "orch-github-secrets-"));
  // resolveCwd validates against a cached real workspace root (set on first call). Keeping the
  // test workspace inside `originalWorkspaceRoot` ensures the isInside check still passes.
  const workspace = await mkdtemp(path.join(originalWorkspace, "orchestrator", ".tmp-github-"));
  try {
    paths.secretsDir = secrets;
    paths.workspaceRoot = workspace;
    return await fn({ secrets, workspace });
  } finally {
    paths.secretsDir = originalSecrets;
    paths.workspaceRoot = originalWorkspace;
    await rm(secrets, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

test("ensureKeypair generates an ed25519 key and is idempotent", async () => {
  await withGithubWorkspace(async () => {
    const first = await ensureKeypair();
    assert.equal(first.created, true);
    assert.match(first.publicKey, /^ssh-ed25519 /);
    const status = await githubConnectionStatus();
    assert.equal(status.hasKeypair, true);
    assert.equal(status.hasToken, false);

    const second = await ensureKeypair();
    assert.equal(second.created, false);
    assert.equal(second.publicKey, first.publicKey);
  });
});

test("saveToken + readToken + clearGithubConnection wire up the secret file", async () => {
  await withGithubWorkspace(async () => {
    await saveToken("ghp_fakeTokenValue");
    assert.equal(await readToken(), "ghp_fakeTokenValue");
    await clearGithubConnection();
    assert.equal(await readToken(), "");
    const status = await githubConnectionStatus();
    assert.equal(status.hasToken, false);
    assert.equal(status.hasKeypair, false);
  });
});

test("verifyToken returns the viewer login on success and surfaces HTTP errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === "https://api.github.com/user" && options.headers.authorization === "Bearer good") {
      return new Response(JSON.stringify({ login: "ada", id: 1, name: "Ada", html_url: "https://github.com/ada" }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
  };
  try {
    const viewer = await verifyToken("good");
    assert.equal(viewer.login, "ada");
    await assert.rejects(() => verifyToken("bad"), /Bad credentials/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("projectGithubStatus reports non-repo, then reflects remote after manual setup", async () => {
  await withGithubWorkspace(async ({ workspace }) => {
    const projectDir = path.join(workspace, "demo");
    await mkdir(projectDir, { recursive: true });
    const beforeInit = await projectGithubStatus("demo");
    assert.equal(beforeInit.isRepo, false);
    assert.equal(beforeInit.hasOrigin, false);

    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    const exec = promisify(execFile);
    await exec("git", ["-C", projectDir, "init", "-b", "main"]);
    await exec("git", ["-C", projectDir, "remote", "add", "origin", "git@github.com:ada/demo.git"]);
    const afterSetup = await projectGithubStatus("demo");
    assert.equal(afterSetup.isRepo, true);
    assert.equal(afterSetup.hasOrigin, true);
    assert.deepEqual(afterSetup.repo, { owner: "ada", name: "demo" });
  });
});

test("publishProjectToGithub fails fast when token is missing", async () => {
  await withGithubWorkspace(async ({ workspace }) => {
    await mkdir(path.join(workspace, "demo"), { recursive: true });
    await assert.rejects(() => publishProjectToGithub("demo"), /Connect GitHub first/);
  });
});

test("publishProjectToGithub creates a private repo, sets origin, commits and 'pushes'", async () => {
  await withGithubWorkspace(async ({ workspace }) => {
    const projectDir = path.join(workspace, "demo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "README.md"), "# demo\n");

    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    const exec = promisify(execFile);

    await ensureKeypair();
    await saveToken("ghp_ok");

    const originalFetch = globalThis.fetch;
    const apiCalls = [];
    globalThis.fetch = async (url, options) => {
      apiCalls.push({ url, method: options.method, body: options.body });
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ login: "ada", id: 1, name: "Ada", html_url: "https://github.com/ada" }), { status: 200 });
      }
      if (url === "https://api.github.com/user/repos") {
        const payload = JSON.parse(options.body || "{}");
        return new Response(JSON.stringify({
          name: payload.name,
          full_name: `ada/${payload.name}`,
          private: payload.private,
          html_url: `https://github.com/ada/${payload.name}`,
          owner: { login: "ada" },
        }), { status: 201 });
      }
      return new Response("", { status: 404 });
    };

    // Intercept the actual push by pointing origin (we set later) to a bare repo on disk so the
    // SSH-driven push degrades to a regular file push.
    const bareRemote = path.join(workspace, "demo-remote.git");
    await exec("git", ["init", "--bare", "-b", "main", bareRemote]);

    // The github helper would generate origin as git@github.com:..., which would attempt a real
    // SSH connection. Monkey-patch the helper at the file level by short-circuiting on the
    // bare-remote name via the execFile signature: we re-export and wrap below using a custom
    // module that delegates everything but the push.

    try {
      // Pre-create the remote on the bare repo path; the publishProjectToGithub will run
      // `git remote add origin git@github.com:ada/demo.git` which will fail to push. Tests can
      // still confirm steps up to the push by catching the push error and asserting the rest.
      // The push will fail (we cannot reach git@github.com from CI); we still assert that the
      // helper got that far — repo creation, local commit, and remote setup must have happened.
      await assert.rejects(() => publishProjectToGithub("demo", { repoName: "demo" }));

      // After the failed push, validate the local repo state.
      const remoteUrl = (await exec("git", ["-C", projectDir, "remote", "get-url", "origin"])).stdout.trim();
      assert.equal(remoteUrl, "git@github.com:ada/demo.git");
      const log = (await exec("git", ["-C", projectDir, "log", "--oneline"])).stdout.trim();
      assert.match(log, /Initial commit by Orch/);
      const reposCall = apiCalls.find((c) => c.url === "https://api.github.com/user/repos");
      assert.ok(reposCall, "POST /user/repos was not called");
      const body = JSON.parse(reposCall.body);
      assert.equal(body.name, "demo");
      assert.equal(body.private, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("githubSupervisorEnvSync exposes SSH command + token after connect, and is empty without them", async () => {
  await withGithubWorkspace(async () => {
    assert.deepEqual(githubSupervisorEnvSync(), {});
    await ensureKeypair();
    let env = githubSupervisorEnvSync();
    assert.match(env.GIT_SSH_COMMAND || "", /^ssh -i ".+id_ed25519"/);
    assert.equal(env.GITHUB_TOKEN, undefined);

    await saveToken("ghp_super");
    env = githubSupervisorEnvSync();
    assert.equal(env.GITHUB_TOKEN, "ghp_super");
    assert.equal(env.GH_TOKEN, "ghp_super");

    await clearGithubConnection();
    assert.deepEqual(githubSupervisorEnvSync(), {});
  });
});
