import test from "node:test";
import assert from "node:assert/strict";
import { appendMessageError, applyTerminalFlags, autopilotFeedEntryLabel, autopilotNeedsDecision, autopilotStateLabel, createSessionSendGate, messageClassNames, messageStateLabel, normalizeAutopilotFeed, readAttachments, streamApi } from "../public/client-helpers.js";

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
