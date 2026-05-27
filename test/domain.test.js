import test from "node:test";
import assert from "node:assert/strict";
import { safeUploadName, isTextAttachment } from "../src/domain/attachments.js";
import { applySessionPatch, projectLabel } from "../src/domain/sessions.js";
import { parseUsageProbeOutput } from "../src/domain/usage.js";
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
