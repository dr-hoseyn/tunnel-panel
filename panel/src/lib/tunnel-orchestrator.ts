import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { agentPost, agentGet, agentDelete, type AgentTarget } from "@/lib/agent-client";
import { getCoreDescriptor, type CoreDescriptor } from "@/lib/cores/registry";
import { DeploymentQueue, type JobContext } from "@/lib/deploy-queue";
import type { Prisma } from "@/generated/prisma/client";
import {
  DeploymentKind,
  EventCategory,
  Severity,
  TunnelCore,
  TunnelStatus,
} from "@/generated/prisma/enums";

/**
 * Sequences tunnel lifecycle operations across the two agents a tunnel
 * spans. Deliberately core-agnostic: every branch here reads from the core
 * registry (portsOn, agentCore) rather than switching on TunnelCore --
 * adding a future core never touches this file, only cores/registry.ts and
 * the agent's own driver.
 */

export class OrchestratorError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

interface PortMappingInput {
  remote: number;
  local: number;
}

export interface CreateTunnelInput {
  name: string;
  core: TunnelCore;
  sourceServerId: string;
  destServerId: string;
  port: number;
  ports?: PortMappingInput[];
  extra?: Record<string, string | undefined>;
  createdById?: string;
}

interface ResolvedTarget {
  target: AgentTarget;
  name: string;
  host: string;
}

async function resolveServer(serverId: string): Promise<ResolvedTarget> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) {
    throw new OrchestratorError(`server ${serverId} not found`, 404);
  }
  return {
    target: {
      host: server.host,
      port: server.agentPort,
      token: decryptSecret(server.agentTokenEnc),
      tlsFingerprint: server.tlsFingerprint,
    },
    name: server.name,
    host: server.host,
  };
}

function buildCreateBody(
  descriptor: CoreDescriptor,
  role: "server" | "client",
  tunnelId: string,
  secret: string,
  port: number,
  peer: string | undefined,
  ports: PortMappingInput[] | undefined,
  extra: Record<string, string | undefined> | undefined,
) {
  const includePorts = descriptor.portsOn === "both" || descriptor.portsOn === role;
  return {
    id: tunnelId,
    core: descriptor.agentCore,
    role,
    port: role === "server" ? port : 0,
    peer: role === "client" ? peer : undefined,
    secret,
    ports: includePorts ? (ports ?? []).map((p) => ({ remote: p.remote, local: p.local })) : undefined,
    extra,
  };
}

export async function createTunnel(input: CreateTunnelInput) {
  const descriptor = getCoreDescriptor(input.core);
  if (input.sourceServerId === input.destServerId) {
    throw new OrchestratorError("source and destination must be different servers");
  }

  const secret = crypto.randomBytes(32).toString("hex");
  const tunnel = await prisma.tunnel.create({
    data: {
      name: input.name,
      core: input.core,
      sourceServerId: input.sourceServerId,
      destServerId: input.destServerId,
      config: { port: input.port, ports: input.ports ?? [], extra: input.extra ?? {} } as unknown as Prisma.InputJsonValue,
      secretEnc: encryptSecret(secret),
      status: TunnelStatus.DEPLOYING,
      createdById: input.createdById,
    },
  });

  const deploymentId = await DeploymentQueue.enqueue({
    tunnelId: tunnel.id,
    kind: DeploymentKind.CREATE,
    // deployBothSides guarantees a terminal tunnel status itself (RUNNING or
    // FAILED, never left at DEPLOYING) and does its own rollback -- the
    // queue's generic retry-the-whole-handler mechanism must not run a
    // second time on top of that, or it would re-attempt a deploy sequence
    // against a tunnel that's already been rolled back once.
    maxAttempts: 1,
    handler: (ctx) => deployBothSides(ctx, tunnel.id, descriptor, input, secret),
  });

  return { tunnel, deploymentId };
}

/** Re-runs the full two-sided deploy for an existing FAILED tunnel, reusing
 * its already-stored config and secret -- the "Retry" action on a failed
 * tunnel's detail page. Both sides are re-created from scratch (the agent's
 * create endpoint is safe to call again once the failed attempt has been
 * rolled back, since the tunnel id won't already exist on either agent). */
