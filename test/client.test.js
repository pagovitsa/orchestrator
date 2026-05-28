import test from "node:test";
import assert from "node:assert/strict";
import { appendMessageError, applyTerminalFlags, autopilotCanResumeFromSummary, autopilotFeedEntryLabel, autopilotNeedsDecision, autopilotStateLabel, createSessionSendGate, extractErrorReason, formatResetCountdown, messageClassNames, messageStateLabel, nextUsageResetMs, nextWizardStep, normalizeAutopilotFeed, prevWizardStep, readAttachments, shouldCollapseTerminalContent, streamApi, wizardProgress } from "../public/client-helpers.js";

test("readAttachments rejects oversized batches before reading files", async () => {
  let readCount = 0;
  const files = [
    { name: "a.txt", type: "text/plain", size: 600, arrayBuffer: async () => { readCount += 1; return new ArrayBuffer(1); } },
    { name: "b.txt", type: "text/plain", size: 500, arrayBuffer: async () => { readCount += 1; return new ArrayBuffer(1); } },
  ];

  await assert.rejects(
    () => readAttachments(files, { maxUploadBytes: 1000 }),
    /Attached files exceed 1000 B/,
  );
  assert.equal(readCount, 0);
});

test("readAttachments encodes accepted files as base64 attachments", async () => {
  const files = [{
    name: "note.txt",
    type: "text/plain",
    size: 5,
    arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
  }];

  const attachments = await readAttachments(files, { maxUploadBytes: 1000 });
  assert.deepEqual(attachments, [{
    name: "note.txt",
    type: "text/plain",
    size: 5,
    dataBase64: "aGVsbG8=",
  }]);
});

function streamResponse(lines) {
  const chunks = lines.map((line) => new TextEncoder().encode(line));
  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            const value = chunks.shift();
            return value ? { value, done: false } : { done: true };
          },
        };
      },
    },
  };
}

test("streamApi rejects streams that close without a terminal event", async () => {
  const chunks = [];
  await assert.rejects(
    () => streamApi("/stream", {}, {
      chunk(event) {
        chunks.push(event.content);
      },
    }, {
      fetchImpl: async () => streamResponse(['{"type":"chunk","content":"partial"}\n']),
    }),
    /Stream ended before completion/,
  );
  assert.deepEqual(chunks, ["partial"]);
});

test("streamApi resolves after a terminal event", async () => {
  const chunks = [];
  let done = false;
  await streamApi("/stream", {}, {
    chunk(event) {
      chunks.push(event.content);
    },
    done() {
      done = true;
    },
  }, {
    fetchImpl: async () => streamResponse([
      '{"type":"chunk","content":"ok"}\n',
      '{"type":"done","session":{"id":"s"},"message":{}}\n',
    ]),
  });

  assert.deepEqual(chunks, ["ok"]);
  assert.equal(done, true);
});

test("streamApi surfaces HTTP error responses", async () => {
  await assert.rejects(
    () => streamApi("/stream", {}, {}, {
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: "rate limited" }),
      }),
    }),
    /rate limited/,
  );
});

test("streamApi traces malformed lines before requiring completion", async () => {
  const traces = [];
  await assert.rejects(
    () => streamApi("/stream", {}, {
      trace(event) {
        traces.push(event.content);
      },
    }, {
      fetchImpl: async () => streamResponse(["not json\n"]),
    }),
    /Stream ended before completion/,
  );
  assert.deepEqual(traces, ["[client] ignored malformed stream line\n"]);
});

test("messageClassNames includes stopped and error states", () => {
  assert.equal(
    messageClassNames({ role: "assistant", streaming: true, error: true, stopped: true }),
    "message assistant streaming error stopped",
  );
});

test("messageStateLabel exposes terminal state text", () => {
  assert.equal(messageStateLabel({ error: true, stopped: true }), "error");
  assert.equal(messageStateLabel({ stopped: true }), "stopped");
  assert.equal(messageStateLabel({ streaming: true }), "live");
  assert.equal(messageStateLabel({}), "");
});

