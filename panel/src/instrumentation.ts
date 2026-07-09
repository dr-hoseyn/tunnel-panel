/**
 * Next.js instrumentation hook: register() runs once when the server
 * process starts, in whichever runtime Next.js loads this file for. Only
 * the Node runtime can use Prisma/the agent client (see auth.config.ts's
 * own comment on why Edge code stays Prisma-free), so the health sampler
 * import is gated behind that check and kept dynamic so it's never even
 * pulled into an Edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { startHealthSampler } = await import("@/lib/health-sampler");
  startHealthSampler();
  const { startNotificationSampler } = await import("@/lib/notification-sampler");
  startNotificationSampler();
}
