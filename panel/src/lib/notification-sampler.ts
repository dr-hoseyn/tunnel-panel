import { prisma } from "@/lib/db";
import { notify } from "@/lib/notifications";
import { Severity } from "@/generated/prisma/enums";

/**
 * Server-side background poller, independent of health-sampler.ts: every
 * ~20s it scans recently-created Event rows for the ones that are actually
 * worth interrupting a human for (see shouldNotify below) and converts each
 * into a Notification -- keyed off Notification.sourceEventId (unique in the
 * schema) so a cycle re-scanning the same Event never creates a duplicate.
 * It also derives one signal Event doesn't carry at all: a server whose
 * lastSeenAt has gone stale, i.e. it stopped answering health-sampler's own
 * pings.
 *
 * Deliberately its own poller rather than a hook inside health-sampler.ts /
 * tunnel-orchestrator.ts / deploy-queue.ts -- those already write the Event
 * rows this reads, and re-deriving from that shared log keeps this module
 * decoupled from (and safe to ship alongside concurrent changes to) any of
 * them.
 */

const SAMPLE_INTERVAL_MS = 20_000;

// Only Event rows created within this window are even considered each
// cycle -- old enough that a slow first cycle after a cold start won't miss
// anything reasonable, small enough that this never scans the whole table.
const EVENT_LOOKBACK_MS = 10 * 60 * 1000;

// A server is considered offline once it's gone this long without a
// successful health-sampler ping (which happens every 15s) -- a few missed
// cycles, not a single blip.
const SERVER_STALE_MS = 90_000;

// Event types worth surfacing as a Notification even when their own
// severity isn't ERROR: TOKEN_ROTATED is INFO but security-relevant,
// TUNNEL_AUTO_RESTART and TUNNEL_DELETE_CLEANUP_INCOMPLETE are WARNING but
// actionable. Every ERROR-severity Event qualifies regardless of type --
// see shouldNotify.
const NOTIFY_TYPES = new Set<string>(["TOKEN_ROTATED", "TUNNEL_AUTO_RESTART", "TUNNEL_DELETE_CLEANUP_INCOMPLETE"]);

const TITLES: Record<string, string> = {
  TUNNEL_HEALTH_FAILED: "Tunnel health check failed",
  TUNNEL_AUTO_RESTART: "Tunnel auto-restarted",
  TUNNEL_DEPLOY_FAILED: "Tunnel deploy failed",
  TUNNEL_DEPLOY_TIMED_OUT: "Tunnel deploy timed out",
  TUNNEL_DELETE_CLEANUP_INCOMPLETE: "Tunnel cleanup incomplete",
  TOKEN_ROTATED: "Agent token rotated",
  SERVER_OFFLINE: "Server unreachable",
};

function titleFor(type: string): string {
  return TITLES[type] ?? type.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/** Exported so unit tests can exercise the classification rule without
 * spinning up a fake Prisma client for it. */
export function shouldNotify(event: { severity: Severity | string; type: string }): boolean {
  return event.severity === Severity.ERROR || NOTIFY_TYPES.has(event.type);
}

let started = false;

/** Idempotent for the same reason startHealthSampler() is: Next.js dev mode
 * can invoke instrumentation.ts's register() more than once across hot
 * reloads, and a second call here must not stack a second interval. */
export function startNotificationSampler(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    runNotificationSampleCycle().catch((err) => console.error("[notification-sampler] cycle failed:", err));
  }, SAMPLE_INTERVAL_MS);
}

/** Exported for tests -- startNotificationSampler wraps this in a
 * setInterval for production use; tests drive it directly. */
export async function runNotificationSampleCycle(): Promise<void> {
  await deriveFromEvents();
  await deriveServerOffline();
}

async function deriveFromEvents(): Promise<void> {
  const since = new Date(Date.now() - EVENT_LOOKBACK_MS);
  const candidates = await prisma.event.findMany({ where: { createdAt: { gte: since } } });
  const worthy = candidates.filter(shouldNotify);
  if (worthy.length === 0) return;

  // Pre-filter against Notifications already converted from these Events,
  // rather than relying solely on catching the unique-constraint violation
  // per insert -- fewer round trips, and notify() still swallows the
  // violation too as a defense-in-depth backstop (e.g. a concurrent cycle).
  const already = await prisma.notification.findMany({
    where: { sourceEventId: { in: worthy.map((e) => e.id) } },
    select: { sourceEventId: true },
  });
  const alreadyConverted = new Set(already.map((n) => n.sourceEventId));

  for (const event of worthy) {
    if (alreadyConverted.has(event.id)) continue;
    await notify({
      type: event.type,
      severity: event.severity as Severity,
      title: titleFor(event.type),
      message: event.message,
      sourceEventId: event.id,
      serverId: event.serverId,
      tunnelId: event.tunnelId,
    });
  }
}

// Per-process memory of which servers are currently in an already-notified
// offline streak -- mirrors health-sampler.ts's own in-memory `state` Map
// for the analogous "don't re-act every single cycle" problem. Cleared the
// moment a server's lastSeenAt looks fresh again, so the *next* outage still
// raises a fresh notification.
const offlineNotified = new Set<string>();

async function deriveServerOffline(): Promise<void> {
  const cutoff = new Date(Date.now() - SERVER_STALE_MS);
  const servers = await prisma.server.findMany({ select: { id: true, name: true, lastSeenAt: true } });

  const staleNow = new Set<string>();
  for (const server of servers) {
    const stale = !server.lastSeenAt || server.lastSeenAt < cutoff;
    if (!stale) continue;
    staleNow.add(server.id);
    if (offlineNotified.has(server.id)) continue;
    offlineNotified.add(server.id);

    await notify({
      type: "SERVER_OFFLINE",
      severity: Severity.ERROR,
      title: titleFor("SERVER_OFFLINE"),
      message: `Server "${server.name}" has not responded to health checks ${
        server.lastSeenAt ? `since ${server.lastSeenAt.toLocaleString()}` : "since it was added"
      }.`,
      // Not tied to a real Event row, so there's no natural id to dedupe on
      // the way deriveFromEvents() does -- the offlineNotified guard above
      // is what actually prevents duplicates; this is just unique enough to
      // satisfy the column without colliding across servers/incidents.
      sourceEventId: `server-offline:${server.id}:${Date.now()}`,
      serverId: server.id,
    });
  }

  for (const id of Array.from(offlineNotified)) {
    if (!staleNow.has(id)) offlineNotified.delete(id);
  }
}