test("appendMessageError keeps partial output visibly marked", () => {
  assert.equal(appendMessageError("partial answer", "Stream ended before completion"), "partial answer\n\nError: Stream ended before completion");
  assert.equal(appendMessageError("", "network failed"), "Error: network failed");
});

test("applyTerminalFlags preserves stopped and error metadata", () => {
  const target = {};
  applyTerminalFlags(target, { error: true, stopped: true });
  assert.deepEqual(target, { error: true, stopped: true });
});

test("autopilotStateLabel summarizes workflow state for UI", () => {
  assert.equal(autopilotStateLabel({ state: "created" }, true), "ready");
  assert.equal(autopilotStateLabel({ state: "completed" }, true), "ready");
  assert.equal(autopilotStateLabel({ state: "running" }, true), "running");
  assert.equal(autopilotStateLabel({ state: "failed" }, true), "failed");
  assert.equal(autopilotStateLabel({ state: "completed" }, false), "paused");
});

test("autopilot feed helpers keep sidebar labels compact", () => {
  const feed = normalizeAutopilotFeed([
    { at: "2026-05-27T10:00:00.000Z", action: "message", kind: "continue", reason: "x".repeat(120), content: "ignored" },
    { at: "2026-05-27T10:01:00.000Z", action: "stop", kind: "stop", reason: "stopped" },
    { at: "2026-05-27T10:02:00.000Z", action: "message", kind: "answer", reason: "ignored by limit" },
  ]);

  assert.equal(feed.length, 2);
  assert.equal(feed[0].reason.length, 80);
  assert.equal(feed[0].content, undefined);
  assert.equal(autopilotFeedEntryLabel(feed[0], Date.parse("2026-05-27T10:02:00.000Z")), "continue - 2m ago");
  assert.equal(normalizeAutopilotFeed(feed, { limit: 0 }).length, 0);
  assert.equal(normalizeAutopilotFeed(feed, { limit: 99 }).length, 2);
  assert.deepEqual(normalizeAutopilotFeed(null), []);
});

test("autopilotNeedsDecision detects missed ready assistant turns", () => {
  const session = {
    autopilotEnabled: true,
    autopilotState: { state: "created" },
    messages: [
      { role: "user", at: "2026-05-27T10:00:00.000Z", content: "go" },
      { role: "assistant", at: "2026-05-27T10:05:00.000Z", content: "done" },
    ],
    autopilotHistory: [],
  };

  assert.equal(autopilotNeedsDecision(session), true);
  assert.equal(autopilotNeedsDecision({
    ...session,
    autopilotHistory: [{ at: "2026-05-27T10:06:00.000Z", action: "message" }],
  }), false);
  assert.equal(autopilotNeedsDecision({
    ...session,
    autopilotHistory: [{ at: "2026-05-27T10:06:00.000Z", action: "stop" }],
  }), false);
  assert.equal(autopilotNeedsDecision({
    ...session,
    autopilotHistory: [{ at: "2026-05-27T10:04:00.000Z", action: "stop" }],
  }), true);
  assert.equal(autopilotNeedsDecision({ ...session, messages: [...session.messages, { role: "user", at: "2026-05-27T10:07:00.000Z" }] }), false);
  assert.equal(autopilotNeedsDecision({ ...session, autopilotState: { state: "running" } }), false);
  assert.equal(autopilotNeedsDecision({ ...session, messages: [{ ...session.messages.at(-1), streaming: true }] }), false);
});

