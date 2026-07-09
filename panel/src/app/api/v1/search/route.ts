import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

/**
 * Global command-palette search (Ctrl/Cmd+K). Fans out across Servers,
 * Tunnels, Users, and Events with one bounded query per category -- no
 * N+1s. Users results are simply omitted for non-ADMIN callers rather than
 * 403ing the whole search: mirrors how (app)/users/page.tsx redirects
 * non-admins away from the page itself, just applied to one section of a
 * shared response instead of a whole route.
 *
 * Case sensitivity: SQLite's default LIKE (what Prisma's `contains`
 * compiles down to on this provider) is already case-insensitive for ASCII,
 * and `mode: "insensitive"` isn't even a field on the generated filter
 * types for the sqlite provider -- there's nothing to opt into here, plain
 * `contains: q` is both correct and all that's available. See
 * route.test.ts for a test that actually proves a mixed-case query matches
 * rather than just assuming the above.
 */

const CATEGORY_CAP = 6;
const LOG_CAP = 5;

// Tunnels can be searched by forwarded port number, which lives inside the
// `config` Json column (config.port / config.ports[].remote/.local) --
// SQLite JSON querying via Prisma has no `contains`-style operator for that,
// so instead of a raw-SQL json_extract query, this pulls a bounded,
// most-recent-first candidate set and filters in JS (name/core/port all at
// once). Fine at the scale this panel runs at; would need to become a real
// json_extract query (or a denormalized indexed column) if tunnel counts
// ever got into the thousands.
const TUNNEL_CANDIDATE_BOUND = 500;

export type SearchResultKind = "server" | "tunnel" | "user" | "event";

export interface SearchResult {
  kind: SearchResultKind;
  id: string;
  label: string;
  sublabel: string;
  href: string;
}

export interface SearchResponse {
  servers: SearchResult[];
  tunnels: SearchResult[];
  users: SearchResult[];
  events: SearchResult[];
}

const EMPTY_RESPONSE: SearchResponse = { servers: [], tunnels: [], users: [], events: [] };

/** Parses `q` as a valid TCP/UDP port number (1-65535), or null if it isn't
 * one -- e.g. "8080" -> 8080, but "8080x", "-1", "99999", "3.5" -> null. */
function parsePortQuery(q: string): number | null {
  if (!/^\d+$/.test(q)) return null;
  const n = Number(q);
  return n >= 1 && n <= 65535 ? n : null;
}

interface TunnelConfigShape {
  port?: number;
  ports?: { remote?: number; local?: number }[];
}

interface TunnelCandidate {
  id: string;
  name: string;
  core: string;
  config: unknown;
  sourceServer: { name: string };
  destServer: { name: string };
}

function tunnelMatches(t: TunnelCandidate, ql: string, portQuery: number | null): boolean {
  if (t.name.toLowerCase().includes(ql) || t.core.toLowerCase().includes(ql)) {
    return true;
  }
  if (portQuery === null) return false;
  const config = t.config as TunnelConfigShape | null;
  if (!config) return false;
  if (config.port === portQuery) return true;
  return (config.ports ?? []).some((p) => p.remote === portQuery || p.local === portQuery);
}

export async function GET(request: Request) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json(EMPTY_RESPONSE);
  }

  const isAdmin = (auth.session.user?.role ?? "VIEWER") === "ADMIN";
  const ql = q.toLowerCase();
  const portQuery = parsePortQuery(q);

  const [serverRows, tunnelCandidates, userRows, eventRows] = await Promise.all([
    prisma.server.findMany({
      where: {
        OR: [{ name: { contains: q } }, { host: { contains: q } }, { location: { contains: q } }],
      },
      select: { id: true, name: true, host: true, location: true },
      orderBy: { createdAt: "desc" },
      take: CATEGORY_CAP,
    }),
    prisma.tunnel.findMany({
      select: {
        id: true,
        name: true,
        core: true,
        config: true,
        sourceServer: { select: { name: true } },
        destServer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: TUNNEL_CANDIDATE_BOUND,
    }),
    isAdmin
      ? prisma.user.findMany({
          where: { email: { contains: q } },
          select: { id: true, email: true, role: true },
          orderBy: { createdAt: "desc" },
          take: CATEGORY_CAP,
        })
      : Promise.resolve([]),
    prisma.event.findMany({
      where: { message: { contains: q } },
      select: { id: true, message: true, category: true, severity: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: LOG_CAP,
    }),
  ]);

  const response: SearchResponse = {
    servers: serverRows.map((s) => ({
      kind: "server",
      id: s.id,
      label: s.name,
      sublabel: s.location ? `${s.host} · ${s.location}` : s.host,
      href: `/servers/${s.id}`,
    })),
    tunnels: (tunnelCandidates as TunnelCandidate[])
      .filter((t) => tunnelMatches(t, ql, portQuery))
      .slice(0, CATEGORY_CAP)
      .map((t) => ({
        kind: "tunnel",
        id: t.id,
        label: t.name,
        sublabel: `${t.core} · ${t.sourceServer.name} -> ${t.destServer.name}`,
        href: `/tunnels/${t.id}`,
      })),
    users: userRows.map((u) => ({
      kind: "user",
      id: u.id,
      label: u.email,
      sublabel: u.role,
      href: `/users`,
    })),
    events: eventRows.map((e) => ({
      kind: "event",
      id: e.id,
      label: e.message,
      sublabel: `${e.category} · ${e.severity} · ${e.createdAt.toLocaleString()}`,
      href: `/logs`,
    })),
  };

  return NextResponse.json(response);
}
