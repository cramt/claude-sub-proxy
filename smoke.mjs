const BASE = `http://127.0.0.1:${process.env.PORT ?? 8799}`;

async function chat(body) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

const MODEL = process.env.DEFAULT_MODEL ?? "claude-haiku-4-5";

// 1) plain completion
const a = await chat({ model: MODEL, messages: [{ role: "user", content: "Reply with exactly: PONG" }] });
console.log("[plain] finish=", a.choices[0].finish_reason, "content=", JSON.stringify(a.choices[0].message.content));

// 2) tool round-trip
const tools = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
}];
const msgs = [{ role: "user", content: "Use the get_weather tool to check the weather in Paris, then tell me in one short sentence." }];
const b = await chat({ model: MODEL, tools, messages: msgs });
console.log("[tool] finish=", b.choices[0].finish_reason);
const tc = b.choices[0].message.tool_calls?.[0];
console.log("[tool] call=", tc ? `${tc.function.name}(${tc.function.arguments}) id=${tc.id}` : "NONE");

if (tc) {
  // 3) continuation with a tool result
  const c = await chat({
    model: MODEL,
    tools,
    messages: [
      ...msgs,
      { role: "assistant", content: null, tool_calls: b.choices[0].message.tool_calls },
      { role: "tool", tool_call_id: tc.id, content: "18°C, clear skies" },
    ],
  });
  console.log("[resume] finish=", c.choices[0].finish_reason, "content=", JSON.stringify(c.choices[0].message.content));
}