export async function retryTunnelDeploy(tunnelId: string): Promise<{ deploymentId: string }> {
  const tunnel = await loadTunnelOrThrow(tunnelId);
  if (tunnel.status !== TunnelStatus.FAILED) {
    throw new OrchestratorError("only a failed tunnel can be retried", 409);
  }
  const descriptor = getCoreDescriptor(tunnel.core);
  const config = tunnel.config as unknown as { port: number; ports?: PortMappingInput[]; extra?: Record<string, string> };
  const secret = decryptSecret(tunnel.secretEnc);

  await prisma.tunnel.update({ where: { id: tunnelId }, data: { status: TunnelStatus.DEPLOYING } });

  const input: CreateTunnelInput = {
    name: tunnel.name,
    core: tunnel.core,
    sourceServerId: tunnel.sourceServerId,
    destServerId: tunnel.destServerId,
    port: config.port,
    ports: config.ports,
    extra: config.extra,
  };

  const deploymentId = await DeploymentQueue.enqueue({
    tunnelId,
    kind: DeploymentKind.CREATE,
    maxAttempts: 1,
    handler: (ctx) => deployBothSides(ctx, tunnelId, descriptor, input, secret),
  });
  return { deploymentId };
}

/** Marks a tunnel FAILED (never leaves it hanging at DEPLOYING) and records
 * exactly why -- both as a queryable Event and as the error the caller
 * re-throws, which the deployment queue's own catch already records into
 * that Deployment's `steps`. */
async function failDeployment(tunnelId: string, tunnelName: string, reason: string, serverId?: string): Promise<void> {
  await prisma.tunnel.update({ where: { id: tunnelId }, data: { status: TunnelStatus.FAILED, lastCheckedAt: new Date() } });
  await prisma.event.create({
    data: {
      category: EventCategory.DEPLOYMENT,
      type: "TUNNEL_DEPLOY_FAILED",
      severity: Severity.ERROR,
      message: `Tunnel "${tunnelName}" failed to deploy: ${reason}`,
      tunnelId,
      serverId,
    },
  });
}

/** Human-readable labels for the real stage names the agent reports via
 * GET /api/v1/managed-tunnels/{id}/progress (see agent/internal/tunnels/
 * progress.go and deployTunnel in agent/internal/server/tunnel_handlers.go
 * -- these strings must match the `step` values that code actually emits). */
const STEP_LABELS: Record<string, string> = {
  install_binary: "Installing Binary",
  write_config: "Writing Config",
  create_service: "Creating Service",
  configure_firewall: "Opening Firewall",
  start_service: "Starting Service",
  health_check: "Checking Health",
  complete: "Deployment Complete",
};

interface AgentProgressStep {
  step: string;
  status: "running" | "ok" | "failed";
  message?: string;
}

/** POSTs a create-tunnel request to one agent while concurrently polling
 * that same agent's real-time progress endpoint on a separate connection,
 * relaying each genuine stage transition (install/write-config/create-
 * service/open-firewall/start/health-check) into ctx.step() as it actually
 * happens -- not a simulated breakdown of one opaque call. The POST itself
 * is the source of truth for success/failure; polling is purely for
 * visibility and any polling error is swallowed (best-effort) rather than
 * failing the deploy over a missed progress update. */
