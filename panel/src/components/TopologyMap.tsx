"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { RotateCcw, Search } from "lucide-react";

export interface NodeInfo {
  id: string;
  name: string;
  location: string | null;
  lastSeenAt: string | null;
}

export interface EdgeInfo {
  id: string;
  name: string;
  core: string;
  status: string;
  sourceId: string;
  destId: string;
}

const STATUS_COLOR: Record<string, string> = {
  RUNNING: "#22c55e",
  DEPLOYING: "#3b82f6",
  WARNING: "#eab308",
  FAILED: "#ef4444",
  STOPPED: "#737373",
  REMOVING: "#737373",
  UNKNOWN: "#525252",
};

export type ServerOnlineStatus = "online" | "offline" | "unknown";

const SERVER_STATUS_COLOR: Record<ServerOnlineStatus, string> = {
  online: "#22c55e",
  offline: "#ef4444",
  unknown: "#737373",
};

const SERVER_STATUS_LABEL: Record<ServerOnlineStatus, string> = {
  online: "Online",
  offline: "Offline",
  unknown: "Never seen",
};

const ONLINE_THRESHOLD_MS = 60_000;

// Plain helper (not a component/hook) so the Date.now() call inside it
// doesn't trip React's render-purity lint rule -- the same pattern
// dashboard/page.tsx and monitoring/page.tsx use for the same computation.
// It has to live here (rather than being a one-time server-side pass) since
// this is a client component: nodes get re-classified against wall-clock
// time on every poll refresh, not just once per request.
function isRecentlySeen(lastSeenAt: string | null): boolean {
  return !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS;
}

export function serverOnlineStatus(lastSeenAt: string | null): ServerOnlineStatus {
  if (!lastSeenAt) return "unknown";
  return isRecentlySeen(lastSeenAt) ? "online" : "offline";
}

/** Places nodes evenly around a circle of the given size, keyed by id. Pure
 * function of the id list (order + count) so that as long as the server
 * keeps returning nodes in the same order across polls, positions don't
 * jump around between refreshes. */
export function computeLayout(nodeIds: string[], size: number): Map<string, { x: number; y: number }> {
  const center = size / 2;
  const radius = nodeIds.length <= 1 ? 0 : size / 2 - 90;
  const positions = new Map<string, { x: number; y: number }>();
  nodeIds.forEach((id, i) => {
    const angle = (i / nodeIds.length) * 2 * Math.PI - Math.PI / 2;
    positions.set(id, {
      x: center + radius * Math.cos(angle),
      y: center + radius * Math.sin(angle),
    });
  });
  return positions;
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

export function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/** A node matches the query by name; an edge matches by its own name OR by
 * either endpoint's server name -- so filtering "germany" also highlights
 * the tunnels touching a matching server, keeping the result legible as a
 * connected shape rather than isolated dots. Empty query matches everything
 * (nothing dimmed). */
export function filterTopology(
  nodes: Pick<NodeInfo, "id" | "name">[],
  edges: Pick<EdgeInfo, "id" | "name" | "sourceId" | "destId">[],
  query: string,
): { matchedNodeIds: Set<string>; matchedEdgeIds: Set<string> } {
  const q = query.trim().toLowerCase();
  if (!q) {
    return {
      matchedNodeIds: new Set(nodes.map((n) => n.id)),
      matchedEdgeIds: new Set(edges.map((e) => e.id)),
    };
  }
  const matchedNodeIds = new Set(nodes.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.id));
  const matchedEdgeIds = new Set(
    edges
      .filter((e) => e.name.toLowerCase().includes(q) || matchedNodeIds.has(e.sourceId) || matchedNodeIds.has(e.destId))
      .map((e) => e.id),
  );
  return { matchedNodeIds, matchedEdgeIds };
}

const SIZE = 640;
const DIMMED_OPACITY = 0.25;
const DRAG_THRESHOLD_PX = 4;
// Fleet-wide status doesn't need sub-few-second freshness the way a single
// tunnel's live log tail does (see TunnelDetailView's EventSource use) --
// health-sampler itself only ticks every ~15s, so a plain poll here is
// simpler than standing up a new fleet-wide SSE endpoint and is still well
// within this project's "avoid unnecessary polling, but plain polling is
// fine where sub-few-second freshness isn't required" principle.
const POLL_INTERVAL_MS = 12_000;

interface TopologyResponse {
  servers: { id: string; name: string; location: string | null; lastSeenAt: string | null }[];
  tunnels: { id: string; name: string; core: string; status: string; sourceServerId: string; destServerId: string }[];
}

