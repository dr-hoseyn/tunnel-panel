import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const requestMock = vi.fn();

vi.mock("node:https", () => ({
  default: { request: (...args: unknown[]) => requestMock(...args) },
}));

const { agentGet, agentPost, agentDelete, AgentError } = await import("./agent-client");

class FakeRequest extends EventEmitter {
  writtenChunks: string[] = [];
  ended = false;
  destroyed = false;
  write(chunk: string) {
    this.writtenChunks.push(chunk);
  }
  end() {
    this.ended = true;
  }
  destroy() {
    this.destroyed = true;
  }
}

class FakeResponse extends EventEmitter {
  constructor(public statusCode: number) {
    super();
  }
}

interface CapturedOptions {
  method: string;
  path: string;
  headers: Record<string, string | number | undefined>;
  checkServerIdentity: (hostname: string, cert: { fingerprint256: string }) => Error | undefined;
}

function capturedOptions(): CapturedOptions {
  return requestMock.mock.calls[0][0] as CapturedOptions;
}

/** Stands in for the https.request(options, callback) contract without a
 * real TLS server -- this module's own logic (method/header/body shaping,
 * status-code handling, fingerprint pinning callback) is what's under test
 * here, not Node's TLS stack, which is out of scope for a unit test. */
function mockAgentResponse(statusCode: number, body: string) {
  const req = new FakeRequest();
  requestMock.mockImplementation((_options: unknown, callback: (res: FakeResponse) => void) => {
    const res = new FakeResponse(statusCode);
    queueMicrotask(() => {
      callback(res);
      res.emit("data", body);
      res.emit("end");
    });
    return req;
  });
  return req;
}

const target = { host: "1.2.3.4", port: 8443, token: "tok", tlsFingerprint: "FF:FF" };

describe("agentPost", () => {
  afterEach(() => requestMock.mockReset());

  it("sends method POST with a JSON body and bearer token", async () => {
    mockAgentResponse(201, '{"ok":true}');
    const result = await agentPost(target, "/api/v1/managed-tunnels", { id: "t1" });
    expect(result).toBe('{"ok":true}');

    const options = capturedOptions();
    expect(options.method).toBe("POST");
    expect(options.path).toBe("/api/v1/managed-tunnels");
    expect(options.headers.Authorization).toBe("Bearer tok");
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  it("supports a bodyless POST (e.g. start/stop/restart)", async () => {
    mockAgentResponse(200, '{"process":"running"}');
    await agentPost(target, "/api/v1/managed-tunnels/t1/start");
    const options = capturedOptions();
    expect(options.headers["Content-Type"]).toBeUndefined();
  });

  it("rejects with AgentError on a non-2xx status, including the response body", async () => {
    mockAgentResponse(400, '{"error":"bad request"}');
    await expect(agentPost(target, "/api/v1/managed-tunnels", {})).rejects.toMatchObject({
      constructor: AgentError,
      status: 400,
    });
  });
});

describe("agentDelete", () => {
  afterEach(() => requestMock.mockReset());

  it("sends method DELETE with no body", async () => {
    mockAgentResponse(204, "");
    await agentDelete(target, "/api/v1/managed-tunnels/t1");
    const options = capturedOptions();
    expect(options.method).toBe("DELETE");
    expect(options.headers["Content-Type"]).toBeUndefined();
  });
});

describe("agentGet", () => {
  afterEach(() => requestMock.mockReset());

  it("pins on the target's fingerprint via checkServerIdentity", async () => {
    mockAgentResponse(200, "ok");
    await agentGet(target, "/api/v1/health");
    const options = capturedOptions();

    const mismatch = options.checkServerIdentity("host", { fingerprint256: "WRONG" });
    expect(mismatch).toBeInstanceOf(Error);

    const match = options.checkServerIdentity("host", { fingerprint256: target.tlsFingerprint });
    expect(match).toBeUndefined();
  });

  it("times out and rejects with AgentError", async () => {
    const req = new FakeRequest();
    requestMock.mockImplementation(() => req);
    const pending = agentGet(target, "/api/v1/health");
    req.emit("timeout");
    await expect(pending).rejects.toThrow(AgentError);
    expect(req.destroyed).toBe(true);
  });
});