async function agentPostWithProgress(
  target: AgentTarget,
  path: string,
  body: unknown,
  tunnelId: string,
  sideLabel: string,
  ctx: JobContext,
): Promise<string> {
  const seen = new Set<string>();

  const relayNewSteps = async () => {
    try {
      const raw = await agentGet(target, `/api/v1/managed-tunnels/${tunnelId}/progress`);
      const data = JSON.parse(raw) as { steps: AgentProgressStep[] };
      for (const s of data.steps) {
        const key = `${s.step}:${s.status}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const label = `${sideLabel}: ${STEP_LABELS[s.step] ?? s.step}`;
        const status = s.status === "running" ? "started" : s.status === "ok" ? "ok" : "failed";
        await ctx.step(label, status, s.message);
      }
    } catch {
      // Best-effort -- a transient poll failure just means one intermediate
      // update is missed; the outer deploy-or-fail result is unaffected.
    }
  };

  let polling = true;
  const pollLoop = (async () => {
    while (polling) {
      await relayNewSteps();
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  })();

  try {
    return await agentPost(target, path, body);
  } finally {
    polling = false;
    await pollLoop;
    await relayNewSteps(); // catch any steps that landed between the last poll and the request resolving
  }
}

async function deployBothSides(
  ctx: JobContext,
  tunnelId: string,
  descriptor: CoreDescriptor,
  input: CreateTunnelInput,
  secret: string,
) {
  // Every exit from this function must leave the tunnel at a terminal
  // status (RUNNING or FAILED) -- never DEPLOYING. Whatever fails, however
  // far it got, is caught here in one place rather than relying on each
  // step to remember to update tunnel status on its own failure path (that
  // per-step discipline is exactly what silently regressed once: the
  // source-side deploy call had no try/catch of its own at all, so a
  // failure there propagated straight past every status update and left
  // the tunnel stuck at DEPLOYING forever with only the Deployment row --
  // not the Tunnel itself -- ever marked FAILED).
  let source: ResolvedTarget;
  let dest: ResolvedTarget;
  try {
    source = await resolveServer(input.sourceServerId);
    dest = await resolveServer(input.destServerId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.step("resolve-servers", "failed", message);
    await failDeployment(tunnelId, input.name, `could not resolve source/destination server: ${message}`);
    throw err;
  }

  let sourceDeployed = false;
  try {
    // Source plays the driver's "server" role (see registry.ts's header
    // comment for the source=server/destination=client convention) --
    // deploy it first so something is already listening before the
    // destination's client role tries to dial in.
    await agentPostWithProgress(
      source.target,
      "/api/v1/managed-tunnels",
      buildCreateBody(descriptor, "server", tunnelId, secret, input.port, undefined, input.ports, input.extra),
      tunnelId,
      `Source (${source.name})`,
      ctx,
    );
    sourceDeployed = true;

    await agentPostWithProgress(
      dest.target,
      "/api/v1/managed-tunnels",
      buildCreateBody(
        descriptor,
        "client",
        tunnelId,
        secret,
        input.port,
        `${source.host}:${input.port}`,
        input.ports,
        input.extra,
      ),
      tunnelId,
      `Destination (${dest.name})`,
      ctx,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (sourceDeployed) {
      await ctx.step("rollback", "started", "removing the side that already deployed");
      try {
        await agentDelete(source.target, `/api/v1/managed-tunnels/${tunnelId}`);
        await ctx.step("rollback", "ok");
      } catch (rollbackErr) {
        await ctx.step(
          "rollback",
          "failed",
          `could not remove the source side either: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
        );
      }
    }
    await failDeployment(
      tunnelId,
      input.name,
      sourceDeployed ? `destination (${dest.name}) failed, rolled back on ${source.name}: ${message}` : `source (${source.name}) failed: ${message}`,
      sourceDeployed ? input.destServerId : input.sourceServerId,
    );
    throw err;
  }

  await prisma.tunnel.update({
    where: { id: tunnelId },
    data: { status: TunnelStatus.RUNNING, lastCheckedAt: new Date() },
  });
  await prisma.event.create({
    data: {
      category: EventCategory.DEPLOYMENT,
      type: "TUNNEL_CREATED",
      severity: Severity.INFO,
      message: `Tunnel "${input.name}" (${descriptor.label}) deployed between ${source.name} and ${dest.name}.`,
      tunnelId,
    },
  });
}

async function bothTargets(tunnel: { sourceServerId: string; destServerId: string }) {
  const [source, dest] = await Promise.all([
    resolveServer(tunnel.sourceServerId),
    resolveServer(tunnel.destServerId),
  ]);
  return { source, dest };
}

async function loadTunnelOrThrow(tunnelId: string) {
  const tunnel = await prisma.tunnel.findUnique({ where: { id: tunnelId } });
  if (!tunnel) throw new OrchestratorError("tunnel not found", 404);
  return tunnel;
}

