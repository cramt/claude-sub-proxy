// The Agent SDK can surface stray promise rejections (e.g. transport teardown).
// Keep the proxy alive rather than letting one crash the process mid-request.
export default defineNitroPlugin(() => {
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason instanceof Error ? reason.message : reason);
  });
});
