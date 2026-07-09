import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

/**
 * On-demand "is a newer agent release available" check -- deliberately NOT
 * run automatically (e.g. on every server-detail page load), only when this
 * route is explicitly hit from a button click, and even then only actually
 * calls GitHub if the cached result on the Server row is older than
 * CHECK_TTL_MS. This is the only place in the panel that talks to GitHub's
 * release API, so both "don't spam GitHub" requirements (no auto-check, a
 * cache floor) live in one spot.
 */

const REPO = "dr-hoseyn/tunnel-panel";
const CHECK_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) {
    return NextResponse.json({ error: "server not found" }, { status: 404 });
  }

  const cacheIsFresh =
    server.latestAgentCheckedAt && Date.now() - server.latestAgentCheckedAt.getTime() < CHECK_TTL_MS;

  let latestVersion = server.latestAgentVersion;
  let checkedAt = server.latestAgentCheckedAt;

  if (!cacheIsFresh) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
        cache: "no-store",
      });
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: `GitHub returned HTTP ${res.status}` }, { status: 502 });
      }
      const data = (await res.json()) as { tag_name?: string };
      if (!data.tag_name) {
        return NextResponse.json({ ok: false, error: "GitHub response had no tag_name" }, { status: 502 });
      }
      latestVersion = data.tag_name;
      checkedAt = new Date();
      await prisma.server.update({
        where: { id },
        data: { latestAgentVersion: latestVersion, latestAgentCheckedAt: checkedAt },
      });
    } catch {
      return NextResponse.json({ ok: false, error: "could not reach GitHub" }, { status: 502 });
    }
  }

  const updateAvailable =
    !!latestVersion && !!server.agentVersion && latestVersion.replace(/^v/, "") !== server.agentVersion.replace(/^v/, "");

  return NextResponse.json({
    ok: true,
    currentVersion: server.agentVersion,
    latestVersion,
    updateAvailable,
    checkedAt,
    fromCache: cacheIsFresh,
  });
}
