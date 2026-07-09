import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { Sidebar } from "@/components/Sidebar";
import { NotificationBell } from "@/components/NotificationBell";

/**
 * Single shared shell (sidebar + header + auth check) for every
 * authenticated page. Replaces the previous split where /dashboard had a
 * layout+auth-check but /servers/[id] had neither.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  const role = session.user?.role ?? "VIEWER";

  return (
    <div className="flex h-screen min-h-screen bg-neutral-950 text-neutral-100">
      <Sidebar isAdmin={role === "ADMIN"} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <span className="font-semibold">Tunnel Panel</span>
          <div className="flex items-center gap-4 text-sm text-neutral-400">
            <NotificationBell />
            <span>{session.user?.email}</span>
            <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs uppercase tracking-wide text-neutral-400">
              {role}
            </span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button type="submit" className="text-neutral-400 hover:text-neutral-100">
                Sign out
              </button>
            </form>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
