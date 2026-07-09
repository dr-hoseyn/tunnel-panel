import { prisma } from "@/lib/db";
import { requireRoleResponse } from "@/lib/rbac";

/**
 * Server-Sent Events stream of a deployment's progress -- the create-tunnel
 * wizard's live progress view and the restart/delete action UIs read from
 * this instead of polling. Pushes the current `steps` array (and status)
 * whenever it changes, and closes the stream once the deployment reaches a
 * terminal status.
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

      let lastStepCount = -1;
      let lastStatus = "";

      const poll = async () => {
        if (closed) return;
        const deployment = await prisma.deployment.findUnique({ where: { id } });
        if (!deployment) {
          send("error", { message: "deployment not found" });
          controller.close();
          closed = true;
          return;
        }
        const steps = Array.isArray(deployment.steps) ? deployment.steps : [];
        if (steps.length !== lastStepCount || deployment.status !== lastStatus) {
          lastStepCount = steps.length;
          lastStatus = deployment.status;
          send("update", { status: deployment.status, steps });
        }
        const terminal = deployment.status === "SUCCEEDED" || deployment.status === "FAILED" || deployment.status === "CANCELLED";
        if (terminal) {
          send("done", { status: deployment.status });
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
