import { describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ControlFrames, EnrollmentControl, EnrollmentRefusal, attachControlInput, type EnrollmentEvent } from "./control.ts";
import { authEvent, enroll, enrollmentFlow, uploadFields } from "./enrollment.ts";

const grant = {
  access_token: "fixture-access-never-output",
  refresh_token: "fixture-refresh-never-output",
  expires_in: 3600,
  account: { uuid: "fixture-account", email_address: "new@example.invalid" },
  organization: { uuid: "fixture-org", name: "Fixture" },
};

// Real built-in SDK flow and token exchange via its supported controller.fetch seam.
// Any unplanned provider request fails locally rather than reaching the network.
const tokenFetch: FetchImpl = async (input, init) => {
  expect(String(input)).toBe("https://api.anthropic.com/v1/oauth/token");
  expect(init?.method).toBe("POST");
  const request = JSON.parse(String(init?.body));
  expect(request.code).toBe("fixture-code");
  expect(typeof request.state).toBe("string");
  return Response.json(grant);
};

function manualEnrollment(events: EnrollmentEvent[], form: "url" | "query" | "code-state" = "url"): EnrollmentControl {
  let state = "";
  let redirect = "";
  const control = new EnrollmentControl(event => {
    events.push(event);
    if (event.type === "auth") {
      const url = new URL(event.url);
      state = url.searchParams.get("state")!;
      redirect = url.searchParams.get("redirect_uri")!;
    }
    if (event.type === "prompt") queueMicrotask(() => {
      const query = `code=fixture-code&state=${encodeURIComponent(state)}`;
      control.receive({ type: "response", promptId: event.promptId, value: form === "url" ? `${redirect}?${query}` : form === "query" ? query : `fixture-code#${state}` });
    });
  });
  control.receive({ type: "start", provider: "anthropic" });
  return control;
}

describe("private OAuth control", () => {
  test("consumes correlated responses once and aborts stale replay without echoing input", async () => {
    const events: EnrollmentEvent[] = [];
    const control = new EnrollmentControl(event => events.push(event));
    try {
      control.receive({ type: "start", provider: "anthropic" });
      const pending = control.requestCallback();
      const prompt = events.find(event => event.type === "prompt");
      if (prompt?.type !== "prompt") throw new Error("Missing prompt");
      const response = { type: "response", promptId: prompt.promptId, value: "private-code#private-state" };
      control.receive(response);
      expect(await pending).toBe(response.value);
      control.receive(response);
      expect(control.signal.reason).toBeInstanceOf(EnrollmentRefusal);
      expect(control.signal.reason.code).toBe("stale_response");
      expect(JSON.stringify(events)).not.toContain("private-code");
      expect(JSON.stringify(events)).not.toContain("private-state");
    } finally { control.finish(); }
  });

  test("stale prompt IDs cannot satisfy a newly issued callback", async () => {
    const events: EnrollmentEvent[] = [];
    const control = new EnrollmentControl(event => events.push(event));
    try {
      const pending = control.requestCallback();
      const rejected = pending.catch(error => error);
      control.receive({ type: "response", promptId: "from-another-job", value: "secret#state" });
      expect(await rejected).toBeInstanceOf(EnrollmentRefusal);
      expect(control.signal.reason.code).toBe("stale_response");
      expect(events.filter(event => event.type === "prompt_closed")).toHaveLength(1);
    } finally { control.finish(); }
  });

  test("provider callback completion retracts its outstanding manual prompt", async () => {
    const control = new EnrollmentControl(() => {});
    const provider = new AbortController();
    try {
      const pending = control.requestCallback(provider.signal).catch(error => error);
      provider.abort();
      expect(await pending).toBeInstanceOf(EnrollmentRefusal);
      expect(control.signal.aborted).toBe(false);
      control.receive({ type: "response", promptId: "retired", value: "secret#state" });
      expect(control.signal.reason.code).toBe("stale_response");
    } finally { control.finish(); }
  });

  test("stdin disconnect cancels a pending provider response", async () => {
    const input = new PassThrough();
    const control = new EnrollmentControl(() => {});
    const detach = attachControlInput(input, control);
    try {
      const pending = control.requestCallback().catch(error => error);
      input.end();
      expect(await pending).toBeInstanceOf(EnrollmentRefusal);
      expect(control.signal.reason.code).toBe("disconnected");
    } finally { detach(); control.finish(); input.destroy(); }
  });

  test("deadline aborts a waiting prompt without provider cooperation", async () => {
    vi.useFakeTimers();
    const control = new EnrollmentControl(() => {}, 1000);
    try {
      const pending = control.requestCallback().catch(error => error);
      vi.advanceTimersByTime(1000);
      expect(await pending).toBeInstanceOf(EnrollmentRefusal);
      expect(control.signal.reason.code).toBe("timeout");
    } finally { control.finish(); vi.useRealTimers(); }
  });

  test("bounded frames accept split UTF-8 but refuse oversized and invalid encoding", () => {
    const values: unknown[] = [];
    const frames = new ControlFrames(value => values.push(value), 32);
    const bytes = Buffer.from('{"text":"é"}\n');
    const split = bytes.indexOf(0xc3) + 1;
    frames.push(bytes.subarray(0, split));
    frames.push(bytes.subarray(split));
    expect(values).toEqual([{ text: "é" }]);
    expect(() => frames.push(Buffer.alloc(33, 65))).toThrow(EnrollmentRefusal);
    frames.clear();
    expect(() => frames.push(Uint8Array.from([0xff, 10]))).toThrow(EnrollmentRefusal);
  });
});

