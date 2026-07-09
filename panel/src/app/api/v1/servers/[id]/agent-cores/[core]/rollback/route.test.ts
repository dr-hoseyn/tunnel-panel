import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const findUniqueMock = vi.fn();
const eventCreateMock = vi.fn(async () => ({}));
vi.mock("@/lib/db", () => ({
  prisma: {
    server: { findUnique: (...args: unknown[]) => findUniqueMock(...args) },
    event: { create: (...args: unknown[]) => eventCreateMock(...args) },
  },
}));

vi.mock("@/lib/crypto", () => ({ decryptSecret: (v: string) => v }));

class FakeAgentError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "AgentError";
  }
}
const agentPostMock = vi.fn();
vi.mock("@/lib/agent-client", () => ({
  agentPost: (...args: unknown[]) => agentPostMock(...args),
  AgentError: FakeAgentError,
}));

const { POST } = await import("./route");

function ctx(id: string, core: string) {
  return { params: Promise.resolve({ id, core }) };
}

function sessionWithRole(role: string | undefined) {
  return { user: { id: "u1", email: "admin@example.com", role } };
}

const fakeServer = {
  id: "s1",
  name: "vps1",
  host: "1.2.3.4",
  agentPort: 8443,
  agentTokenEnc: "enc-token",
  tlsFingerprint: "aa:bb",
};

function postRequest() {
  return new Request("http://localhost", { method: "POST" });
}

beforeEach(() => {
  authMock.mockReset();
  findUniqueMock.mockReset();
  agentPostMock.mockReset();
  eventCreateMock.mockClear();
});

describe("POST /api/v1/servers/[id]/agent-cores/[core]/rollback", () => {
  it("returns 401 with no session", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(postRequest(), ctx("s1", "backhaul"));
    expect(res.status).toBe(401);
    expect(agentPostMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-ADMIN role", async () => {
    authMock.mockResolvedValue(sessionWithRole("OPERATOR"));
    const res = await POST(postRequest(), ctx("s1", "backhaul"));
    expect(res.status).toBe(403);
    expect(agentPostMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the server doesn't exist", async () => {
    authMock.mockResolvedValue(sessionWithRole("ADMIN"));
    findUniqueMock.mockResolvedValue(null);
    const res = await POST(postRequest(), ctx("missing", "backhaul"));
    expect(res.status).toBe(404);
    expect(agentPostMock).not.toHaveBeenCalled();
  });

  it("rolls back for ADMIN and records an audit event", async () => {
    authMock.mockResolvedValue(sessionWithRole("ADMIN"));
    findUniqueMock.mockResolvedValue(fakeServer);
    agentPostMock.mockResolvedValue(
      JSON.stringify({ core: "backhaul", path: "/etc/tunnel-agent/bin/backhaul/backhaul_premium", status: "installed and healthy", has_previous: true }),
    );

    const res = await POST(postRequest(), ctx("s1", "backhaul"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.report.has_previous).toBe(true);
    expect(agentPostMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: "1.2.3.4", port: 8443 }),
      "/api/v1/agent/cores/backhaul/rollback",
    );
    expect(eventCreateMock).toHaveBeenCalledTimes(1);
    const eventData = eventCreateMock.mock.calls[0][0].data;
    expect(eventData.type).toBe("CORE_ROLLED_BACK");
    expect(eventData.category).toBe("AUDIT");
    expect(eventData.serverId).toBe("s1");
  });

  it("returns 404 with a clear message when the agent has no previous version, and does not log an audit event", async () => {
    authMock.mockResolvedValue(sessionWithRole("ADMIN"));
    findUniqueMock.mockResolvedValue(fakeServer);
    agentPostMock.mockRejectedValue(new FakeAgentError("agent returned HTTP 404: no previous version available", 404));

    const res = await POST(postRequest(), ctx("s1", "backhaul"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("no previous version available");
    expect(eventCreateMock).not.toHaveBeenCalled();
  });

  it("propagates an unknown-core 4xx from the agent", async () => {
    authMock.mockResolvedValue(sessionWithRole("ADMIN"));
    findUniqueMock.mockResolvedValue(fakeServer);
    agentPostMock.mockRejectedValue(new FakeAgentError("agent returned HTTP 400: unknown tunnel core", 400));

    const res = await POST(postRequest(), ctx("s1", "no-such-core"));
    expect(res.status).toBe(400);
    expect(eventCreateMock).not.toHaveBeenCalled();
  });

  it("defaults to 502 for a non-4xx agent failure", async () => {
    authMock.mockResolvedValue(sessionWithRole("ADMIN"));
    findUniqueMock.mockResolvedValue(fakeServer);
    agentPostMock.mockRejectedValue(new FakeAgentError("agent request timed out"));

    const res = await POST(postRequest(), ctx("s1", "backhaul"));
    expect(res.status).toBe(502);
    expect(eventCreateMock).not.toHaveBeenCalled();
  });
});
