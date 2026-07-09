import { describe, expect, it } from "vitest";
import { filterLogLines, linesToText, parseAnsiLine, stripAnsi, type LogLine } from "./tunnel-logs-utils";

describe("parseAnsiLine", () => {
  it("returns a single plain segment for a line with no escape codes", () => {
    expect(parseAnsiLine("plain log line, nothing special")).toEqual([
      { text: "plain log line, nothing special" },
    ]);
  });

  it("returns an empty-text segment for an empty line", () => {
    expect(parseAnsiLine("")).toEqual([{ text: "" }]);
  });

  it("applies a foreground color and clears it on reset", () => {
    const segments = parseAnsiLine("\x1b[31mERROR\x1b[0m: boom");
    expect(segments).toEqual([
      { text: "ERROR", bold: false, fg: "#f87171", bg: undefined },
      { text: ": boom", bold: false, fg: undefined, bg: undefined },
    ]);
  });

  it("combines bold + foreground from a single multi-param code", () => {
    const segments = parseAnsiLine("\x1b[1;31mfatal\x1b[0m");
    expect(segments[0]).toEqual({ text: "fatal", bold: true, fg: "#f87171", bg: undefined });
  });

  it("supports bright (90-97) foreground and background (40-47/100-107) codes", () => {
    const fg = parseAnsiLine("\x1b[92mok\x1b[0m");
    expect(fg[0].fg).toBe("#86efac");

    const bg = parseAnsiLine("\x1b[41mwarn\x1b[0m");
    expect(bg[0].bg).toBe("#7f1d1d");

    const brightBg = parseAnsiLine("\x1b[104mnote\x1b[0m");
    expect(brightBg[0].bg).toBe("#1d4ed8");
  });

  it("carries style state across multiple segments until reset", () => {
    const segments = parseAnsiLine("\x1b[32mgreen \x1b[1mgreen-bold\x1b[0m plain");
    expect(segments).toEqual([
      { text: "green ", bold: false, fg: "#4ade80", bg: undefined },
      { text: "green-bold", bold: true, fg: "#4ade80", bg: undefined },
      { text: " plain", bold: false, fg: undefined, bg: undefined },
    ]);
  });

  it("resets only foreground on code 39 and only background on code 49", () => {
    const segments = parseAnsiLine("\x1b[31;44mtext\x1b[39mrest\x1b[49mtail");
    expect(segments[0]).toEqual({ text: "text", bold: false, fg: "#f87171", bg: "#1e3a8a" });
    expect(segments[1]).toEqual({ text: "rest", bold: false, fg: undefined, bg: "#1e3a8a" });
    expect(segments[2]).toEqual({ text: "tail", bold: false, fg: undefined, bg: undefined });
  });

  it("ignores unsupported SGR codes without throwing, still stripping the escape bytes", () => {
    const segments = parseAnsiLine("\x1b[4munderline?\x1b[0m");
    expect(segments).toEqual([{ text: "underline?", bold: false, fg: undefined, bg: undefined }]);
  });

  it("strips non-SGR CSI sequences (e.g. clear-line) without touching style", () => {
    const segments = parseAnsiLine("\x1b[2Kcleared then \x1b[31mred\x1b[0m");
    expect(segments).toEqual([
      { text: "cleared then ", bold: false, fg: undefined, bg: undefined },
      { text: "red", bold: false, fg: "#f87171", bg: undefined },
    ]);
  });
});

describe("stripAnsi", () => {
  it("removes SGR and non-SGR escape sequences, leaving plain text untouched otherwise", () => {
    expect(stripAnsi("\x1b[1;31mERROR\x1b[0m: \x1b[2Kdone")).toBe("ERROR: done");
    expect(stripAnsi("no codes here")).toBe("no codes here");
  });
});

describe("filterLogLines", () => {
  const lines: LogLine[] = [
    { side: "source", server: "edge-1", line: "connection established" },
    { side: "destination", server: "core-2", line: "\x1b[31mERROR\x1b[0m timeout waiting for peer" },
    { side: "source", server: "edge-1", line: "heartbeat ok" },
  ];

  it("returns all lines unchanged for an empty or whitespace-only query", () => {
    expect(filterLogLines(lines, "")).toBe(lines);
    expect(filterLogLines(lines, "   ")).toBe(lines);
  });

  it("matches case-insensitively against the line text", () => {
    expect(filterLogLines(lines, "error")).toEqual([lines[1]]);
    expect(filterLogLines(lines, "HEARTBEAT")).toEqual([lines[2]]);
  });

  it("matches ANSI-colored lines by their visible text, ignoring escape bytes", () => {
    expect(filterLogLines(lines, "timeout")).toEqual([lines[1]]);
  });

  it("also matches against the server label", () => {
    expect(filterLogLines(lines, "core-2")).toEqual([lines[1]]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterLogLines(lines, "nope-not-present")).toEqual([]);
  });
});

describe("linesToText", () => {
  it("joins lines as '[server] text' with ANSI stripped", () => {
    const lines: LogLine[] = [
      { side: "source", server: "edge-1", line: "\x1b[32mstarted\x1b[0m" },
      { side: "destination", server: "core-2", line: "listening" },
    ];
    expect(linesToText(lines)).toBe("[edge-1] started\n[core-2] listening");
  });

  it("returns an empty string for an empty buffer", () => {
    expect(linesToText([])).toBe("");
  });
});
