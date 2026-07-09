"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";

interface NotificationItem {
  id: string;
  type: string;
  severity: "INFO" | "WARNING" | "ERROR";
  title: string;
  message: string;
  read: boolean;
  serverId: string | null;
  tunnelId: string | null;
  createdAt: string;
}

const SEVERITY_DOT: Record<string, string> = {
  INFO: "bg-blue-500",
  WARNING: "bg-yellow-500",
  ERROR: "bg-red-500",
};

const SEVERITY_TEXT: Record<string, string> = {
  INFO: "text-blue-400",
  WARNING: "text-yellow-400",
  ERROR: "text-red-400",
};

function linkFor(n: NotificationItem): string | null {
  if (n.tunnelId) return `/tunnels/${n.tunnelId}`;
  if (n.serverId) return `/servers/${n.serverId}`;
  return null;
}

/** Header bell: polls the unread count every ~10s (same setInterval +
 * cleanup shape as ServerCard.tsx's metrics polling) and, on click, opens an
 * in-place dropdown -- no navigation -- listing recent notifications. */
export function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[] | null>(null);
  const [listErrored, setListErrored] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/v1/notifications/unread-count", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { count: number };
        if (!cancelled) setUnreadCount(data.count);
      } catch {
        // Transient poll failure -- leave the last known count in place
        // rather than flashing the badge to zero.
      }
    }

    poll();
    const interval = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    fetch("/api/v1/notifications?limit=20", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json() as Promise<{ notifications: NotificationItem[] }>;
      })
      .then((data) => {
        if (!cancelled) {
          setNotifications(data.notifications);
          setListErrored(false);
        }
      })
      .catch(() => {
        if (!cancelled) setListErrored(true);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  async function markRead(id: string) {
    setNotifications((prev) => prev?.map((n) => (n.id === id ? { ...n, read: true } : n)) ?? prev);
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await fetch(`/api/v1/notifications/${id}/read`, { method: "POST" });
    } catch {
      // Best-effort -- the next poll cycle reconciles the count either way.
    }
  }

  async function markAllRead() {
    setNotifications((prev) => prev?.map((n) => ({ ...n, read: true })) ?? prev);
    setUnreadCount(0);
    try {
      await fetch("/api/v1/notifications/read-all", { method: "POST" });
    } catch {
      // Best-effort, same as markRead above.
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        aria-expanded={open}
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-neutral-200"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-lg border border-neutral-800 bg-neutral-900 shadow-lg">
          <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
            <span className="text-sm font-medium text-neutral-200">Notifications</span>
            <button type="button" onClick={markAllRead} className="text-xs text-neutral-400 hover:text-neutral-100">
              Mark all read
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {listErrored && (
              <p className="px-3 py-6 text-center text-sm text-neutral-500">Couldn&apos;t load notifications.</p>
            )}
            {!listErrored && notifications === null && (
              <p className="px-3 py-6 text-center text-sm text-neutral-500">Loading...</p>
            )}
            {!listErrored && notifications !== null && notifications.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-neutral-500">No notifications</p>
            )}
            {!listErrored &&
              notifications?.map((n) => (
                <NotificationRow key={n.id} notification={n} onOpen={() => setOpen(false)} onMarkRead={markRead} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  notification: n,
  onOpen,
  onMarkRead,
}: {
  notification: NotificationItem;
  onOpen: () => void;
  onMarkRead: (id: string) => void;
}) {
  const href = linkFor(n);

  const body = (
    <div
      onClick={() => {
        if (!n.read) onMarkRead(n.id);
      }}
      className={`flex gap-2 border-b border-neutral-800 px-3 py-2.5 last:border-b-0 ${n.read ? "" : "bg-neutral-800/40"} ${
        href ? "cursor-pointer hover:bg-neutral-800" : ""
      }`}
    >
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[n.severity] ?? SEVERITY_DOT.INFO}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-medium ${SEVERITY_TEXT[n.severity] ?? ""}`}>{n.title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-neutral-400">{n.message}</p>
        <p className="mt-1 text-[11px] text-neutral-600">{new Date(n.createdAt).toLocaleString()}</p>
      </div>
    </div>
  );

  if (!href) return body;

  return (
    <Link href={href} onClick={onOpen}>
      {body}
    </Link>
  );
}
