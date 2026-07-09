import { prisma } from "@/lib/db";
import { agentGet, AgentError } from "@/lib/agent-client";
import { decryptSecret } from "@/lib/crypto";
import { requireRoleResponse } from "@/lib/rbac";

/**
 * SSE "live tail" of a tunnel's logs. The agent only exposes a snapshot
 * endpoint (GET .../logs?lines=N, see agent/internal/server/tunnel_handlers.go)
 * -- there's no kernel-level `journalctl -f` streaming over HTTP on the
 * agent side (a real follow-mode endpoint is future agent work, not
 * implemented in this pass). This route delivers a live-tail *experience*
 * to the browser by polling that snapshot every few seconds and pushing
 * only the lines not already seen -- a real SSE connection either way, no
 * client-side poll loop, just not a kernel-level follow underneath it.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const tunnel = await prisma.tunnel.findUnique({
    where: { id },
    include: { sourceServer: true, destServer: true },
  });
  if (!tunnel) {
    return new Response(JSON.stringify({ error: "tunnel not found" }), { status: 404 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  const seen = new Set<string>();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      let ticks = 0;
      const maxTicks = 400; // ~10 minutes at 1.5s

      const poll = async () => {
        if (closed) return;
        for (const [label, server] of [
          ["source", tunnel!.sourceServer],
          ["destination", tunnel!.destServer],
        ] as const) {
          try {
            const body = await agentGet(
              {
                host: server.host,
                port: server.agentPort,
                token: decryptSecret(server.agentTokenEnc),
                tlsFingerprint: server.tlsFingerprint,
              },
              `/api/v1/managed-tunnels/${id}/logs?lines=50`,
            );
            const parsed = JSON.parse(body) as { lines: string[] };
            for (const line of parsed.lines) {
              const key = `${label}:${line}`;
              if (!seen.has(key)) {
                seen.add(key);
                send("line", { side: label, server: server.name, line });
              }
            }
          } catch (err) {
            const message = err instanceof AgentError ? err.message : "agent request failed";
            send("side-error", { side: label, server: server.name, message });
          }
        }
        ticks += 1;
        if (closed || ticks >= maxTicks) {
          controller.close();
          closed = true;
          return;
        }
        setTimeout(poll, 1500);
      };

      await poll();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
