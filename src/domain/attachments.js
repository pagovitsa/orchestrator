import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths, runtime } from "../config/env.js";
import { formatBytes } from "../utils/format.js";
import { resolveCwd } from "./workspace.js";

export function safeUploadName(name) {
  const base = path.basename(String(name || "attachment"));
  const clean = base
    .replace(/[^\w.() -]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/_+/g, "_")
    .trim()
    .slice(0, 120);
  if (!clean || clean === "." || clean === "..") return "attachment";
  return clean;
}

export function isTextAttachment(name, type) {
  if (String(type || "").startsWith("text/")) return true;
  return [
    ".css",
    ".csv",
    ".env",
    ".go",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".log",
    ".md",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
  ].includes(path.extname(String(name || "")).toLowerCase());
}

function decodeAttachmentData(dataBase64, name) {
  const raw = String(dataBase64 || "");
  const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!base64) throw Object.assign(new Error(`Attachment ${name || ""} is empty`), { status: 400 });
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) throw Object.assign(new Error(`Attachment ${name || ""} is empty`), { status: 400 });
  return buffer;
}

export async function saveAttachments(session, rawAttachments = []) {
  if (!Array.isArray(rawAttachments) || !rawAttachments.length) return [];
  if (rawAttachments.length > 20) {
    throw Object.assign(new Error("At most 20 files can be attached to one message"), { status: 400 });
  }

  const sessionUploadDir = path.join(resolveCwd(session.cwd || "."), ".orch-ui", "uploads", session.id);
  await mkdir(sessionUploadDir, { recursive: true });

  let totalBytes = 0;
  let remainingInlineChars = runtime.maxInlineAttachmentChars;
  const saved = [];

  for (const [index, attachment] of rawAttachments.entries()) {
    const originalName = String(attachment.name || `attachment-${index + 1}`);
    const buffer = decodeAttachmentData(attachment.dataBase64, originalName);
    totalBytes += buffer.length;
    if (totalBytes > runtime.maxUploadBytes) {
      throw Object.assign(new Error(`Attached files exceed ${formatBytes(runtime.maxUploadBytes)}`), { status: 413 });
    }

    const safeName = safeUploadName(originalName);
    const storedName = `${Date.now()}-${index + 1}-${safeName}`;
    const filePath = path.resolve(sessionUploadDir, storedName);
    if (filePath !== sessionUploadDir && !filePath.startsWith(`${sessionUploadDir}${path.sep}`)) {
      throw Object.assign(new Error("Invalid attachment path"), { status: 400 });
    }
    await writeFile(filePath, buffer);

    const metadata = {
      name: originalName,
      storedName,
      type: String(attachment.type || "application/octet-stream"),
      size: buffer.length,
      path: filePath,
      workspacePath: path.relative(paths.workspaceRoot, filePath),
    };

    if (remainingInlineChars > 0 && isTextAttachment(originalName, metadata.type)) {
      const text = buffer.toString("utf8").replace(/\0/g, "");
      metadata.inlineText = text.slice(0, remainingInlineChars);
      metadata.inlineTruncated = text.length > metadata.inlineText.length;
      remainingInlineChars -= metadata.inlineText.length;
    }

    saved.push(metadata);
  }

  return saved;
}

export function publicAttachmentMetadata(attachments) {
  return attachments.map(({ inlineText, inlineTruncated, ...metadata }) => metadata);
}

export function buildAttachmentPrompt(attachments) {
  if (!attachments.length) return "";
  const sections = ["ATTACHED FILES:"];
  for (const attachment of attachments) {
    sections.push([
      `- ${attachment.name}`,
      `  path: ${attachment.path}`,
      `  workspace_relative_path: ${attachment.workspacePath}`,
      `  type: ${attachment.type}`,
      `  size: ${formatBytes(attachment.size)}`,
    ].join("\n"));
    if (attachment.inlineText) {
      sections.push([
        `  inline_preview${attachment.inlineTruncated ? " (truncated)" : ""}:`,
        "```",
        attachment.inlineText,
        "```",
      ].join("\n"));
    }
  }
  sections.push("Use the paths above when you need the full uploaded files.");
  return sections.join("\n");
}

export function buildModelContent(content, attachments) {
  const parts = [];
  if (content) parts.push(content);
  const attachmentPrompt = buildAttachmentPrompt(attachments);
  if (attachmentPrompt) parts.push(attachmentPrompt);
  return parts.join("\n\n");
}
