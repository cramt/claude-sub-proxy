import {
  query,
  tool,
  createSdkMcpServer,
  type Options,
  type SDKUserMessage,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { propsToShape } from "./json-schema-to-zod";
import type { OpenAITool } from "./openai-types";

const MCP_SERVER = "hermes";

/** A tool call Claude made, suspended until the client returns a result. */
interface CapturedCall {
  callId: string; // what we expose to the client (also encodes the session id)
  name: string; // the client's original tool name
  args: unknown;
  resolve: (resultText: string) => void;
}

/** What a single Claude "step" resolves to once it stops for input. */
export type Boundary =
  | { kind: "tool_calls"; calls: { callId: string; name: string; args: unknown }[] }
  | { kind: "final"; text: string }
  | { kind: "error"; message: string };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export interface StartArgs {
  promptText: string;
  systemPrompt?: string;
  model?: string;
  tools: OpenAITool[];
  env: Record<string, string | undefined>;
  claudeExecutable?: string;
}

/**
 * One Session === one live Claude Agent SDK `query()`. Claude's internal
 * agent loop is suspended inside our tool handlers; each suspension surfaces
 * as a `tool_calls` boundary to the HTTP caller, who runs the tool in its own
 * world and posts the result back, resuming the loop. The session lives for
 * the duration of one tool-use cycle and ends when Claude returns final text.
 */
export class Session {
  readonly id: string;
  private query!: Query;
  private boundary = deferred<Boundary>();
  private currentBatch: CapturedCall[] = [];
  private pendingByCallId = new Map<string, CapturedCall>();
  private seq = 0;
  private flushScheduled = false;
  finished = false;

  constructor(id: string) {
    this.id = id;
  }

  start(args: StartArgs): Promise<Boundary> {
    const options: Options = {
      includePartialMessages: false,
      // Do not load CLAUDE.md / local settings — we want a clean model, not
      // a Claude Code project agent.
      settingSources: [],
      env: args.env,
      // Auto-approve everything; the *client* is the real gatekeeper.
      canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
    };
    if (args.systemPrompt) options.systemPrompt = args.systemPrompt;
    if (args.model) options.model = args.model;
    if (args.claudeExecutable) options.pathToClaudeCodeExecutable = args.claudeExecutable;

    if (args.tools.length > 0) {
      const server = createSdkMcpServer({
        name: MCP_SERVER,
        version: "0.1.0",
        tools: args.tools.map((t) =>
          tool(
            t.function.name,
            t.function.description ?? "",
            propsToShape(t.function.parameters),
            (callArgs) => this.captureToolCall(t.function.name, callArgs),
          ),
        ),
      });
      options.mcpServers = { [MCP_SERVER]: server };
      options.allowedTools = args.tools.map((t) => `mcp__${MCP_SERVER}__${t.function.name}`);
    } else {
      options.allowedTools = [];
    }

    this.query = query({ prompt: singleUserMessage(args.promptText), options });
    void this.run();
    return this.boundary.promise;
  }

  /** Tool handler: capture the call and suspend until a result arrives. */
  private captureToolCall(
    name: string,
    args: unknown,
  ): Promise<{ content: { type: "text"; text: string }[] }> {
    const callId = `${this.id}__${this.seq++}`;
    return new Promise((resolvePromise) => {
      const call: CapturedCall = {
        callId,
        name,
        args,
        resolve: (text) => resolvePromise({ content: [{ type: "text", text }] }),
      };
      this.pendingByCallId.set(callId, call);
      this.currentBatch.push(call);
      this.scheduleFlush();
    });
  }

  /**
   * After all tool handlers for one assistant turn have fired (same tick),
   * surface them together as one `tool_calls` boundary.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (this.currentBatch.length === 0) return;
      const calls = this.currentBatch.map((c) => ({ callId: c.callId, name: c.name, args: c.args }));
      this.currentBatch = [];
      this.boundary.resolve({ kind: "tool_calls", calls });
    });
  }

  /** Drive the SDK message stream, resolving boundaries on result/error. */
  private async run(): Promise<void> {
    try {
      for await (const msg of this.query) {
        if (msg.type === "assistant" && (msg as any).error) {
          this.finished = true;
          this.boundary.resolve({ kind: "error", message: String((msg as any).error) });
          return;
        }
        if (msg.type === "result") {
          this.finished = true;
          if (msg.subtype === "success") {
            this.boundary.resolve({ kind: "final", text: msg.result });
          } else {
            const errs = (msg as any).errors;
            this.boundary.resolve({
              kind: "error",
              message: Array.isArray(errs) ? errs.join("; ") : msg.subtype,
            });
          }
          return;
        }
      }
      if (!this.finished) {
        this.finished = true;
        this.boundary.resolve({ kind: "final", text: "" });
      }
    } catch (err) {
      this.finished = true;
      this.boundary.resolve({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Resume the loop by feeding tool results back to the suspended handlers. */
  provideResults(results: { tool_call_id: string; content: string }[]): Promise<Boundary> {
    this.boundary = deferred<Boundary>();
    for (const r of results) {
      const call = this.pendingByCallId.get(r.tool_call_id);
      if (call) {
        this.pendingByCallId.delete(r.tool_call_id);
        call.resolve(r.content);
      }
    }
    return this.boundary.promise;
  }

  /** True if we still hold the suspended handler this result is for. */
  knowsCall(toolCallId: string): boolean {
    return this.pendingByCallId.has(toolCallId);
  }

  dispose(): void {
    // A finished query has nothing to interrupt — calling interrupt() on it
    // rejects against a closed transport. Only interrupt live sessions, and
    // swallow the async rejection either way.
    if (this.finished) return;
    try {
      const p = this.query?.interrupt?.();
      if (p && typeof (p as Promise<unknown>).then === "function") {
        (p as Promise<unknown>).catch(() => {});
      }
    } catch {
      /* best effort */
    }
  }
}

async function* singleUserMessage(text: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  } as unknown as SDKUserMessage;
}

/** Parse our `<sessionId>__<n>` call ids back to a session id. */
export function sessionIdFromCallId(callId: string): string | null {
  const i = callId.lastIndexOf("__");
  return i > 0 ? callId.slice(0, i) : null;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  create(): Session {
    const id = `s_${randomId()}`;
    const s = new Session(id);
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): void {
    this.sessions.get(id)?.dispose();
    this.sessions.delete(id);
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
