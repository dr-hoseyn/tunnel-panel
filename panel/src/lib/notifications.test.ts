import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";

const createMock = vi.fn();
vi.mock("@/lib/db", () => ({ prisma: { notification: { create: (...args: unknown[]) => createMock(...args) } } }));

const { notify } = await import("./notifications");

beforeEach(() => {
  createMock.mockReset();
});

describe("notify", () => {
  it("creates a Notification with the given fields, defaulting optional links to null", async () => {
    createMock.mockResolvedValue({});

    await notify({ type: "TUNNEL_HEALTH_FAILED", severity: "ERROR", title: "t", message: "m" });

    expect(createMock).toHaveBeenCalledWith({
      data: {
        type: "TUNNEL_HEALTH_FAILED",
        severity: "ERROR",
        title: "t",
        message: "m",
        sourceEventId: null,
        serverId: null,
        tunnelId: null,
      },
    });
  });

  it("swallows a unique-constraint violation on sourceEventId rather than throwing", async () => {
    createMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`sourceEventId`)", {
        code: "P2002",
        clientVersion: "7.8.0",
      }),
    );

    await expect(
      notify({ type: "X", severity: "INFO", title: "t", message: "m", sourceEventId: "evt-1" }),
    ).resolves.toBeUndefined();
  });

  it("re-throws any other error", async () => {
    createMock.mockRejectedValue(new Error("db is on fire"));

    await expect(notify({ type: "X", severity: "INFO", title: "t", message: "m" })).rejects.toThrow("db is on fire");
  });

  it("re-throws a known Prisma error whose code isn't the unique-constraint one", async () => {
    createMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Record not found", { code: "P2025", clientVersion: "7.8.0" }),
    );

    await expect(notify({ type: "X", severity: "INFO", title: "t", message: "m" })).rejects.toMatchObject({
      code: "P2025",
    });
  });
});
