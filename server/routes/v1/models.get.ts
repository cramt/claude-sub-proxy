import { STATIC_MODELS, isAuthorized } from "../../lib/proxy";

export default defineEventHandler((event) => {
  if (!isAuthorized(getHeader(event, "authorization"))) {
    setResponseStatus(event, 401);
    return { error: { message: "unauthorized" } };
  }
  return {
    object: "list",
    data: STATIC_MODELS.map((m) => ({ id: m, object: "model", created: 0, owned_by: "anthropic" })),
  };
});