test("autopilotCanResumeFromSummary only allows runnable enabled summaries", () => {
  assert.equal(autopilotCanResumeFromSummary({
    id: "session-a",
    autopilotEnabled: true,
    autopilotState: { state: "created" },
  }), true);
  assert.equal(autopilotCanResumeFromSummary({
    id: "session-a",
    autopilotEnabled: true,
    autopilotState: { state: "completed" },
  }), true);
  assert.equal(autopilotCanResumeFromSummary({
    id: "session-a",
    autopilotEnabled: true,
    autopilotState: { state: "running" },
  }), false);
  assert.equal(autopilotCanResumeFromSummary({
    id: "session-a",
    autopilotEnabled: true,
    autopilotState: { state: "paused" },
  }), false);
  assert.equal(autopilotCanResumeFromSummary({
    id: "session-a",
    autopilotEnabled: true,
    autopilotState: { state: "stopped" },
  }), false);
  assert.equal(autopilotCanResumeFromSummary({
    id: "session-a",
    autopilotEnabled: false,
    autopilotState: { state: "created" },
  }), false);
  assert.equal(autopilotCanResumeFromSummary({
    autopilotEnabled: true,
    autopilotState: { state: "created" },
  }), false);
});

test("createSessionSendGate blocks duplicate sends until released", () => {
  const gate = createSessionSendGate();
  assert.equal(gate.tryStart("session-a"), true);
  assert.equal(gate.tryStart("session-a"), false);
  assert.equal(gate.tryStart("session-b"), true);
  assert.equal(gate.has("session-a"), true);

  gate.finish("session-a");
  assert.equal(gate.has("session-a"), false);
  assert.equal(gate.tryStart("session-a"), true);
});

test("shouldCollapseTerminalContent only triggers for long error/stopped messages", () => {
  assert.equal(shouldCollapseTerminalContent({ role: "assistant", content: "x".repeat(2000) }), false);
  assert.equal(shouldCollapseTerminalContent({ role: "assistant", content: "Error: oops", error: true }), false);
  assert.equal(shouldCollapseTerminalContent({ role: "assistant", content: "x".repeat(2000), error: true }), true);
  assert.equal(shouldCollapseTerminalContent({ role: "assistant", content: "x".repeat(2000), stopped: true }), true);
  assert.equal(shouldCollapseTerminalContent(null), false);
});

test("extractErrorReason picks the trailing Error: line and falls back to last lines", () => {
  const full = `Some long transcript line\nmore stuff\n\nError: HTTP 429 rate limited`;
  assert.equal(extractErrorReason(full, { error: true }), "Error: HTTP 429 rate limited");
  // Multi-line error keeps up to 3 non-JSON lines
  const multiline = `transcript\n\nError: First line\nshort detail\nthird short line\nfourth line drops off`;
  assert.equal(extractErrorReason(multiline, { error: true }), "Error: First line\nshort detail\nthird short line…");
  // No Error: prefix → last lines (compressed)
  const noPrefix = `line a\nline b\nline c`;
  assert.equal(extractErrorReason(noPrefix, { error: true }), "line a\nline b\nline c");
  // Empty content
  assert.equal(extractErrorReason("", { error: true }), "Error");
  assert.equal(extractErrorReason("", { error: false }), "Stopped");
  // Huge Error: block (the my-harmony case) — must be capped, not echoed in full.
  const huge = "Error: stdout:\n" + "x".repeat(500_000);
  const compact = extractErrorReason(huge, { error: true });
  assert.ok(compact.length < 500, `reason too long: ${compact.length}`);
  assert.ok(compact.startsWith("Error: stdout:"), `unexpected start: ${compact.slice(0, 40)}`);
  // When Error: appears multiple times, the LAST one wins (server appends Error: at the end).
  const trailing = `Error: noise from elsewhere in transcript\n\nReal text\n\nError: actual reason 429`;
  assert.equal(extractErrorReason(trailing, { error: true }), "Error: actual reason 429");
  // JSON-looking lines get replaced with a placeholder so the bubble stays readable.
  const withJson = `Error: stdout:\n{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","utilization":0.99}}\nerror: rate limit hit`;
  const jsonReason = extractErrorReason(withJson, { error: true });
  assert.match(jsonReason, /<raw output/);
  assert.ok(!/rate_limit_event/.test(jsonReason), `JSON leaked into preview: ${jsonReason}`);
});

