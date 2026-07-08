import { NextResponse } from "next/server";
import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe subset of the NextAuth config -- no providers (those need
 * bcrypt + Prisma/better-sqlite3, both Node-only), just what middleware
 * needs to decide whether a request is authenticated. Kept in its own file
 * specifically so middleware.ts never pulls in Node-only code: middleware
 * runs on the Edge runtime by default, and Prisma's native SQLite adapter
 * cannot load there.
 */
export const authConfig: NextAuthConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  providers: [],
  // Required any time this sits behind a reverse proxy (Caddy, nginx, ...)
  // instead of being hit directly: NextAuth otherwise rejects the request
  // with a generic "problem with the server configuration" error because it
  // doesn't recognize the proxied Host header as trusted by default. Safe
  // here specifically because Caddy (or whatever proxy is in front) is the
  // only thing that can reach this app -- it always binds to 127.0.0.1.
  trustHost: true,
  callbacks: {
    authorized({ auth, request }) {
      if (auth?.user) return true;
      // Self-hosted `next start -H <host> -p <port>` (what install.sh
      // runs, behind Caddy) builds request.nextUrl from its own bind
      // host/port, not the real incoming Host header -- Next.js only
      // trusts the Host header for this when it detects it's running on
      // Vercel. Left to its default, NextAuth's own unauthorized-redirect
      // would set callbackUrl from request.nextUrl.href and bake in that
      // wrong origin (e.g. "http://localhost:3000/dashboard"), breaking
      // the redirect after a successful login. Building the redirect
      // ourselves with a relative callbackUrl sidesteps it: the Location
      // header itself still resolves correctly (relative to whatever
      // origin the browser is actually on), only the query *value* was
      // ever wrong.
      const loginUrl = request.nextUrl.clone();
      const callbackUrl = request.nextUrl.pathname + request.nextUrl.search;
      loginUrl.pathname = "/login";
      loginUrl.search = "";
      loginUrl.searchParams.set("callbackUrl", callbackUrl);
      return NextResponse.redirect(loginUrl);
    },
  },
};
