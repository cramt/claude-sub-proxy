// Minimal subset of the OpenAI chat-completions wire format that we need to
// speak to clients (Hermes points its `provider: custom` at us).

export interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>; // JSON Schema
}

export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<{ type: string; text?: string }> | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  stream?: boolean;
  // Everything else (temperature, top_p, …) is accepted and ignored — the
  // Claude Agent SDK / subscription path does not expose those knobs.
  [k: string]: unknown;
}

/** Flatten an OpenAI message `content` field (string or block array) to text. */
export function contentToText(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((b) => (typeof b === "string" ? b : (b.text ?? "")))
    .join("");
}
