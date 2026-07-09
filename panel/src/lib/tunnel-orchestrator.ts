import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { agentPost, agentDelete, type AgentTarget } from "@/lib/agent-client";
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
    // deployBothSides already does its own rollback (removing the source
    // side and deleting the Tunnel row) when the destination fails -- the
    // queue's generic retry-the-whole-handler mechanism must not run a
    // second time after that, or it would try to delete an already-deleted
    // Tunnel row and re-attempt a deploy sequence that isn't idempotent.
    maxAttempts: 1,
    handler: (ctx) => deployBothSides(ctx, tunnel.id, descriptor, input, secret),
  });

  return { tunnel, deploymentId };
}

async function deployBothSides(
  ctx: JobContext,
  tunnelId: string,
  descriptor: CoreDescriptor,
  input: CreateTunnelInput,
  secret: string,
) {
  const source = await resolveServer(input.sourceServerId);
  const dest = await resolveServer(input.destServerId);

  // Source plays the driver's "server" role (see registry.ts's header
  // comment for the source=server/destination=client convention) -- deploy
  // it first so something is already listening before the destination's
  // client role tries to dial in.
  await ctx.step(`deploy-source-${source.name}`, "started");
  await agentPost(
    source.target,
    "/api/v1/managed-tunnels",
    buildCreateBody(descriptor, "server", tunnelId, secret, input.port, undefined, input.ports, input.extra),
  );
  await ctx.step(`deploy-source-${source.name}`, "ok");

  try {
    await ctx.step(`deploy-destination-${dest.name}`, "started");
    await agentPost(
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
    );
    await ctx.step(`deploy-destination-${dest.name}`, "ok");
  } catch (err) {
    await ctx.step("rollback", "started", "destination side failed to deploy -- removing source side");
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
    await prisma.event.create({
      data: {
        category: EventCategory.DEPLOYMENT,
        type: "TUNNEL_CREATE_ROLLED_BACK",
        severity: Severity.ERROR,
        message: `Tunnel "${input.name}" failed to deploy on ${dest.name} -- rolled back on ${source.name}: ${err instanceof Error ? err.message : String(err)}`,
        serverId: input.destServerId,
      },
    });
    await prisma.tunnel.delete({ where: { id: tunnelId } });
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
      const { source, dest } = await bothTargets(tunnel);
      for (const side of [source, dest]) {
        await ctx.step(`${action}-${side.name}`, "started");
        await agentPost(side.target, `/api/v1/managed-tunnels/${tunnelId}/${action}`);
        await ctx.step(`${action}-${side.name}`, "ok");
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
      for (const side of [source, dest]) {
        await ctx.step(`remove-${side.name}`, "started");
        try {
          await agentDelete(side.target, `/api/v1/managed-tunnels/${tunnelId}`);
          await ctx.step(`remove-${side.name}`, "ok");
        } catch (err) {
          // Best-effort: a side that's already gone (e.g. its server was
          // deregistered, or this agent lost the tunnel out of band) must
          // not block deleting the panel's own record of the tunnel.
          await ctx.step(`remove-${side.name}`, "failed", err instanceof Error ? err.message : String(err));
        }
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
