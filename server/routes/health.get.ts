import { ALLOW_API_KEY } from "../lib/proxy";

export default defineEventHandler(() => ({
  status: "ok",
  billing: ALLOW_API_KEY ? "api_key_allowed" : "subscription_only",
}));
