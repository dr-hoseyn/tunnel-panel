/**
 * Pure helpers for the per-tunnel live log tail (TunnelLogsTail.tsx).
 * Kept side-effect-free and DOM-free so they're independently testable --
 * see tunnel-logs-utils.test.ts.
 */

export interface LogLine {
  side: string;
  server: string;
  line: string;
}

// Matches any ANSI CSI sequence: ESC [ <params> <final-byte>, e.g. "\x1b[31m"
// (color), "\x1b[1m" (bold) or non-SGR ones like "\x1b[2K" (clear line).
// Only sequences ending in "m" (SGR -- Select Graphic Rendition) carry color
// info; everything else is a control code we don't render, so we still
// consume/strip it rather than let it leak into the visible text.
const ANSI_CSI_RE = /\x1b\[([0-9;]*)([A-Za-z])/g;

/** Strip all ANSI escape sequences from a string, e.g. for search/copy/download. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_RE, "");
}

// A classic 16-color ANSI palette (Tango-derived), tuned to stay legible on
// the app's near-black (neutral-950) log background.
const ANSI_FG: Record<number, string> = {
  30: "#6b7280", // black -> neutral-500 so it isn't invisible on a dark bg
  31: "#f87171",
  32: "#4ade80",
  33: "#facc15",
  34: "#60a5fa",
  35: "#e879f9",
  36: "#22d3ee",
  37: "#e5e7eb",
  90: "#9ca3af",
  91: "#fca5a5",
  92: "#86efac",
  93: "#fde047",
  94: "#93c5fd",
  95: "#f0abfc",
  96: "#67e8f9",
  97: "#f9fafb",
};

const ANSI_BG: Record<number, string> = {
  40: "#111827",
  41: "#7f1d1d",
  42: "#14532d",
  43: "#713f12",
  44: "#1e3a8a",
  45: "#701a75",
  46: "#164e63",
  47: "#374151",
  100: "#1f2937",
  101: "#991b1b",
  102: "#166534",
  103: "#854d0e",
  104: "#1d4ed8",
  105: "#86198f",
  106: "#155e75",
  107: "#4b5563",
};

export interface AnsiSegment {
  text: string;
  bold?: boolean;
  fg?: string;
  bg?: string;
}

/**
 * Parse a single log line for ANSI SGR codes, returning an ordered list of
 * styled segments (see ANSI_FG/ANSI_BG for the codes handled: 30-37/90-97
 * foreground, 40-47/100-107 background, 0 reset, 1 bold, plus 39/49 to
 * reset just fg/bg). Unsupported SGR codes are ignored rather than
 * throwing. A line with no escape codes at all comes back as a single
 * plain segment (no fg/bg/bold) so the common case can render as raw text,
 * unchanged from before ANSI support existed.
 */
export function parseAnsiLine(line: string): AnsiSegment[] {
  if (!line.includes("\x1b[")) {
    return [{ text: line }];
  }

  const segments: AnsiSegment[] = [];
  let bold = false;
  let fg: string | undefined;
  let bg: string | undefined;
  let lastIndex = 0;

  ANSI_CSI_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANSI_CSI_RE.exec(line)) !== null) {
    const text = line.slice(lastIndex, match.index);
    if (text) segments.push({ text, bold, fg, bg });
    lastIndex = ANSI_CSI_RE.lastIndex;

    const [, params, final] = match;
    if (final === "m") {
      const codes = params.length ? params.split(";").map(Number) : [0];
      for (const code of codes) {
        if (code === 0) {
          bold = false;
          fg = undefined;
          bg = undefined;
        } else if (code === 1) {
          bold = true;
        } else if (code === 39) {
          fg = undefined;
        } else if (code === 49) {
          bg = undefined;
        } else if (code in ANSI_FG) {
          fg = ANSI_FG[code];
        } else if (code in ANSI_BG) {
          bg = ANSI_BG[code];
        }
        // any other SGR code (underline, italic, 256-color, etc.) is
        // intentionally left unstyled -- the escape bytes are still
        // stripped above, which is the main goal (no raw garbage on screen)
      }
    }
    // non-SGR CSI sequences (cursor moves, clear-line, ...) are stripped
    // above with no style change -- nothing more to do for them
  }

  const rest = line.slice(lastIndex);
  if (rest) segments.push({ text: rest, bold, fg, bg });

  return segments.length ? segments : [{ text: "" }];
}

/**
 * Case-insensitive substring filter over what's actually displayed for each
 * line ("[server] text", ANSI stripped first so escape bytes never affect
 * matching). An empty/whitespace-only query returns the input array as-is
 * -- filtering never discards anything from the underlying buffer, it only
 * changes what filterLogLines itself returns for rendering.
 */
export function filterLogLines(lines: LogLine[], query: string): LogLine[] {
  const q = query.trim().toLowerCase();
  if (!q) return lines;
  return lines.filter((l) => `${l.server} ${stripAnsi(l.line)}`.toLowerCase().includes(q));
}

/** Flatten a buffer of log lines into plain text for download/copy (ANSI stripped). */
export function linesToText(lines: LogLine[]): string {
  return lines.map((l) => `[${l.server}] ${stripAnsi(l.line)}`).join("\n");
}
