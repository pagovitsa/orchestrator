import { runtime } from "../config/env.js";

const AUTOPILOT_MODEL = "deepseek-v4-pro";
const MAX_DECISION_CHARS = 6000;
const FALLBACK_CONTINUE_MESSAGE = [
  "Autopilot:",
  "Συνέχισε με προσοχή και απόλυτη προσήλωση στο project.",
  "Προχώρησε στο επόμενο λογικό βήμα, επαλήθευσε ό,τι αλλάζεις, και ρώτα μόνο αν υπάρχει πραγματικό blocker ή χρειάζεται ανθρώπινη έγκριση.",
].join("\n");

function latestAssistantMessage(session) {
  return [...(session.messages || [])].reverse().find((message) => message.role === "assistant") || null;
}

function recentTranscript(session, limit = 10) {
  return (session.messages || [])
    .slice(-limit)
    .map((message) => {
      const speaker = message.role === "assistant"
        ? `assistant/${message.supervisor || session.supervisor || "unknown"}`
        : "user";
      return `${speaker.toUpperCase()}:\n${message.modelContent || message.content || ""}`;
    })
    .join("\n\n");
}

function hasRunError(message) {
  if (!message) return true;
  if (message.error || message.stopped) return true;
  return /^\s*(error|command failed|uncaught|traceback)\b/i.test(String(message.content || ""));
}

function extractJsonObject(text) {
  const value = String(text || "").trim();
  if (!value) throw new Error("DeepSeek returned an empty autopilot decision");
  try {
    return JSON.parse(value);
  } catch {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
    throw new Error("DeepSeek autopilot decision was not valid JSON");
  }
}

export function parseAutopilotDecision(text) {
  const parsed = extractJsonObject(text);
  const action = String(parsed.action || "").trim().toLowerCase();
  const kind = String(parsed.kind || "").trim().toLowerCase();
  const reason = String(parsed.reason || "").trim();
  const rawContent = String(parsed.content || parsed.message || "").trim();

  if (action === "stop") {
    return { action: "stop", kind: kind || "stop", reason: reason || "Autopilot stopped" };
  }

  if (["message", "answer", "continue"].includes(action) || rawContent) {
    const content = rawContent || FALLBACK_CONTINUE_MESSAGE;
    return {
      action: "message",
      kind: kind || (action === "answer" ? "answer" : "continue"),
      content: content.slice(0, MAX_DECISION_CHARS),
      reason,
    };
  }

  return { action: "stop", kind: "stop", reason: reason || "Autopilot returned no next message" };
}

function autopilotPrompt(session, lastAssistant) {
  return [
    "You are Orch UI Autopilot. You decide the next USER message for a coding supervisor.",
    "Return ONLY compact JSON. No markdown, no prose outside JSON.",
    "",
    "Rules:",
    "- If the last assistant message is an app/model error, failed login, auth failure, missing credential, timeout, permission failure, or asks for destructive/human approval, return {\"action\":\"stop\",\"reason\":\"...\"}.",
    "- If the last assistant asks the user a question, choose the safest useful answer for the project and return {\"action\":\"message\",\"kind\":\"answer\",\"content\":\"...\",\"reason\":\"...\"}.",
    "- The answer should act like a careful project owner: prefer reversible steps, no destructive approval, no fake secrets, no guessy external commitments.",
    "- If the last assistant simply finished a phase or reported completion without a blocking question/error, return {\"action\":\"message\",\"kind\":\"continue\",\"content\":\"...\",\"reason\":\"...\"}.",
    "- For continue, tell the supervisor to continue carefully and with absolute focus on the project, verify changes, and proceed to the next logical step.",
    "- Keep content concise but actionable. It will be sent automatically to the active supervisor as the next user message.",
    "",
    `Project: ${session.cwd || session.project || "."}`,
    `Supervisor to answer: ${session.supervisor || "unknown"}`,
    "",
    "Recent conversation:",
    recentTranscript(session),
    "",
    "Last assistant message to judge:",
    lastAssistant.content || "",
  ].join("\n");
}

export async function decideAutopilotNext(session, { signal } = {}) {
  const lastAssistant = latestAssistantMessage(session);
  if (hasRunError(lastAssistant)) {
    return { action: "stop", kind: "stop", reason: "Last assistant message is an error or stopped run" };
  }
  if (!runtime.deepseekApiKey) {
    throw Object.assign(new Error("DeepSeek API key is required for Autopilot"), { status: 409 });
  }

  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.deepseekApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: AUTOPILOT_MODEL,
      temperature: 0.1,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: "You are a strict JSON autopilot planner for a coding chat UI. Return only JSON.",
        },
        { role: "user", content: autopilotPrompt(session, lastAssistant) },
      ],
    }),
    signal,
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`DeepSeek autopilot HTTP ${response.status}: ${body}`);
  const parsed = JSON.parse(body);
  const content = parsed.choices?.[0]?.message?.content || "";
  return parseAutopilotDecision(content);
}
