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
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
};