/** Hand-rolled, zoomable/pannable SVG network map -- servers placed evenly
 * around a circle (no force-directed-layout dependency needed at the node
 * counts this panel realistically manages), tunnels drawn as labeled,
 * status-colored edges between them. Both node and edge markup are directly
 * clickable (in addition to the plain-text edge list below, kept for
 * accessibility/discoverability), the view can be panned/zoomed, and a
 * search box dims anything that doesn't match by name. */
export function TopologyMap({ nodes: initialNodes, edges: initialEdges }: { nodes: NodeInfo[]; edges: EdgeInfo[] }) {
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  const [pollError, setPollError] = useState(false);
  const [search, setSearch] = useState("");
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [isPanning, setIsPanning] = useState(false);

  const svgRef = useRef<SVGSVGElement>(null);
  const panningRef = useRef(false);
  const draggedRef = useRef(false);
  const lastPointRef = useRef({ x: 0, y: 0 });

  // Poll the fleet-wide status snapshot on an interval instead of relying on
  // a full page reload -- see POLL_INTERVAL_MS's comment above for why
  // polling (not a new SSE stream) was the right tradeoff here. No fetch on
  // mount: the server component that rendered this already handed us fresh
  // data, so the first fetch happens one interval later.
  useEffect(() => {
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/v1/topology", { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as TopologyResponse;
        if (cancelled) return;
        setNodes(data.servers.map((s) => ({ id: s.id, name: s.name, location: s.location, lastSeenAt: s.lastSeenAt })));
        setEdges(
          data.tunnels.map((t) => ({
            id: t.id,
            name: t.name,
            core: t.core,
            status: t.status,
            sourceId: t.sourceServerId,
            destId: t.destServerId,
          })),
        );
        setPollError(false);
      } catch {
        if (!cancelled) setPollError(true);
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Wheel-to-zoom needs a non-passive listener to call preventDefault (React
  // registers onWheel as passive by default, which would silently no-op it
  // and leave the page scrolling underneath the map).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = svg!.getBoundingClientRect();
      if (rect.width === 0) return;
      const unitsPerPixel = SIZE / rect.width;
      const cursorX = (e.clientX - rect.left) * unitsPerPixel;
      const cursorY = (e.clientY - rect.top) * unitsPerPixel;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;

      setView((prev) => {
        const nextZoom = clampZoom(prev.zoom * factor);
        if (nextZoom === prev.zoom) return prev;
        // Keep the point under the cursor fixed on screen: solve for the
        // pre-zoom local coordinate, then re-derive pan so that local point
        // still lands at (cursorX, cursorY) at the new zoom level.
        const localX = (cursorX - prev.panX) / prev.zoom;
        const localY = (cursorY - prev.panY) / prev.zoom;
        return {
          zoom: nextZoom,
          panX: cursorX - nextZoom * localX,
          panY: cursorY - nextZoom * localY,
        };
      });
    }

    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  function handlePointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    panningRef.current = true;
    draggedRef.current = false;
    lastPointRef.current = { x: e.clientX, y: e.clientY };
    setIsPanning(true);
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!panningRef.current) return;
    const dx = e.clientX - lastPointRef.current.x;
    const dy = e.clientY - lastPointRef.current.y;
    if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) draggedRef.current = true;
    if (!draggedRef.current) return;
    lastPointRef.current = { x: e.clientX, y: e.clientY };
    const rect = svgRef.current?.getBoundingClientRect();
    const unitsPerPixel = rect && rect.width > 0 ? SIZE / rect.width : 1;
    setView((prev) => ({ ...prev, panX: prev.panX + dx * unitsPerPixel, panY: prev.panY + dy * unitsPerPixel }));
  }

  function handlePointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    panningRef.current = false;
    setIsPanning(false);
    svgRef.current?.releasePointerCapture(e.pointerId);
  }

  // Runs before any descendant Link's own click handler (capture phase) --
  // cancels the click-driven navigation when the pointerdown/up cycle that
  // produced it was actually a pan drag, without needing an onClick guard on
  // every single node/edge.
  function handleClickCapture(e: ReactMouseEvent<SVGSVGElement>) {
    if (draggedRef.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function resetView() {
    setView({ zoom: 1, panX: 0, panY: 0 });
  }

  if (nodes.length === 0) {
    return <p className="text-sm text-neutral-500">No servers registered yet.</p>;
  }

  const positions = computeLayout(
    nodes.map((n) => n.id),
    SIZE,
  );
  const { matchedNodeIds, matchedEdgeIds } = filterTopology(nodes, edges, search);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by server or tunnel name..."
            className="w-64 rounded border border-neutral-700 bg-neutral-950 py-1.5 pr-3 pl-8 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>
        <button
          onClick={resetView}
          className="flex items-center gap-1.5 rounded border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset view
        </button>
        <span className="text-xs text-neutral-600">Scroll to zoom, drag to pan.</span>
        {pollError && <span className="text-xs text-yellow-500">Live updates paused -- retrying...</span>}
      </div>

      <div className="overflow-hidden rounded border border-neutral-800/60">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className={`mx-auto h-auto max-h-[640px] w-full touch-none select-none ${isPanning ? "cursor-grabbing" : "cursor-grab"}`}
          role="img"
          aria-label="Network topology"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClickCapture={handleClickCapture}
        >
          <g transform={`translate(${view.panX} ${view.panY}) scale(${view.zoom})`}>
            {edges.map((e) => {
              const from = positions.get(e.sourceId);
              const to = positions.get(e.destId);
              if (!from || !to) return null;
              const mx = (from.x + to.x) / 2;
              const my = (from.y + to.y) / 2;
              const color = STATUS_COLOR[e.status] ?? STATUS_COLOR.UNKNOWN;
              const opacity = matchedEdgeIds.has(e.id) ? 1 : DIMMED_OPACITY;
              return (
                <Link key={e.id} href={`/tunnels/${e.id}`} className="cursor-pointer">
                  <g opacity={opacity}>
                    <title>{`${e.name} (${e.core}) -- ${e.status}`}</title>
                    {/* Wide, invisible hit area -- the visible line is too thin to click reliably. */}
                    <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="transparent" strokeWidth={16} />
                    <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth={2} />
                    <rect x={mx - 38} y={my - 10} width={76} height={20} rx={4} fill="#171717" stroke={color} strokeWidth={1} />
                    <text x={mx} y={my + 4} textAnchor="middle" fontSize={10} fill={color}>
                      {e.core}
                    </text>
                  </g>
                </Link>
              );
            })}
            {nodes.map((n) => {
              const pos = positions.get(n.id)!;
              const status = serverOnlineStatus(n.lastSeenAt);
              const ringColor = SERVER_STATUS_COLOR[status];
              const opacity = matchedNodeIds.has(n.id) ? 1 : DIMMED_OPACITY;
              return (
                <Link key={n.id} href={`/servers/${n.id}`} className="cursor-pointer">
                  <g opacity={opacity}>
                    <title>{`${n.name}${n.location ? ` · ${n.location}` : ""} · ${SERVER_STATUS_LABEL[status]}`}</title>
                    <circle cx={pos.x} cy={pos.y} r={28} fill="#0a0a0a" stroke={ringColor} strokeWidth={3} />
                    <text x={pos.x} y={pos.y - 2} textAnchor="middle" fontSize={11} fill="#e5e5e5" fontWeight={500}>
                      {n.name.length > 10 ? n.name.slice(0, 9) + "…" : n.name}
                    </text>
                    {n.location && (
                      <text x={pos.x} y={pos.y + 12} textAnchor="middle" fontSize={9} fill="#737373">
                        {n.location}
                      </text>
                    )}
                  </g>
                </Link>
              );
            })}
          </g>
        </svg>
      </div>

      <div className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs">
        <div className="flex flex-wrap items-center justify-center gap-3">
          <span className="text-neutral-600">Servers:</span>
          {(Object.keys(SERVER_STATUS_COLOR) as ServerOnlineStatus[]).map((status) => (
            <span key={status} className="flex items-center gap-1.5 text-neutral-400">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERVER_STATUS_COLOR[status] }} />
              {SERVER_STATUS_LABEL[status]}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <span className="text-neutral-600">Tunnels:</span>
          {Object.entries(STATUS_COLOR).map(([status, color]) => (
            <span key={status} className="flex items-center gap-1.5 text-neutral-400">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
              {status.charAt(0) + status.slice(1).toLowerCase()}
            </span>
          ))}
        </div>
      </div>

      {edges.length > 0 && (
        <ul className="mx-auto mt-6 max-w-md space-y-1 text-sm">
          {edges.map((e) => (
            <li key={e.id} style={{ opacity: matchedEdgeIds.has(e.id) ? 1 : DIMMED_OPACITY }}>
              <Link href={`/tunnels/${e.id}`} className="text-neutral-400 hover:text-neutral-200 hover:underline">
                {e.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
