import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import type { Role } from "@/generated/prisma/enums";

/**
 * Every mutating /api/v1 route (and admin-only pages) calls requireRole()
 * first. proxy.ts (Edge runtime) only ever checks "is there a session at
 * all" -- fine-grained role checks live here, in Node-runtime code, for the
 * same reason the full NextAuth config with the Credentials provider does
 * (see auth.config.ts's own header comment): keeping Prisma out of the Edge
 * bundle.
 */

const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };

export class UnauthorizedError extends Error {
  constructor(
    public status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Resolves the current session and asserts its role is at least `minimum`
 * (VIEWER < OPERATOR < ADMIN), throwing UnauthorizedError otherwise -- 401
 * if there's no session at all, 403 if there is one but it's
 * under-privileged. Callers catch this and map it to an HTTP response; see
 * withRole below for the common case. */
export async function requireRole(minimum: Role): Promise<Session> {
  const session = await auth();
  if (!session?.user) {
    throw new UnauthorizedError(401, "unauthorized");
  }
  const role = session.user.role ?? "VIEWER";
  if (RANK[role] < RANK[minimum]) {
    throw new UnauthorizedError(403, `this action requires the ${minimum} role or higher`);
  }
  return session;
}

/** Route-handler-friendly wrapper: returns the session on success, or an
 * already-built NextResponse to return immediately on failure -- so a route
 * handler is just:
 *   const auth = await requireRoleResponse("OPERATOR");
 *   if ("response" in auth) return auth.response;
 */
export async function requireRoleResponse(
  minimum: Role,
): Promise<{ session: Session } | { response: NextResponse }> {
  try {
    return { session: await requireRole(minimum) };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return { response: NextResponse.json({ error: err.message }, { status: err.status }) };
    }
    throw err;
  }
}
