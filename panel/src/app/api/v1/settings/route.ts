import { NextResponse } from "next/server";
import { z } from "zod";
import { getSettings, updateSettings } from "@/lib/settings";
import { requireRoleResponse } from "@/lib/rbac";
import { prisma } from "@/lib/db";

export async function GET() {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const settings = await getSettings();
  return NextResponse.json({ settings });
}

const patchSchema = z
  .object({
    healthCheckIntervalMs: z.number().int().min(5_000).max(600_000),
    statRetentionMs: z.number().int().min(60_000).max(90 * 24 * 60 * 60 * 1000),
    stuckDeploymentTimeoutMs: z.number().int().min(60_000).max(3_600_000),
    deploymentMaxAttempts: z.number().int().min(1).max(10),
    autoRestartEnabled: z.boolean(),
    logRetentionDays: z.number().int().min(1).max(365),
  })
  .partial();

export async function PATCH(request: Request) {
  // ADMIN-only, not OPERATOR: these values change *how the whole platform
  // behaves* (health-check cadence, auto-restart, retention) for every
  // tunnel and every user, not one server/tunnel an operator manages day to
  // day -- the same bar this codebase already applies to the Users page.
  const auth = await requireRoleResponse("ADMIN");
  if ("response" in auth) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "no settings provided" }, { status: 400 });
  }

  const settings = await updateSettings(parsed.data);

  await prisma.event.create({
    data: {
      category: "AUDIT",
      type: "SETTINGS_UPDATED",
      severity: "INFO",
      message: `Settings updated by ${auth.session.user?.email ?? "unknown"}: ${Object.keys(parsed.data).join(", ")}.`,
      userId: auth.session.user?.id,
    },
  });

  return NextResponse.json({ settings });
}
