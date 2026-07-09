"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Pause, Play, Download, Copy, Check, ArrowDown } from "lucide-react";
import { filterLogLines, linesToText, parseAnsiLine, type LogLine } from "./tunnel-logs-utils";

// Cap on the in-memory buffer. Raised from the original 500 now that
// search/download/copy make a bigger scrollback genuinely useful -- still
// bounded so a long-lived tab can't grow this without limit.
const MAX_BUFFERED_LINES = 2000;

// How close to the bottom (in px) counts as "at the bottom" for auto-scroll
// purposes -- gives a little slack for sub-pixel/rounding scroll positions.
const AUTO_SCROLL_THRESHOLD_PX = 24;

export function TunnelLogsTail({ tunnelId }: { tunnelId: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);

  const [search, setSearch] = useState("");

  // Pause freezes *what's displayed* at the snapshot taken when paused was
  // flipped on; the live SSE connection keeps appending to `lines`
  // underneath so nothing is lost, and pendingCount tells the user how much
  // arrived while they were reading.
  const [paused, setPaused] = useState(false);
  const [frozenLines, setFrozenLines] = useState<LogLine[] | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const pausedRef = useRef(false);

  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    const source = new EventSource(`/api/v1/tunnels/${tunnelId}/logs/stream`);

    const append = (data: LogLine) => {
      setConnected(true);
      setLines((prev) => [...prev.slice(-(MAX_BUFFERED_LINES - 1)), data]);
      // Registered once per mount, so we read pause state from a ref rather
      // than the `paused` closure variable (which would go stale here).
      if (pausedRef.current) {
        setPendingCount((c) => c + 1);
      }
    };

    source.addEventListener("line", (e) => {
      append(JSON.parse((e as MessageEvent).data) as LogLine);
    });
    source.addEventListener("side-error", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { side: string; server: string; message: string };
      append({ side: data.side, server: data.server, line: `[error] ${data.message}` });
    });

    return () => source.close();
  }, [tunnelId]);

  const displayedLines = useMemo(() => {
    const source = paused && frozenLines ? frozenLines : lines;
    return filterLogLines(source, search);
  }, [paused, frozenLines, lines, search]);

  // Auto-scroll to the bottom as the visible list grows -- but only while
  // the user hasn't scrolled away (autoScroll) and the view isn't frozen by
  // pause (paused view never changes shape from new lines anyway).
  useEffect(() => {
    if (!autoScroll || paused) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [displayedLines, autoScroll, paused]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Whether this scroll was the user or our own auto-scroll effect, the
    // outcome is the same: if we're within the threshold of the bottom,
    // auto-scroll stays/becomes enabled; if the user scrolled up away from
    // it, auto-scroll turns itself off so new lines don't yank them back
    // down (they can re-enable it with "Jump to bottom", or by scrolling
    // back to the bottom themselves).
    setAutoScroll(distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX);
  }

  function togglePause() {
    setPaused((was) => {
      if (was) {
        setFrozenLines(null);
        setPendingCount(0);
        return false;
      }
      setFrozenLines(lines);
      setPendingCount(0);
      return true;
    });
  }

  function jumpToBottom() {
    setAutoScroll(true);
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function downloadLog() {
    const blob = new Blob([linesToText(lines)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tunnel-${tunnelId}-logs.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Design choice: copy uses `displayedLines` (respects the active search
  // filter and, while paused, the frozen snapshot) rather than the full
  // buffer -- if someone has just filtered down to the lines they care
  // about, that's almost always what they want on the clipboard. Download
  // always exports the complete, unfiltered buffer (see downloadLog above),
  // since that's explicitly the "give me everything captured" action.
  async function copyLog() {
    try {
      await navigator.clipboard.writeText(linesToText(displayedLines));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the browser (permissions/context);
      // there's nothing actionable to do beyond not crashing.
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-xs text-neutral-500">{connected ? "Live -- polling both agents every ~1.5s." : "Connecting..."}</p>
        {paused && pendingCount > 0 && (
          <span className="rounded-full border border-amber-800 bg-amber-950/50 px-2 py-0.5 text-[11px] text-amber-300">
            {pendingCount} new line{pendingCount === 1 ? "" : "s"} while paused
          </span>
        )}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[160px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter log lines..."
            className="w-full rounded border border-neutral-700 bg-neutral-900 py-1.5 pl-7 pr-2 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-600"
          />
        </div>
        <button
          onClick={togglePause}
          className="flex items-center gap-1.5 rounded border border-neutral-700 px-2.5 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
        >
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {paused ? "Resume" : "Pause"}
        </button>
        {!autoScroll && (
          <button
            onClick={jumpToBottom}
            className="flex items-center gap-1.5 rounded border border-neutral-700 px-2.5 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
          >
            <ArrowDown className="h-3.5 w-3.5" /> Jump to bottom
          </button>
        )}
        <button
          onClick={copyLog}
          className="flex items-center gap-1.5 rounded border border-neutral-700 px-2.5 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
        </button>
        <button
          onClick={downloadLog}
          className="flex items-center gap-1.5 rounded border border-neutral-700 px-2.5 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
        >
          <Download className="h-3.5 w-3.5" /> Download
        </button>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-96 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs"
      >
        {displayedLines.length === 0 && (
          <p className="text-neutral-600">
            {lines.length === 0 ? "No log lines yet." : "No log lines match your search."}
          </p>
        )}
        {displayedLines.map((l, i) => (
          <div key={i} className="text-neutral-400">
            <span className="text-neutral-600">[{l.server}]</span> <AnsiLine line={l.line} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Renders a log line, turning any ANSI SGR color codes into inline-styled spans. */
function AnsiLine({ line }: { line: string }) {
  const segments = useMemo(() => parseAnsiLine(line), [line]);

  // Common case (no ANSI codes at all): render as a plain text node, exactly
  // as the component did before ANSI support existed -- no wrapping span.
  if (segments.length === 1 && !segments[0].fg && !segments[0].bg && !segments[0].bold) {
    return <>{segments[0].text}</>;
  }

  return (
    <>
      {segments.map((seg, i) => (
        <span
          key={i}
          style={{
            color: seg.fg,
            backgroundColor: seg.bg,
            fontWeight: seg.bold ? 700 : undefined,
          }}
        >
          {seg.text}
        </span>
      ))}
    </>
  );
}