test("nextWizardStep skips steps whose prerequisite is not ready, and clamps to the last step", () => {
  const steps = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  // No skipping
  assert.equal(nextWizardStep(steps, "a", () => true), "b");
  assert.equal(nextWizardStep(steps, "c", () => true), "d");
  // Skip b because it's not ready
  assert.equal(nextWizardStep(steps, "a", (id) => id !== "b"), "c");
  // No subsequent ready step -> stop at last
  assert.equal(nextWizardStep(steps, "c", () => false), "d");
  // Unknown current id treats as "before a"
  assert.equal(nextWizardStep(steps, "__start__", () => true), "a");
  // Empty steps return null
  assert.equal(nextWizardStep([], "x", () => true), null);
});

test("prevWizardStep stops at the first step and respects empty arrays", () => {
  const steps = [{ id: "one" }, { id: "two" }, { id: "three" }];
  assert.equal(prevWizardStep(steps, "two"), "one");
  assert.equal(prevWizardStep(steps, "three"), "two");
  assert.equal(prevWizardStep(steps, "one"), "one");
  assert.equal(prevWizardStep(steps, "missing"), "one");
  assert.equal(prevWizardStep([], "x"), null);
});

test("wizardProgress returns 1-indexed step and percent", () => {
  const steps = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(wizardProgress(steps, "a"), { index: 1, total: 4, percent: 25 });
  assert.deepEqual(wizardProgress(steps, "c"), { index: 3, total: 4, percent: 75 });
  assert.deepEqual(wizardProgress(steps, "d"), { index: 4, total: 4, percent: 100 });
  assert.deepEqual(wizardProgress(steps, "missing"), { index: 1, total: 4, percent: 25 });
  assert.deepEqual(wizardProgress([], "x"), { index: 0, total: 0, percent: 0 });
});

test("nextUsageResetMs picks the soonest future reset across known + probe labels", () => {
  const now = Date.parse("2026-05-28T12:00:00.000Z");
  const usage = {
    lastKnownLabel: "Claude usage: 5h 77% reset 2026-05-28T14:00:00.000Z · 7d 12% reset 2026-06-03T22:00:00.000Z",
    lastProbeOutput: "5h 77% reset 2026-05-28T14:00:00.000Z\n7d 12% reset 2026-06-03T22:00:00.000Z",
  };
  assert.equal(nextUsageResetMs(usage, now), Date.parse("2026-05-28T14:00:00.000Z"));
  // Past reset timestamps are ignored (they would have already happened).
  const past = {
    lastKnownLabel: "old 5h 0% reset 2026-05-28T10:00:00.000Z",
  };
  assert.equal(nextUsageResetMs(past, now), null);
  // No usage data
  assert.equal(nextUsageResetMs(null, now), null);
  assert.equal(nextUsageResetMs({}, now), null);
});

test("formatResetCountdown produces compact relative labels", () => {
  const now = Date.parse("2026-05-28T12:00:00.000Z");
  assert.equal(formatResetCountdown(now + 45 * 1000, now), "45s");
  assert.equal(formatResetCountdown(now + 5 * 60 * 1000, now), "5m");
  assert.equal(formatResetCountdown(now + 3 * 60 * 60 * 1000, now), "3h");
  assert.equal(formatResetCountdown(now + 26 * 60 * 60 * 1000, now), "26h");
  assert.equal(formatResetCountdown(now + 50 * 60 * 60 * 1000, now), "2d 2h");
  assert.equal(formatResetCountdown(now + 7 * 24 * 60 * 60 * 1000, now), "7d");
  assert.equal(formatResetCountdown(null), "");
});
