"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Search, Server as ServerIcon, Cable, Users, ScrollText, type LucideIcon } from "lucide-react";

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

interface SearchResult {
  kind: "server" | "tunnel" | "user" | "event";
  id: string;
  label: string;
  sublabel: string;
  href: string;
}

interface SearchResponse {
  servers: SearchResult[];
  tunnels: SearchResult[];
  users: SearchResult[];
  events: SearchResult[];
}

const EMPTY_RESPONSE: SearchResponse = { servers: [], tunnels: [], users: [], events: [] };

// Fixed render/keyboard-nav order -- also the order result indices are
// assigned in, so ArrowUp/ArrowDown walk the groups top to bottom exactly
// as rendered.
const GROUPS: { key: keyof SearchResponse; label: string; icon: LucideIcon }[] = [
  { key: "servers", label: "Servers", icon: ServerIcon },
  { key: "tunnels", label: "Tunnels", icon: Cable },
  { key: "users", label: "Users", icon: Users },
  { key: "events", label: "Logs", icon: ScrollText },
];

/**
 * The Ctrl/Cmd+K modal itself -- text input, debounced fetch to
 * /api/v1/search, grouped results, full keyboard navigation. SearchTrigger
 * (mounted once in the app shell) owns the open/closed state and only
 * mounts this component while open -- so every open is a fresh mount with
 * clean initial state, no manual "reset on open" effect needed.
 *
 * Keyboard model follows the common combobox/listbox pattern: focus never
 * leaves the text input (Tab is swallowed while open), and ArrowUp/Down/
 * Enter are handled on the input itself and drive a single `activeIndex`
 * into the flattened, grouped result list -- so "real" keyboard navigation
 * (not just a hover style) selects and activates results.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const openedAtPathname = useRef(pathname);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Focus the input as soon as the palette mounts.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced fetch as the query changes. Guards against out-of-order
  // responses (a slow earlier request landing after a faster later one)
  // with a monotonically increasing request id rather than trusting fetch
  // ordering. Below MIN_QUERY_LENGTH, this simply doesn't schedule a fetch;
  // stale `results` from a longer query are hidden at render time by the
  // idle-hint check rather than cleared here.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      return;
    }

    const timer = setTimeout(() => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      fetch(`/api/v1/search?q=${encodeURIComponent(trimmed)}`, { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<SearchResponse>) : Promise.reject(new Error("search failed"))))
        .then((data) => {
          if (requestIdRef.current !== requestId) return;
          setResults(data);
          setActiveIndex(0);
        })
        .catch(() => {
          if (requestIdRef.current !== requestId) return;
          setResults(EMPTY_RESPONSE);
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  // Safety net for "close on route navigation" beyond the explicit
  // close-then-push in activate() below -- covers any navigation that
  // happens while the palette is open for another reason (browser back/
  // forward, etc).
  useEffect(() => {
    if (pathname !== openedAtPathname.current) {
      onClose();
    }
  }, [pathname, onClose]);

  const groups = useMemo(() => {
    const data = results ?? EMPTY_RESPONSE;
    return GROUPS.reduce<{ key: keyof SearchResponse; label: string; icon: LucideIcon; items: { item: SearchResult; index: number }[] }[]>(
      (acc, group) => {
        const offset = acc.reduce((n, g) => n + g.items.length, 0);
        const items = data[group.key].map((item, i) => ({ item, index: offset + i }));
        return items.length > 0 ? [...acc, { ...group, items }] : acc;
      },
      [],
    );
  }, [results]);

  const flatCount = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);

  function activate(result: SearchResult) {
    onClose();
    router.push(result.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        onClose();
        return;
      case "ArrowDown": {
        e.preventDefault();
        if (flatCount === 0) return;
        setActiveIndex((i) => (i + 1) % flatCount);
        return;
      }
      case "ArrowUp": {
        e.preventDefault();
        if (flatCount === 0) return;
        setActiveIndex((i) => (i - 1 + flatCount) % flatCount);
        return;
      }
      case "Enter": {
        e.preventDefault();
        for (const group of groups) {
          const hit = group.items.find(({ index }) => index === activeIndex);
          if (hit) {
            activate(hit.item);
            return;
          }
        }
        return;
      }
      case "Tab":
        // Focus never leaves the input while the palette is open -- results
        // are reached with Up/Down, not Tab.
        e.preventDefault();
        return;
      default:
        return;
    }
  }

  const trimmed = query.trim();
  const showIdleHint = trimmed.length < MIN_QUERY_LENGTH;
  const showEmptyState = !showIdleHint && !loading && flatCount === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={flatCount > 0}
            aria-controls="command-palette-results"
            aria-activedescendant={flatCount > 0 ? `command-palette-result-${activeIndex}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search servers, tunnels, users, logs..."
            className="w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
          />
          {loading && (
            <span className="shrink-0 text-xs text-neutral-500" aria-live="polite">
              Searching...
            </span>
          )}
          <kbd className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-500">
            Esc
          </kbd>
        </div>

        <div id="command-palette-results" role="listbox" aria-label="Search results" className="max-h-[60vh] overflow-y-auto p-2">
          {showIdleHint && (
            <p className="px-2 py-6 text-center text-sm text-neutral-500">
              Search servers, tunnels, users, and logs by name, host, IP, port, core, email, or message.
            </p>
          )}

          {showEmptyState && (
            <p className="px-2 py-6 text-center text-sm text-neutral-500">No results for &quot;{trimmed}&quot;</p>
          )}

          {!showIdleHint &&
            groups.map((group) => (
              <div key={group.key} className="mb-2 last:mb-0">
                <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                  {group.label}
                </div>
                {group.items.map(({ item, index }) => {
                  const isActive = index === activeIndex;
                  return (
                    <button
                      key={item.id}
                      id={`command-palette-result-${index}`}
                      role="option"
                      aria-selected={isActive}
                      type="button"
                      tabIndex={-1}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => activate(item)}
                      className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm ${
                        isActive ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60"
                      }`}
                    >
                      <group.icon className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      <span className="ml-2 shrink-0 truncate text-xs text-neutral-500">{item.sublabel}</span>
                    </button>
                  );
                })}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
