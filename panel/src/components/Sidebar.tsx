"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Server,
  Cable,
  Boxes,
  Activity,
  Archive,
  ScrollText,
  Users,
  Settings,
  Waypoints,
} from "lucide-react";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/servers", label: "Servers", icon: Server },
  { href: "/tunnels", label: "Tunnels", icon: Cable },
  { href: "/topology", label: "Topology", icon: Waypoints },
  { href: "/cores", label: "Cores", icon: Boxes },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/backups", label: "Backups", icon: Archive },
  { href: "/logs", label: "Logs", icon: ScrollText },
] as const;

const ADMIN_NAV_ITEMS = [
  { href: "/users", label: "Users", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function Sidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();

  const items = isAdmin ? [...NAV_ITEMS, ...ADMIN_NAV_ITEMS] : NAV_ITEMS;

  return (
    <nav
      aria-label="Main navigation"
      className="flex w-56 shrink-0 flex-col gap-1 border-r border-neutral-800 bg-neutral-950 p-3"
    >
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
