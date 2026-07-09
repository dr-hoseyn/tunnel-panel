import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { DeploymentKind, DeploymentStatus } from "@/generated/prisma/enums";

/**
 * Persistent (DB-backed), per-tunnel-locked background job queue for tunnel
 * lifecycle operations. Every create/start/stop/restart/delete goes through
 * here rather than running synchronously in an API route handler:
 *  - Deployment rows make progress and history durable across reloads and
 *    multiple browser tabs (the SSE stream in a later milestone tails
 *    `steps`).
 *  - Different tunnels' jobs run fully concurrently; the *same* tunnel never
 *    has two jobs racing each other (each tunnel's jobs are chained onto
 *    one promise, satisfying the per-tunnel-lock requirement without a
 *    separate lock manager).
 *  - Retries (bounded, backed off) happen here for transient agent-
 *    unreachable failures; validation-shaped failures (4xx from the agent)
 *    are not retried, since retrying identical bad input just fails again.
 *  - Cancellation is a real AbortSignal a handler can check between steps.
 */

export interface StepLog {
  step: string;
  status: "started" | "ok" | "failed";
  message?: string;
  timestamp: string;
}

export interface JobContext {
  deploymentId: string;
  tunnelId: string;
  signal: AbortSignal;
  step: (name: string, status: StepLog["status"], message?: string) => Promise<void>;
}

type JobHandler = (ctx: JobContext) => Promise<void>;

const activeByTunnel = new Map<string, Promise<void>>();
const abortControllers = new Map<string, AbortController>();

export class DeploymentQueue {
  static async enqueue(params: {
    tunnelId: string;
    kind: DeploymentKind;
    maxAttempts?: number;
    handler: JobHandler;
  }): Promise<string> {
    const maxAttempts = params.maxAttempts ?? (await getSettings()).deploymentMaxAttempts;
    const deployment = await prisma.deployment.create({
      data: {
        tunnelId: params.tunnelId,
        kind: params.kind,
        status: DeploymentStatus.QUEUED,
        maxAttempts,
        steps: [],
      },
    });

    const controller = new AbortController();
    abortControllers.set(deployment.id, controller);

    const previous = activeByTunnel.get(params.tunnelId) ?? Promise.resolve();
    const run = previous
      .catch(() => {
        /* a previous job's rejection must not block this tunnel's queue forever */
      })
      .then(() => runJob(deployment.id, params.tunnelId, params.handler, maxAttempts, controller.signal))
      .finally(() => abortControllers.delete(deployment.id));

    activeByTunnel.set(params.tunnelId, run);
    return deployment.id;
  }

  /** Requests cancellation of an in-flight deployment. Returns false if the
   * deployment isn't currently running (already finished, or unknown id). */
  static cancel(deploymentId: string): boolean {
    const controller = abortControllers.get(deploymentId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}

async function appendStep(deploymentId: string, entry: StepLog): Promise<void> {
  const current = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { steps: true },
  });
  const steps = Array.isArray(current?.steps) ? (current.steps as unknown as StepLog[]) : [];
  steps.push(entry);
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { steps: steps as unknown as object },
  });
}

async function runJob(
  deploymentId: string,
  tunnelId: string,
  handler: JobHandler,
  maxAttempts: number,
  signal: AbortSignal,
): Promise<void> {
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: DeploymentStatus.RUNNING, startedAt: new Date() },
  });

  const step = (name: string, status: StepLog["status"], message?: string) =>
    appendStep(deploymentId, { step: name, status, message, timestamp: new Date().toISOString() });

  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) {
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: DeploymentStatus.CANCELLED, finishedAt: new Date() },
      });
      return;
    }
    try {
      await prisma.deployment.update({ where: { id: deploymentId }, data: { attempt } });
      await handler({ deploymentId, tunnelId, signal, step });
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: DeploymentStatus.SUCCEEDED, finishedAt: new Date() },
      });
      return;
    } catch (err) {
      if (signal.aborted) {
        await prisma.deployment.update({
          where: { id: deploymentId },
          data: { status: DeploymentStatus.CANCELLED, finishedAt: new Date() },
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isRetryable(err) && attempt < maxAttempts) {
        await step("retry", "failed", `attempt ${attempt} failed: ${message} -- retrying`);
        await sleep(backoffMs(attempt));
        continue;
      }
      await step("failed", "failed", message);
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: DeploymentStatus.FAILED, finishedAt: new Date() },
      });
      return;
    }
  }
}

/** Only network-shaped agent failures are retryable, and only by name, not
 * merely by duck-typing "has a .status property" -- OrchestratorError also
 * has a `.status` (e.g. 404 "server not found", 409 "already exists") and
 * previously matched the old broad check too, and any *other* thrown value
 * with no `.status` at all (a TypeError from a real bug, a Prisma error)
 * used to default to retryable, silently retrying a programming error up to
 * maxAttempts times with backoff instead of surfacing it immediately.
 * AgentError without an HTTP status means the request itself failed to
 * complete (timeout, connection refused, DNS) -- worth a retry. An AgentError
 * with a 4xx means the agent explicitly rejected our request (bad spec,
 * conflict, unknown core); retrying identical input would just fail
 * identically. */
function isRetryable(err: unknown): boolean {
  if (err instanceof Error && err.name === "AgentError") {
    const status = (err as Error & { status?: number }).status;
    return status === undefined || status >= 500;
  }
  return false;
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until a deployment finishes -- used by API routes that want to
 * respond only once a short-running operation (start/stop/restart) has
 * actually completed, rather than making every caller follow the SSE
 * stream for something that usually takes under a second. */
export async function waitForDeployment(deploymentId: string, timeoutMs = 120_000): Promise<DeploymentStatus> {
  const start = Date.now();
  for (;;) {
    const deployment = await prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { status: true },
    });
    if (!deployment) throw new Error("deployment not found");
    if (deployment.status !== DeploymentStatus.QUEUED && deployment.status !== DeploymentStatus.RUNNING) {
      return deployment.status;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for deployment to finish");
    }
    await sleep(500);
  }
}
