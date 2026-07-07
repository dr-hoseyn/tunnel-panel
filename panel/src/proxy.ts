import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// A separate, Edge-safe NextAuth instance built from the provider-less
// authConfig -- NOT the full instance exported from @/auth, which pulls in
// bcrypt + Prisma's native SQLite adapter and cannot run on the Edge
// runtime this proxy (formerly "middleware") uses by default. Route
// protection here is driven by authConfig's callbacks.authorized.
const { auth } = NextAuth(authConfig);

export { auth as proxy };

export const config = {
  // Protect everything except the login page, its API route, and static assets.
  matcher: ["/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)"],
};
