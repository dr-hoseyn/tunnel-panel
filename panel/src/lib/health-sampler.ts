import { prisma } from "@/lib/db";
import { agentGet } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { restartTunnel } from "@/lib/tunnel-orchestrator";
import { getSettings, type AppSettingsValue } from "@/lib/settings";
import { DeploymentStatus, EventCategory, Severity, TunnelStatus } from "@/generated/prisma/enums";

/**
 * Server-side background poller: health-checks every tunnel via its two
 * agents (interval configurable on the Settings page, ~15s by default),
 * records a TunnelStat sample, and drives real status transitions --
 * independent of anyone having a browser tab open. On two consecutive
 * failures it makes exactly one automatic restart attempt (via the same
 * deployment queue/orchestrator a manual restart uses, unless auto-restart
 * is turned off in Settings) before flagging the tunnel FAILED and giving
 * up, matching the platform's own example log line ("Backhaul tunnel
 * restarted / Reason: Health check failed") without ever looping restarts
 * forever.
 */

interface AgentHealth {
  process: string;
  port_open: boolean;
  traffic_active: boolean;
  rx_bytes: number;
  tx_bytes: number;
  latency_ms?: number;
  has_latency?: boolean;
  connections?: number;
  reconnect_count?: number;
  cpu_percent?: number;
  ram_percent?: number;
  has_proc_stats?: boolean;
  detail?: string;
}

interface TunnelState {
  failures: number;
  restarted: boolean;
  failedLogged: boolean;
}

const state = new Map<string, TunnelState>();
let started = false;
let cycles = 0;

/** Test-only escape hatch -- `cycles` and per-tunnel failure-streak state
 * are module-level and would otherwise leak between test files/cases that
 * share this module within one vitest worker (e.g. retention tests that
 * depend on hitting an exact cycle-count multiple). */
export function __resetHealthSamplerStateForTests(): void {
  state.clear();
  cycles = 0;
}

/** Idempotent: Next.js dev mode can invoke instrumentation.ts's register()
 * more than once across hot reloads -- a second call here must not stack a
 * second interval on top of the first. Self-rescheduling (setTimeout, not
 * setInterval) so a Settings change to the health-check interval takes
 * effect on the very next cycle instead of requiring a process restart. */
export function startHealthSampler(): void {
  if (started) return;
  started = true;
  scheduleNextCycle();
}

function scheduleNextCycle(): void {
  getSettings()
    .then((s) => s.healthCheckIntervalMs)
    .catch(() => DEFAULT_INTERVAL_HINT_MS)
    .then((intervalMs) => {
      setTimeout(() => {
        runSampleCycle()
          .catch((err) => console.error("[health-sampler] cycle failed:", err))
          .finally(scheduleNextCycle);
      }, intervalMs);
    });
}

/** Fallback delay only if getSettings() itself throws (e.g. DB briefly
 * unavailable) -- normal operation always uses the real, current
 * healthCheckIntervalMs setting. */
const DEFAULT_INTERVAL_HINT_MS = 15_000;

/** Exported for tests -- startHealthSampler wraps this in a self-
 * rescheduling timer for production use; tests drive it directly. */
export async function runSampleCycle(): Promise<void> {
  const settings = await getSettings();

  // Server reachability must not depend on that server happening to own a
  // tunnel that's both non-DEPLOYING and gets sampled -- a server with no
  // tunnels, or whose only tunnel is stuck/failed/mid-deploy, would
  // otherwise never get a lastSeenAt update and would show Offline forever
  // even while its agent is perfectly reachable. Pinged independently, every
  // cycle, for every registered server.
  await pingAllServers();

  const tunnels = await prisma.tunnel.findMany({
    where: { status: { notIn: [TunnelStatus.DEPLOYING, TunnelStatus.REMOVING] } },
    include: { sourceServer: true, destServer: true },
  });

  for (const tunnel of tunnels) {
    try {
      await sampleTunnel(tunnel, settings);
    } catch (err) {
      console.error(`[health-sampler] sampling tunnel ${tunnel.id} failed:`, err);
    }
  }

  await sweepStuckDeployments(settings);

  cycles += 1;
  if (cycles % 20 === 0) {
    await prisma.tunnelStat.deleteMany({
      where: { timestamp: { lt: new Date(Date.now() - settings.statRetentionMs) } },
    });
    await prisma.event.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - settings.logRetentionDays * 24 * 60 * 60 * 1000) } },
    });
  }
}

