import Link from "next/link";

interface NodeInfo {
  id: string;
  name: string;
  location: string | null;
}

interface EdgeInfo {
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

/** Hand-rolled SVG network map -- servers placed evenly around a circle
 * (no force-directed-layout dependency needed at the node counts this
 * panel realistically manages), tunnels drawn as labeled, status-colored
 * edges between them. */
export function TopologyMap({ nodes, edges }: { nodes: NodeInfo[]; edges: EdgeInfo[] }) {
  if (nodes.length === 0) {
    return <p className="text-sm text-neutral-500">No servers registered yet.</p>;
  }

  const size = 640;
  const center = size / 2;
  const radius = nodes.length === 1 ? 0 : size / 2 - 90;

  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2;
    positions.set(n.id, {
      x: center + radius * Math.cos(angle),
      y: center + radius * Math.sin(angle),
    });
  });

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto h-auto w-full max-w-2xl" role="img" aria-label="Network topology">
        {edges.map((e) => {
          const from = positions.get(e.sourceId);
          const to = positions.get(e.destId);
          if (!from || !to) return null;
          const mx = (from.x + to.x) / 2;
          const my = (from.y + to.y) / 2;
          const color = STATUS_COLOR[e.status] ?? STATUS_COLOR.UNKNOWN;
          return (
            <g key={e.id}>
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth={2} />
              <rect x={mx - 38} y={my - 10} width={76} height={20} rx={4} fill="#171717" stroke={color} strokeWidth={1} />
              <text x={mx} y={my + 4} textAnchor="middle" fontSize={10} fill={color}>
                {e.core}
              </text>
            </g>
          );
        })}
        {nodes.map((n) => {
          const pos = positions.get(n.id)!;
          return (
            <g key={n.id}>
              <circle cx={pos.x} cy={pos.y} r={28} fill="#0a0a0a" stroke="#404040" strokeWidth={1.5} />
              <text x={pos.x} y={pos.y - 2} textAnchor="middle" fontSize={11} fill="#e5e5e5" fontWeight={500}>
                {n.name.length > 10 ? n.name.slice(0, 9) + "…" : n.name}
              </text>
              {n.location && (
                <text x={pos.x} y={pos.y + 12} textAnchor="middle" fontSize={9} fill="#737373">
                  {n.location}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="mt-6 flex flex-wrap justify-center gap-4 text-xs">
        {Object.entries(STATUS_COLOR).map(([status, color]) => (
          <span key={status} className="flex items-center gap-1.5 text-neutral-400">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            {status.charAt(0) + status.slice(1).toLowerCase()}
          </span>
        ))}
      </div>

      {edges.length > 0 && (
        <ul className="mx-auto mt-6 max-w-md space-y-1 text-sm">
          {edges.map((e) => (
            <li key={e.id}>
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
