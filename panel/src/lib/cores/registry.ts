import { z } from "zod";
import { TunnelCore } from "@/generated/prisma/enums";

/**
 * The single source of truth for what a tunnel core needs, both for the
 * create-tunnel wizard (which extra fields to render) and the orchestrator
 * (which side gets the forwarded-ports array, which agent driver name to
 * call). Adding a future core means adding one descriptor here -- the
 * wizard, the orchestrator, and the API routes all read this generically
 * and never branch on core name themselves.
 *
 * Source/destination -> server/client role convention (fixed across every
 * core, matching ha-tunnel-manager's own IRAN=server/KHAREJ=client naming,
 * which the user's own "Source: Iran / Destination: Germany" example
 * matches): the *source* server always plays the driver's "server" role,
 * the *destination* server always plays "client". What differs per core is
 * only which of those two sides the forwarded-port config belongs on (see
 * portsOn) -- confirmed against ha-tunnel-manager's core/README.md, which
 * documents that Backhaul/Rathole/FRP put it on the server(IRAN) side while
 * Hysteria2/TUIC put it on the client(KHAREJ) side.
 */

export type PortsOn = "server" | "client" | "both";

export interface ExtraField {
  key: string;
  label: string;
  type: "text" | "password" | "select";
  options?: string[];
  placeholder?: string;
  defaultValue?: string;
}

export interface CoreDescriptor {
  core: TunnelCore;
  /** The name agent/internal/tunnels.Register() uses for this core -- the
   * literal string sent as `core` in POST /api/v1/managed-tunnels. */
  agentCore: string;
  label: string;
  description: string;
  portsOn: PortsOn;
  defaultPort: number;
  firewallProto: "tcp" | "udp";
  extraFields: ExtraField[];
  extraSchema: z.ZodType<Record<string, string | undefined>>;
}

const backhaul: CoreDescriptor = {
  core: TunnelCore.BACKHAUL,
  agentCore: "backhaul",
  label: "Backhaul",
  description: "High-throughput multiplexed tunnel with token auth. Good general-purpose default.",
  portsOn: "server",
  defaultPort: 3080,
  firewallProto: "tcp",
  extraFields: [
    {
      key: "transport",
      label: "Transport",
      type: "select",
      options: ["tcp", "tcpmux", "ws", "wsmux"],
      defaultValue: "tcp",
    },
  ],
  extraSchema: z.object({ transport: z.enum(["tcp", "tcpmux", "ws", "wsmux"]).optional() }),
};

const rathole: CoreDescriptor = {
  core: TunnelCore.RATHOLE,
  agentCore: "rathole",
  label: "Rathole",
  description: "Lightweight Rust tunnel over plain TCP with simple shared-token auth.",
  portsOn: "server",
  defaultPort: 2333,
  firewallProto: "tcp",
  extraFields: [],
  extraSchema: z.object({}),
};

const gost: CoreDescriptor = {
  core: TunnelCore.GOST,
  agentCore: "gost",
  label: "GOST",
  description:
    "Relay-chain based tunnel. Every GOST tunnel on a given server shares one daemon process.",
  portsOn: "both",
  defaultPort: 9000,
  firewallProto: "tcp",
  extraFields: [
    {
      key: "transport",
      label: "Chain transport",
      type: "select",
      options: ["tcp", "tls", "ws", "wss"],
      defaultValue: "tcp",
    },
  ],
  extraSchema: z.object({ transport: z.enum(["tcp", "tls", "ws", "wss"]).optional() }),
};

const hysteria2: CoreDescriptor = {
  core: TunnelCore.HYSTERIA2,
  agentCore: "hysteria2",
  label: "Hysteria2",
  description:
    "QUIC/UDP tunnel, DPI/throttling resistant. Forwarded ports are configured on the destination side.",
  portsOn: "client",
  defaultPort: 36712,
  firewallProto: "udp",
  extraFields: [
    { key: "obfs_password", label: "Obfuscation password (optional)", type: "password" },
    { key: "sni", label: "TLS SNI (optional)", type: "text" },
  ],
  extraSchema: z.object({ obfs_password: z.string().optional(), sni: z.string().optional() }),
};

const registry: Record<TunnelCore, CoreDescriptor> = {
  BACKHAUL: backhaul,
  RATHOLE: rathole,
  GOST: gost,
  HYSTERIA2: hysteria2,
};

export function getCoreDescriptor(core: TunnelCore): CoreDescriptor {
  const descriptor = registry[core];
  if (!descriptor) {
    throw new Error(`unknown tunnel core: ${core}`);
  }
  return descriptor;
}

export function listCoreDescriptors(): CoreDescriptor[] {
  return Object.values(registry);
}
