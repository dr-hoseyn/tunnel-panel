import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

/**
 * Server-Sent Events stream of a tunnel's status -- backed by
 * instrumentation.ts's background sampler, which is what actually updates
 * `status`/`lastCheckedAt` on a ~15s interval independent of anyone having
 * this page open. This route just pushes that DB state to the browser
 * without a client-side poll loop, closing after the connection is idle for
 * a while (the browser's EventSource reconnects automatically).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRoleResponse("VIEWER");
  if ("response" in auth) return auth.response;

  const { id } = await params;
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      let lastPayload = "";
      let ticks = 0;
      const maxTicks = 800; // ~10 minutes at 750ms -- then let the client's EventSource reconnect

      const poll = async () => {
        if (closed) return;
        const tunnel = await prisma.tunnel.findUnique({
          where: { id },
          select: { status: true, lastCheckedAt: true, lastRestartAt: true },
        });
        if (!tunnel) {
          send("error", { message: "tunnel not found" });
          controller.close();
          closed = true;
          return;
        }
        const payload = JSON.stringify(tunnel);
        if (payload !== lastPayload) {
          lastPayload = payload;
          send("update", tunnel);
        }
        ticks += 1;
        if (ticks >= maxTicks) {
          controller.close();
          closed = true;
          return;
        }
        setTimeout(poll, 750);
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
