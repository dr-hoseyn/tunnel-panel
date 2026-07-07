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
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
};
