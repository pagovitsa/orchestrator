import test from "node:test";
import assert from "node:assert/strict";
import { appendMessageError, applyTerminalFlags, createSessionSendGate, messageClassNames, messageStateLabel, readAttachments, streamApi } from "../public/client-helpers.js";

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
