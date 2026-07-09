import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createTunnel, OrchestratorError } from "@/lib/tunnel-orchestrator";
import { listCoreDescriptors } from "@/lib/cores/registry";
import { requireRoleResponse } from "@/lib/rbac";

export async function GET() {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const tunnels = await prisma.tunnel.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      sourceServer: { select: { id: true, name: true } },
      destServer: { select: { id: true, name: true } },
    },
  });
  return NextResponse.json({ tunnels });
}

const coreValues = listCoreDescriptors().map((d) => d.core) as [string, ...string[]];

const portMappingSchema = z.object({
  remote: z.number().int().min(1).max(65535),
  local: z.number().int().min(1).max(65535),
});

const createTunnelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  core: z.enum(coreValues),
  sourceServerId: z.string().min(1),
  destServerId: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  ports: z.array(portMappingSchema).optional(),
  extra: z.record(z.string(), z.string().optional()).optional(),
});

export async function POST(request: Request) {
  const auth = await requireRoleResponse("OPERATOR");
  if ("response" in auth) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = createTunnelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  try {
    const { tunnel, deploymentId } = await createTunnel({
      ...parsed.data,
      core: parsed.data.core as never,
      createdById: auth.session.user?.id,
    });
    return NextResponse.json({ tunnel, deploymentId }, { status: 202 });
  } catch (err) {
    if (err instanceof OrchestratorError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
