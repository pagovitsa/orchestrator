import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safeUploadName, isTextAttachment } from "../src/domain/attachments.js";
import { normalizeAutopilotDecision, parseAutopilotDecision } from "../src/domain/autopilot.js";
import { extractUserMemoriesFromText, readMemory, rememberMemory } from "../src/domain/memory.js";
import { applySessionPatch, projectLabel } from "../src/domain/sessions.js";
import {
  calculateBalanceUsage,
  parseClaudeUsagePayload,
  parseCodexRateLimitPayload,
  parseGeminiQuotaPayload,
  parseUsageProbeOutput,
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

test("memory keeps user facts global across project files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orch-memory-"));
  try {
    const globalFile = path.join(dir, "user.json");
    const projectA = path.join(dir, "a", "orchestrator-memory.json");
    const projectB = path.join(dir, "b", "orchestrator-memory.json");

    await rememberMemory({ globalFile, projectFile: projectA }, {
      scope: "user",
      kind: "fact",
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
    assert.deepEqual(projectBMemory.user.memories[0].tags, ["identity", "name"]);
    assert.equal(projectBMemory.project.memories.length, 0);
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

test("memory extracts a stated user name for global recall", () => {
  const memories = extractUserMemoriesFromText("hey, my name is KOstas and I like dark mode");

  assert.equal(memories.length, 1);
  assert.equal(memories[0].scope, "user");
  assert.equal(memories[0].text, "The user's name is KOstas");
  assert.deepEqual(memories[0].tags, ["identity", "name"]);
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

test("normalizeAutopilotDecision forces continue after non-blocking completion summary", () => {
  const lastAssistant = {
    role: "assistant",
    content: [
      "Changed:       ολοκληρώθηκαν και έγιναν commit:",
      "- `3f9c78e Add client UI safety plumbing` για iter18-27.",
      "",
      "Verification:  passed:",
      "- `NODE_ENV=development corepack pnpm@9.12.0 -r typecheck`",
      "- `NODE_ENV=development corepack pnpm@9.12.0 -r test`",
      "",
      "Risks / notes: Electron runtime smoke παραμένει blocked από το container Electron binary issue.",
    ].join("\n"),
  };

  const normalized = normalizeAutopilotDecision(
    { action: "stop", kind: "stop", reason: "task appears complete" },
    lastAssistant,
  );

  assert.equal(normalized.action, "message");
  assert.equal(normalized.kind, "continue");
  assert.match(normalized.content, /Συνέχισε/);
  assert.match(normalized.reason, /Forced continue/);
});

test("normalizeAutopilotDecision keeps stop when assistant asks for approval", () => {
  const lastAssistant = {
    role: "assistant",
    content: "I need human approval before deleting these files. Please confirm.",
  };

  const normalized = normalizeAutopilotDecision(
    { action: "stop", kind: "stop", reason: "approval required" },
    lastAssistant,
  );

  assert.equal(normalized.action, "stop");
  assert.equal(normalized.reason, "approval required");
});
