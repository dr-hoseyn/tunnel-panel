import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const findUniqueMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    server: { findUnique: (...args: unknown[]) => findUniqueMock(...args) },
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
const agentGetMock = vi.fn();
vi.mock("@/lib/agent-client", () => ({
  agentGet: (...args: unknown[]) => agentGetMock(...args),
  AgentError: FakeAgentError,
}));

const { GET } = await import("./route");

function ctx(id: string, core: string) {
  return { params: Promise.resolve({ id, core }) };
}

function sessionWithRole(role: string | undefined) {
  return { user: { id: "u1", email: "viewer@example.com", role } };
}

const fakeServer = {
  id: "s1",
  name: "vps1",
  host: "1.2.3.4",
  agentPort: 8443,
  agentTokenEnc: "enc-token",
  tlsFingerprint: "aa:bb",
};

beforeEach(() => {
  authMock.mockReset();
  findUniqueMock.mockReset();
  agentGetMock.mockReset();
});

describe("GET /api/v1/servers/[id]/agent-cores/[core]/verify", () => {
  it("returns 401 with no session", async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost"), ctx("s1", "backhaul"));
    expect(res.status).toBe(401);
    expect(agentGetMock).not.toHaveBeenCalled();
  });

  it("returns a report for any authenticated role (VIEWER included)", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    findUniqueMock.mockResolvedValue(fakeServer);
    agentGetMock.mockResolvedValue(
      JSON.stringify({ core: "backhaul", path: "/etc/tunnel-agent/bin/backhaul/backhaul_premium", status: "installed and healthy", has_previous: false }),
    );

    const res = await GET(new Request("http://localhost"), ctx("s1", "backhaul"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.report.core).toBe("backhaul");
    expect(body.report.has_previous).toBe(false);
    expect(agentGetMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: "1.2.3.4", port: 8443, tlsFingerprint: "aa:bb" }),
      "/api/v1/agent/cores/backhaul/verify",
    );
  });

  it("returns 404 when the server doesn't exist", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    findUniqueMock.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost"), ctx("missing", "backhaul"));
    expect(res.status).toBe(404);
    expect(agentGetMock).not.toHaveBeenCalled();
  });

  it("propagates a 4xx from the agent as the same status", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    findUniqueMock.mockResolvedValue(fakeServer);
    agentGetMock.mockRejectedValue(new FakeAgentError("agent returned HTTP 400: unknown tunnel core", 400));

    const res = await GET(new Request("http://localhost"), ctx("s1", "no-such-core"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("unknown tunnel core");
  });

  it("defaults to 502 for a non-4xx agent failure", async () => {
    authMock.mockResolvedValue(sessionWithRole("VIEWER"));
    findUniqueMock.mockResolvedValue(fakeServer);
    agentGetMock.mockRejectedValue(new FakeAgentError("agent request timed out"));

    const res = await GET(new Request("http://localhost"), ctx("s1", "backhaul"));
    expect(res.status).toBe(502);
  });
});
