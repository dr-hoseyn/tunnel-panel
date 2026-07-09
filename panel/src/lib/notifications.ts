import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { Severity } from "@/generated/prisma/enums";

/**
 * Small standalone module for creating Notification rows -- kept separate
 * from notification-sampler.ts so anything (the sampler today, a future
 * direct call site tomorrow) can raise a user-facing alert through one
 * function without needing to know the idempotency mechanics.
 *
 * Notifications are NOT the same thing as Event: Event is the full audit/
 * deployment/runtime log feed backing the Logs page, Notification is a
 * curated, dismissible subset meant for the header bell.
 */

export interface NotifyInput {
  type: string;
  severity: Severity;
  title: string;
  message: string;
  /** Ties this notification back to the Event it was derived from, if any.
   * @unique in the schema -- passing the same sourceEventId twice is expected
   * (notification-sampler.ts rescans a lookback window every cycle) and is
   * silently ignored rather than thrown, so callers never need to
   * pre-check "have I already converted this Event?" themselves. */
  sourceEventId?: string | null;
  serverId?: string | null;
  tunnelId?: string | null;
}

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/** Creates a Notification, swallowing only the specific "sourceEventId
 * already used" race/duplicate case -- any other failure still throws. */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        type: input.type,
        severity: input.severity,
        title: input.title,
        message: input.message,
        sourceEventId: input.sourceEventId ?? null,
        serverId: input.serverId ?? null,
        tunnelId: input.tunnelId ?? null,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === UNIQUE_CONSTRAINT_VIOLATION
    ) {
      return;
    }
    throw err;
  }
}
