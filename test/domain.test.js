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
  clearAutopilotHistory,
  decideAutopilotNext,
  decideAutopilotNextWithRetry,
  isRetriableAutopilotError,
  normalizeAutopilotDecision,
  normalizeAutopilotRetryConfig,
  parseAutopilotDecision,
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
import { applySessionPatch, clearStaleAutopilotRuns, loadSession, projectLabel, rememberPathForCwd, saveSession } from "../src/domain/sessions.js";
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
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "οrchestrator", ".tmp-sessions-"));
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

test("saveSession refuses partial session objects without messages", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "οrchestrator", ".tmp-sessions-"));
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
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "οrchestrator", ".tmp-sessions-"));
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
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "οrchestrator", ".tmp-sessions-"));
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
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "οrchestrator", ".tmp-attachments-"));
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
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "οrchestrator", ".tmp-attachments-"));
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
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "οrchestrator", ".tmp-attachments-"));
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
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "οrchestrator", ".tmp-sessions-"));
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
      messages: [],
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
  } finally {
    paths.workspaceRoot = originalWorkspaceRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSession preserves running state for startup cleanup", async () => {
  const originalWorkspaceRoot = paths.workspaceRoot;
  const dir = await mkdtemp(path.join(originalWorkspaceRoot, "οrchestrator", ".tmp-sessions-"));
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

test("parseAutopilotDecision accepts JSON answer decisions", () => {
  const parsed = parseAutopilotDecision('{"action":"message","kind":"answer","content":"Use the safer default.","reason":"assistant asked"}');

  assert.equal(parsed.action, "message");
  assert.equal(parsed.kind, "answer");
  assert.equal(parsed.content, "Use the safer default.");
});

test("parseAutopilotDecision stops on explicit stop decisions", () => {
  const parsed = parseAutopilotDecision("```json\n{\"action\":\"stop\",\"reason\":\"auth failed\"}\n```");

  assert.equal(parsed.action, "stop");
  assert.equal(parsed.reason, "auth failed");
});

test("parseAutopilotDecision stops on empty message decisions", () => {
  const parsed = parseAutopilotDecision('{"action":"continue","content":"","reason":"no text"}');

  assert.equal(parsed.action, "stop");
  assert.equal(parsed.reason, "no text");
});

test("decideAutopilotNext sends latest messages to DeepSeek for context", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  let requestBody;
  runtime.deepseekApiKey = "test-deepseek-key";
  globalThis.fetch = async (_url, options = {}) => {
    requestBody = JSON.parse(String(options.body || "{}"));
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"message","kind":"continue","content":"Continue carefully.","reason":"has context"}' } }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
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

    assert.equal(decision.action, "message");
    const prompt = requestBody.messages[1].content;
    assert.match(prompt, /Latest messages for context/);
    assert.match(prompt, /USER:\nFocus on the invoice edge case\./);
    assert.match(prompt, /USER:\nAlso keep the mobile layout stable\./);
    assert.match(prompt, /ASSISTANT\/CLAUDE:\nDone; tests pass and layout is stable\./);
    assert.match(prompt, /Last assistant message to judge:\nDone; tests pass and layout is stable\./);
  } finally {
    runtime.deepseekApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("normalizeAutopilotDecision respects stop after completion summary", () => {
  const normalized = normalizeAutopilotDecision(
    { action: "stop", kind: "stop", reason: "task appears complete" },
  );

  assert.equal(normalized.action, "stop");
  assert.equal(normalized.kind, "stop");
  assert.equal(normalized.reason, "task appears complete");
});

test("normalizeAutopilotDecision keeps stop when assistant asks for approval", () => {
  const normalized = normalizeAutopilotDecision(
    { action: "stop", kind: "stop", reason: "approval required" },
  );

  assert.equal(normalized.action, "stop");
  assert.equal(normalized.reason, "approval required");
});

test("decideAutopilotNext respects DeepSeek stop decisions", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  runtime.deepseekApiKey = "test-deepseek-key";
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"action":"stop","reason":"nothing left to do"}' } }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  try {
    const decision = await decideAutopilotNext({
      supervisor: "codex",
      cwd: "project-a",
      messages: [
        { role: "assistant", supervisor: "codex", content: "All checks pass. Nothing else is required." },
      ],
    });

    assert.equal(decision.action, "stop");
    assert.equal(decision.reason, "nothing left to do");
  } finally {
    runtime.deepseekApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext stops locally on git push auth blockers", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  runtime.deepseekApiKey = "test-deepseek-key";
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called for local push auth blockers");
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
    assert.equal(decision.action, "stop");
    assert.equal(decision.kind, "stop");
    assert.match(decision.reason, /git push authentication/i);
  } finally {
    runtime.deepseekApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext lets non-auth blockers go to DeepSeek", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  runtime.deepseekApiKey = "test-deepseek-key";
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"message","kind":"continue","content":"Install the missing package and rerun tests.","reason":"recoverable blocker"}' } }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
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

    assert.equal(fetchCalled, true);
    assert.equal(decision.action, "message");
    assert.equal(decision.kind, "continue");
  } finally {
    runtime.deepseekApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("decideAutopilotNext rejects invalid DeepSeek decisions without fallback continue", async () => {
  const originalKey = runtime.deepseekApiKey;
  const originalFetch = globalThis.fetch;
  runtime.deepseekApiKey = "test-deepseek-key";
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: "not json" } }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  try {
    await assert.rejects(
      decideAutopilotNext({
        supervisor: "codex",
        cwd: "project-a",
        messages: [
          { role: "assistant", supervisor: "codex", content: "All checks pass. Nothing else is required." },
        ],
      }),
      /not valid JSON/,
    );
  } finally {
    runtime.deepseekApiKey = originalKey;
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