async function simpleAction(
  tunnelId: string,
  kind: DeploymentKind,
  action: "start" | "stop" | "restart",
): Promise<{ deploymentId: string }> {
  const tunnel = await loadTunnelOrThrow(tunnelId);

  const deploymentId = await DeploymentQueue.enqueue({
    tunnelId,
    kind,
    handler: async (ctx) => {
      // Same guarantee as deployBothSides: whatever fails, however far it
      // got, the tunnel must end at a terminal status -- not left at
      // whatever it was before, which the UI (optimistically showing
      // "pending") would otherwise never learn had actually failed.
      try {
        const { source, dest } = await bothTargets(tunnel);
        for (const side of [source, dest]) {
          await ctx.step(`${action}-${side.name}`, "started");
          await agentPost(side.target, `/api/v1/managed-tunnels/${tunnelId}/${action}`);
          await ctx.step(`${action}-${side.name}`, "ok");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.step(action, "failed", message);
        await failDeployment(tunnelId, tunnel.name, `${action} failed: ${message}`);
        throw err;
      }

      const status: TunnelStatus = action === "stop" ? TunnelStatus.STOPPED : TunnelStatus.RUNNING;
      await prisma.tunnel.update({
        where: { id: tunnelId },
        data: {
          status,
          lastCheckedAt: new Date(),
          ...(action === "restart" ? { lastRestartAt: new Date() } : {}),
        },
      });
      await prisma.event.create({
        data: {
          category: EventCategory.DEPLOYMENT,
          type: `TUNNEL_${action.toUpperCase()}`,
          severity: Severity.INFO,
          message: `Tunnel "${tunnel.name}" ${action}ed.`,
          tunnelId,
        },
      });
    },
  });
  return { deploymentId };
}

export const startTunnel = (tunnelId: string) => simpleAction(tunnelId, DeploymentKind.START, "start");
export const stopTunnel = (tunnelId: string) => simpleAction(tunnelId, DeploymentKind.STOP, "stop");
export const restartTunnel = (tunnelId: string) => simpleAction(tunnelId, DeploymentKind.RESTART, "restart");

export async function deleteTunnel(tunnelId: string): Promise<{ deploymentId: string }> {
  const tunnel = await loadTunnelOrThrow(tunnelId);

  const deploymentId = await DeploymentQueue.enqueue({
    tunnelId,
    kind: DeploymentKind.DELETE,
    handler: async (ctx) => {
      await prisma.tunnel.update({ where: { id: tunnelId }, data: { status: TunnelStatus.REMOVING } });
      const { source, dest } = await bothTargets(tunnel);
      const failedSides: string[] = [];
      for (const side of [source, dest]) {
        await ctx.step(`remove-${side.name}`, "started");
        try {
          await agentDelete(side.target, `/api/v1/managed-tunnels/${tunnelId}`);
          await ctx.step(`remove-${side.name}`, "ok");
        } catch (err) {
          // Best-effort: a side that's already gone (e.g. its server was
          // deregistered, or this agent lost the tunnel out of band) must
          // not block deleting the panel's own record of the tunnel. But
          // "best-effort" must not mean "silent" -- if the agent's own
          // Remove() only got partway (e.g. it stopped the service but
          // couldn't delete the config directory), that side is left with
          // orphaned state the panel no longer has any record of at all
          // once this tunnel row is gone. There's no reconciliation/orphan
          // scan yet (that's a real gap, not fixed here), so a clearly
          // flagged WARNING event -- naming the server -- is the only trace
          // that survives; an operator needs it to know to check that VPS
          // by hand.
          await ctx.step(`remove-${side.name}`, "failed", err instanceof Error ? err.message : String(err));
          failedSides.push(side.name);
        }
      }
      if (failedSides.length > 0) {
        await prisma.event.create({
          data: {
            category: EventCategory.DEPLOYMENT,
            type: "TUNNEL_DELETE_CLEANUP_INCOMPLETE",
            severity: Severity.WARNING,
            message: `Tunnel "${tunnel.name}" was removed from the panel, but cleanup failed on ${failedSides.join(" and ")} -- that server may still have leftover config/service/firewall state for this tunnel. Check it manually.`,
          },
        });
      }
      await prisma.event.create({
        data: {
          category: EventCategory.DEPLOYMENT,
          type: "TUNNEL_DELETED",
          severity: Severity.INFO,
          message: `Tunnel "${tunnel.name}" deleted.`,
        },
      });
      await prisma.tunnel.delete({ where: { id: tunnelId } });
    },
  });
  return { deploymentId };
}
