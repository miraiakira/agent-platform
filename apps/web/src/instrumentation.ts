export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initTelemetry, shutdownTelemetry } = await import("@eap/observability");
    initTelemetry({ service: "eap-web" });
    // Observe shutdown without replacing Next's own handlers or calling exit().
    const globals = globalThis as typeof globalThis & { __eapTelemetryShutdownHook?: boolean };
    if (!globals.__eapTelemetryShutdownHook) {
      globals.__eapTelemetryShutdownHook = true;
      for (const event of ["beforeExit", "SIGTERM", "SIGINT"] as const) {
        process.once(event, () => { void shutdownTelemetry(); });
      }
    }
  }
}
