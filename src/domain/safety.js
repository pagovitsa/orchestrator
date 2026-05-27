const MAX_FINDINGS = 20;

const hardSensitivePatterns = [
  {
    label: "private key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[redacted private key]",
  },
  {
    label: "auth token",
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: "$1 [redacted]",
  },
  {
    label: "api token",
    pattern: /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g,
    replacement: "[redacted]",
  },
];

const softSensitivePatterns = [
  {
    label: "credential assignment",
    pattern: /\b((?:api|access|refresh|auth|id|client)?[_ -]?(?:key|token|secret|password|passwd)|authorization)\b(\s*(?:=|:)\s*)(["']?)([^\s"',;`]{6,})(\3)/gi,
    replacement: "$1$2$3[redacted]$5",
  },
];

const sensitivePatterns = [...hardSensitivePatterns, ...softSensitivePatterns];

function detectSensitiveTextWithPatterns(text, patterns) {
  const value = String(text || "");
  const findings = [];
  for (const { label, pattern } of patterns) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      findings.push({
        label,
        index: match.index || 0,
      });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

export function detectSensitiveText(text) {
  return detectSensitiveTextWithPatterns(text, sensitivePatterns);
}

export function containsSensitiveText(text) {
  return detectSensitiveText(text).length > 0;
}

export function containsHighConfidenceSensitiveText(text) {
  return detectSensitiveTextWithPatterns(text, hardSensitivePatterns).length > 0;
}

export function redactSensitiveText(text) {
  let redacted = String(text || "");
  for (const { pattern, replacement } of [...hardSensitivePatterns, ...softSensitivePatterns]) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function assertNoSensitiveText(text, action = "store") {
  if (!containsSensitiveText(text)) return;
  throw Object.assign(new Error(`Refusing to ${action} secrets, tokens, passwords, or keys`), { status: 400 });
}

export function assertNoHighConfidenceSensitiveText(text, action = "store") {
  if (!containsHighConfidenceSensitiveText(text)) return;
  throw Object.assign(new Error(`Refusing to ${action} secrets, tokens, passwords, or keys`), { status: 400 });
}

export function redactSensitiveStrings(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveStrings(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (/(?:api|access|refresh|auth|id|client)?[_ -]?(?:key|token|secret|password|passwd)|authorization/i.test(key)) {
        return [key, "[redacted]"];
      }
      return [key, redactSensitiveStrings(entry)];
    }),
  );
}