async function pingAllServers(): Promise<void> {
  const servers = await prisma.server.findMany({
    select: { id: true, host: true, agentPort: true, agentTokenEnc: true, tlsFingerprint: true },
  });
  await Promise.all(
    servers.map(async (server) => {
      try {
        await agentGet(
          {
            host: server.host,
            port: server.agentPort,
            token: decryptSecret(server.agentTokenEnc),
            tlsFingerprint: server.tlsFingerprint,
          },
          "/api/v1/agent/info",
        );
        await prisma.server.update({ where: { id: server.id }, data: { lastSeenAt: new Date() } });
      } catch {
        // Unreachable -- leave lastSeenAt as-is, its age is the Offline signal.
      }
    }),
  );
}

/** Defense in depth for the exact bug this was written to catch: a tunnel
 * whose deploy handler threw before ever updating tunnel status (any future
 * code path that repeats that mistake, not just the one already fixed in
 * tunnel-orchestrator.ts). Anything sitting at DEPLOYING/REMOVING for
 * longer than a deploy should ever reasonably take (configurable in
 * Settings), with no deployment of its own still queued or running, gets
 * force-marked FAILED and logged -- never left stuck indefinitely with no
 * way for the UI to act on it. */
async function sweepStuckDeployments(settings: AppSettingsValue): Promise<void> {
  const cutoff = new Date(Date.now() - settings.stuckDeploymentTimeoutMs);
  const stuck = await prisma.tunnel.findMany({
    where: {
      status: { in: [TunnelStatus.DEPLOYING, TunnelStatus.REMOVING] },
      updatedAt: { lt: cutoff },
    },
  });
  for (const tunnel of stuck) {
    const activeDeployment = await prisma.deployment.findFirst({
      where: { tunnelId: tunnel.id, status: { in: [DeploymentStatus.QUEUED, DeploymentStatus.RUNNING] } },
    });
    if (activeDeployment) continue; // genuinely still in flight, not stuck

    await prisma.tunnel.update({
      where: { id: tunnel.id },
      data: { status: TunnelStatus.FAILED, lastCheckedAt: new Date() },
    });
    await logEvent(
      tunnel.id,
      Severity.ERROR,
      "TUNNEL_DEPLOY_TIMED_OUT",
      `Tunnel "${tunnel.name}" sat at ${tunnel.status} for over ${settings.stuckDeploymentTimeoutMs / 60000} minutes with no deployment in progress -- forced to FAILED so it can be retried or deleted.`,
    );
  }
}

async function fetchHealth(
  server: { host: string; agentPort: number; agentTokenEnc: string; tlsFingerprint: string },
  tunnelId: string,
): Promise<AgentHealth | null> {
  try {
    const body = await agentGet(
      {
        host: server.host,
        port: server.agentPort,
        token: decryptSecret(server.agentTokenEnc),
        tlsFingerprint: server.tlsFingerprint,
      },
      `/api/v1/managed-tunnels/${tunnelId}/health`,
    );
    return JSON.parse(body) as AgentHealth;
  } catch {
    return null;
  }
}

function isSideHealthy(h: AgentHealth | null): boolean {
  return h !== null && h.process === "running";
}

/** Combines both sides' real, agent-measured signals into the single
 * TunnelStat row recorded per sample. Latency/CPU/RAM are averaged across
 * whichever side(s) actually reported a value (a tunnel with an
 * unreachable side shouldn't silently show 0ms latency); connections and
 * reconnect count are summed, since they're genuinely two independent
 * processes' counters. Never fabricates a number for a side with no data --
 * an all-null pair of sides yields null, not 0. */
function aggregateHealthStats(sourceHealth: AgentHealth | null, destHealth: AgentHealth | null) {
  const latencies = [sourceHealth, destHealth]
    .filter((h): h is AgentHealth => !!h?.has_latency)
    .map((h) => h.latency_ms!);
  const procStats = [sourceHealth, destHealth].filter((h): h is AgentHealth => !!h?.has_proc_stats);

  return {
    latencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    connections: (sourceHealth?.connections ?? 0) + (destHealth?.connections ?? 0),
    reconnectCount: (sourceHealth?.reconnect_count ?? 0) + (destHealth?.reconnect_count ?? 0),
    cpuPercent: procStats.length > 0 ? procStats.reduce((a, h) => a + (h.cpu_percent ?? 0), 0) / procStats.length : null,
    ramPercent: procStats.length > 0 ? procStats.reduce((a, h) => a + (h.ram_percent ?? 0), 0) / procStats.length : null,
  };
}

type TunnelWithServers = Awaited<ReturnType<typeof prisma.tunnel.findMany>>[number] & {
  sourceServer: { host: string; agentPort: number; agentTokenEnc: string; tlsFingerprint: string };
  destServer: { host: string; agentPort: number; agentTokenEnc: string; tlsFingerprint: string };
};

