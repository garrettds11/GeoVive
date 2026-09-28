// Thin Bedrock Converse API wrapper shared by Curator (extraction), Reviewer (accuracy checks,
// source-verification skill) and Governor (Haiku triage + Opus escalation -- readiness doc
// Section 4.2/9). Kept deliberately generic: callers pass their own system prompt and messages
// and get back the model's text plus a rough input+output token count, which callers accumulate
// against their own per-run token cap (Curator: 80k/run -- Section 5's stop conditions) rather
// than this module tracking any budget itself.

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const bedrock = new BedrockRuntimeClient({});

export const MODELS = {
  // Cross-region inference profile IDs -- update if the account's Bedrock model access changes.
  haiku: process.env.BEDROCK_HAIKU_MODEL_ID || "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  opus: process.env.BEDROCK_OPUS_MODEL_ID || "us.anthropic.claude-opus-4-5-20251101-v1:0"
};

// messages: [{ role: "user"|"assistant", content: string }]
// Returns { text, inputTokens, outputTokens }.
export async function converse({ modelId, system, messages, maxTokens = 2000, temperature = 0 }) {
  const resp = await bedrock.send(new ConverseCommand({
    modelId,
    system: system ? [{ text: system }] : undefined,
    messages: messages.map(m => ({ role: m.role, content: [{ text: m.content }] })),
    inferenceConfig: { maxTokens, temperature }
  }));
  const text = (resp.output?.message?.content || []).map(c => c.text || "").join("");
  return {
    text,
    inputTokens: resp.usage?.inputTokens || 0,
    outputTokens: resp.usage?.outputTokens || 0
  };
}

// Best-effort JSON extraction from a model response that may wrap JSON in prose or code fences.
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("[") >= 0 && (candidate.indexOf("{") < 0 || candidate.indexOf("[") < candidate.indexOf("{"))
    ? candidate.indexOf("[")
    : candidate.indexOf("{");
  const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
  if (start < 0 || end < 0) throw new Error("no JSON found in model response");
  return JSON.parse(candidate.slice(start, end + 1));
}