describe("fresh-only SDK enrollment", () => {
  test("new in-memory SDK store cannot discover credentials from a previous invocation", async () => {
    const id = "fixture-ephemeral-enrollment";
    registerOAuthProvider({ id, name: "Fixture", async login() { return { access: grant.access_token, refresh: grant.refresh_token, expires: Date.now() + 60000 }; } });
    const firstStore = new SqliteAuthCredentialStore(new Database(":memory:"));
    const first = new AuthStorage(firstStore);
    const secondStore = new SqliteAuthCredentialStore(new Database(":memory:"));
    const second = new AuthStorage(secondStore);
    try {
      await first.login(id, { onAuth() {}, async onPrompt() { throw new Error("Unexpected prompt"); } });
      expect(firstStore.listAuthCredentials().map(row => row.provider)).toEqual([id]);
      expect(secondStore.listAuthCredentials()).toEqual([]);
    } finally { first.close(); second.close(); unregisterOAuthProvider(id); }
  });

  test("drives real callback/state exchange and uploads only its newly minted credential", async () => {
    const events: EnrollmentEvent[] = [];
    const control = manualEnrollment(events);
    const uploaded: Record<string, string | number | boolean>[] = [];
    await enroll(control, async fields => {
      uploaded.push({ ...fields });
      return { entries: [{ id: 1, provider: "anthropic", identityKey: "email:new@example.invalid|org:fixture-org" }] };
    }, tokenFetch);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.access).toBe(grant.access_token);
    expect(uploaded[0]?.refresh).toBe(grant.refresh_token);
    expect(uploaded[0]?.provider).toBe("anthropic");
    expect(events.at(-1)).toEqual({ type: "complete", provider: "anthropic", identity: { type: "oauth", email: "new@example.invalid", accountId: "fixture-account", orgId: "fixture-org", orgName: "Fixture" } });
    const output = JSON.stringify(events);
    expect(output).not.toContain(grant.access_token);
    expect(output).not.toContain(grant.refresh_token);
    expect(output).not.toContain("fixture-code");
  });

  test("upstream state mismatch cannot reach token exchange; a newly correlated query can", async () => {
    const events: EnrollmentEvent[] = [];
    let state = "";
    let prompts = 0;
    let exchanges = 0;
    const control = new EnrollmentControl(event => {
      events.push(event);
      if (event.type === "auth") state = new URL(event.url).searchParams.get("state")!;
      if (event.type === "prompt") {
        prompts++;
        if (prompts === 2) expect(exchanges).toBe(0);
        queueMicrotask(() => control.receive({ type: "response", promptId: event.promptId, value: `code=fixture-code&state=${prompts === 1 ? "wrong-state" : state}` }));
      }
    });
    control.receive({ type: "start", provider: "anthropic" });
    await enroll(control, async () => ({ entries: [{ id: 1, provider: "anthropic", identityKey: null }] }), async (input, init) => { exchanges++; return tokenFetch(input, init); });
    expect(prompts).toBe(2);
    expect(exchanges).toBe(1);
    expect(events.at(-1)?.type).toBe("complete");
  });

  test("code#state remains a supported upstream callback form", async () => {
    const events: EnrollmentEvent[] = [];
    await enroll(manualEnrollment(events, "code-state"), async () => ({ entries: [{ id: 1, provider: "anthropic", identityKey: null }] }), tokenFetch);
    expect(events.at(-1)?.type).toBe("complete");
  });

  test("bare codes cannot take the upstream permissive no-state path", async () => {
    const events: EnrollmentEvent[] = [];
    let exchanges = 0;
    let uploads = 0;
    const control = new EnrollmentControl(event => {
      events.push(event);
      if (event.type === "prompt") queueMicrotask(() => control.receive({
        type: "response", promptId: event.promptId, value: "private-bare-code",
      }));
    });
    control.receive({ type: "start", provider: "anthropic" });
    await enroll(control, async () => { uploads++; return {}; }, async () => {
      exchanges++;
      return Response.json(grant);
    });
    expect(exchanges).toBe(0);
    expect(uploads).toBe(0);
    expect(events.at(-1)).toEqual({ type: "refused", code: "invalid_callback" });
    expect(JSON.stringify(events)).not.toContain("private-bare-code");
  });

  test("cancellation during token exchange never uploads a late minted grant", async () => {
    const events: EnrollmentEvent[] = [];
    const control = manualEnrollment(events);
    const late = Promise.withResolvers<Response>();
    let uploads = 0;
    await enroll(control, async () => { uploads++; return {}; }, async () => {
      queueMicrotask(() => control.cancel("cancelled"));
      return late.promise;
    });
    late.resolve(Response.json(grant));
    // Check after the late response's promise continuations have drained, not
    // after a guessed wall-clock delay.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(uploads).toBe(0);
    expect(events.at(-1)).toEqual({ type: "refused", code: "cancelled" });
    expect(JSON.stringify(events)).not.toContain(grant.access_token);
  });

  test("token endpoint diagnostics are never forwarded to native job output", async () => {
    const events: EnrollmentEvent[] = [];
    let uploads = 0;
    await enroll(manualEnrollment(events), async () => { uploads++; return {}; }, async () => new Response(JSON.stringify({ error: `Authorization: Bearer ${grant.access_token}`, refresh_token: grant.refresh_token }), { status: 400 }));
    expect(uploads).toBe(0);
    expect(events.at(-1)).toEqual({ type: "refused", code: "enrollment_failed" });
    expect(JSON.stringify(events)).not.toContain(grant.access_token);
    expect(JSON.stringify(events)).not.toContain(grant.refresh_token);
  });

  test("API-key/custom secret flows refuse before requesting browser input", () => {
    expect(() => enrollmentFlow(authPolicyFor("openai"))).toThrow(EnrollmentRefusal);
    expect(() => enrollmentFlow(authPolicyFor("perplexity"))).toThrow(EnrollmentRefusal);
    expect(enrollmentFlow(authPolicyFor("openai-codex-device")).kind).toBe("codex-device");
  });

  test("safe auth output rejects secret URL parameters and extracts only device challenge", () => {
    const oauth = enrollmentFlow(authPolicyFor("anthropic"));
    expect(() => authEvent({ url: `https://claude.ai/oauth/authorize?state=nonce&access_token=${grant.access_token}` }, oauth)).toThrow(EnrollmentRefusal);
    const event = authEvent({ url: "https://auth.openai.com/codex/device", instructions: "Enter code: ABCD-1234" }, { kind: "codex-device" });
    expect(event).toMatchObject({ type: "auth", challenge: "ABCD-1234" });
    expect(() => authEvent({ url: "https://auth.openai.com/codex/device", instructions: `Enter code: ${grant.access_token}` }, { kind: "codex-device" })).toThrow(EnrollmentRefusal);
  });

  test("upload rejects unknown credential extensions rather than silently dropping refresh requirements", () => {
    const value = { type: "oauth" as const, access: grant.access_token, refresh: grant.refresh_token, expires: 1000, authorizedAt: 1, privateExtension: "provider-required" };
    expect(() => uploadFields("anthropic", value)).toThrow(EnrollmentRefusal);
    const fields = uploadFields("anthropic", { type: "oauth", access: grant.access_token, refresh: "", expires: 1000, authorizedAt: 1 });
    expect(fields.refresh).toBe(""); // Upstream OAuth wire accepts an empty refresh, but never its remote sentinel.
    expect(fields).not.toHaveProperty("email");
  });
});
