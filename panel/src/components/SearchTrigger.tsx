"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { CommandPalette } from "@/components/CommandPalette";

/**
 * Header search box that opens the Ctrl/Cmd+K command palette -- both on
 * click and via a global keydown listener, so the shortcut works from
 * anywhere in the app (this component is mounted once, in the shared
 * (app)/layout.tsx shell, so its listener is effectively global).
 */
export function SearchTrigger() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isSearchShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (!isSearchShortcut) return;
      e.preventDefault();
      setOpen((o) => !o);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-500 transition-colors hover:border-neutral-700 hover:text-neutral-300"
      >
        <Search className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Search...</span>
        <kbd className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-500">Ctrl+K</kbd>
      </button>
      {open && <CommandPalette onClose={() => setOpen(false)} />}
    </>
  );
}