async function sampleTunnel(tunnel: TunnelWithServers, settings: AppSettingsValue): Promise<void> {
  const [sourceHealth, destHealth] = await Promise.all([
    fetchHealth(tunnel.sourceServer, tunnel.id),
    fetchHealth(tunnel.destServer, tunnel.id),
  ]);

  const agg = aggregateHealthStats(sourceHealth, destHealth);
  await prisma.tunnelStat.create({
    data: {
      tunnelId: tunnel.id,
      rxBytes: BigInt(Math.max(0, Math.round((sourceHealth?.rx_bytes ?? 0) + (destHealth?.rx_bytes ?? 0)))),
      txBytes: BigInt(Math.max(0, Math.round((sourceHealth?.tx_bytes ?? 0) + (destHealth?.tx_bytes ?? 0)))),
      latencyMs: agg.latencyMs,
      connections: agg.connections,
      reconnectCount: agg.reconnectCount,
      cpuPercent: agg.cpuPercent,
      ramPercent: agg.ramPercent,
    },
  });

  // A successful health call reaches the agent regardless of the tunnel's
  // own health, so it's a reasonable "this server is online" signal too --
  // the Dashboard/Servers pages use lastSeenAt for that without needing
  // their own separate reachability polling.
  const now = new Date();
  if (sourceHealth) await prisma.server.update({ where: { id: tunnel.sourceServerId }, data: { lastSeenAt: now } });
  if (destHealth) await prisma.server.update({ where: { id: tunnel.destServerId }, data: { lastSeenAt: now } });

  const healthy = isSideHealthy(sourceHealth) && isSideHealthy(destHealth);
  const s = state.get(tunnel.id) ?? { failures: 0, restarted: false, failedLogged: false };

  if (healthy) {
    if (tunnel.status !== TunnelStatus.RUNNING) {
      await prisma.tunnel.update({
        where: { id: tunnel.id },
        data: { status: TunnelStatus.RUNNING, lastCheckedAt: new Date() },
      });
    } else {
      await prisma.tunnel.update({ where: { id: tunnel.id }, data: { lastCheckedAt: new Date() } });
    }
    if (s.failures > 0) state.delete(tunnel.id);
    return;
  }

  s.failures += 1;
  state.set(tunnel.id, s);

  if (s.failures === 1) {
    await prisma.tunnel.update({
      where: { id: tunnel.id },
      data: { status: TunnelStatus.WARNING, lastCheckedAt: new Date() },
    });
    await logEvent(
      tunnel.id,
      Severity.WARNING,
      "TUNNEL_HEALTH_WARNING",
      `Health check failed for tunnel "${tunnel.name}". Source: ${sourceHealth?.detail ?? "unreachable"}. Destination: ${destHealth?.detail ?? "unreachable"}.`,
    );
    return;
  }

  if (settings.autoRestartEnabled && s.failures === 2 && !s.restarted) {
    s.restarted = true;
    await logEvent(
      tunnel.id,
      Severity.WARNING,
      "TUNNEL_AUTO_RESTART",
      `Tunnel "${tunnel.name}" failed 2 consecutive health checks -- attempting one automatic restart.`,
    );
    try {
      await restartTunnel(tunnel.id);
    } catch (err) {
      console.error(`[health-sampler] auto-restart failed for tunnel ${tunnel.id}:`, err);
    }
    return; // give the restart a cycle to take effect before judging again
  }

  await prisma.tunnel.update({
    where: { id: tunnel.id },
    data: { status: TunnelStatus.FAILED, lastCheckedAt: new Date() },
  });
  // Logged exactly once per failure streak (not every cycle it stays
  // FAILED) -- the message differs depending on whether auto-restart was
  // ever attempted, since "after an automatic restart" would be misleading
  // when the setting is off and none was.
  if (!s.failedLogged) {
    s.failedLogged = true;
    await logEvent(
      tunnel.id,
      Severity.ERROR,
      "TUNNEL_HEALTH_FAILED",
      s.restarted
        ? `Tunnel "${tunnel.name}" is still failing health checks after an automatic restart -- flagged FAILED and will not be auto-restarted again.`
        : `Tunnel "${tunnel.name}" is failing health checks -- flagged FAILED. Auto-restart is disabled in Settings.`,
    );
  }
}

async function logEvent(tunnelId: string, severity: Severity, type: string, message: string): Promise<void> {
  await prisma.event.create({
    data: { category: EventCategory.RUNTIME, severity, type, message, tunnelId },
  });
}
