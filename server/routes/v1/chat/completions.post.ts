import {
  processChatCompletion,
  completionJson,
  writeStreaming,
  manager,
  isAuthorized,
} from "../../../lib/proxy";

export default defineEventHandler(async (event) => {
  if (!isAuthorized(getHeader(event, "authorization"))) {
    setResponseStatus(event, 401);
    return { error: { message: "unauthorized" } };
  }

  const body = await readBody(event);
  if (!body || !Array.isArray(body.messages)) {
    setResponseStatus(event, 400);
    return { error: { message: "messages[] required" } };
  }

  const { boundary, sessionId, model } = await processChatCompletion(body);

  if (boundary.kind === "error") {
    manager.remove(sessionId);
    setResponseStatus(event, 502);
    return { error: { message: boundary.message, type: "upstream_error" } };
  }
  if (boundary.kind === "final") manager.remove(sessionId);

  if (body.stream) {
    // Write the SSE stream straight to the node response and end it; returning
    // undefined leaves the already-sent response untouched.
    writeStreaming(event.node.res, model, boundary);
    return;
  }
  return completionJson(model, boundary);
});
