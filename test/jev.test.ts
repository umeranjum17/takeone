import test from "node:test";
import assert from "node:assert/strict";
import { callJev, askBeat, DecisionCache, loadApiKey, CONCURRENCY } from "../src/decide/jev.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "test-key-000";

function okResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

test("callJev: 200 with usage reports input tokens; key sent only as a header", async () => {
  let seen: { url: string; headers: Record<string, string> } | null = null;
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
    return okResponse(JSON.stringify({ answers: {}, usage: { input_tokens: 812 } }));
  }) as typeof fetch;
  const r = await callJev("{}", KEY, { fetchImpl: fake });
  assert.ok(r.ok);
  assert.equal(r.inputTokens, 812);
  assert.equal(seen!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen!.headers["authorization"], `Bearer ${KEY}`);
});

test("callJev: 429 retries once honouring retry-after, then gives up", async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
  }) as typeof fetch;
  const r = await callJev("{}", KEY, { fetchImpl: fake });
  assert.equal(r.status, 429);
  assert.equal(calls, 2);
});

test("long retry-after fails promptly without retry", async () => {
  let calls = 0;
  const r = await callJev("{}", KEY, { timeoutMs: 50, fetchImpl: (async () => {
    calls++;
    return new Response("rate limited", { status: 429, headers: { "retry-after": "3600" } });
  }) as typeof fetch });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
});

test("retry-after HTTP-date and absent header respect bounded delay", async () => {
  for (const header of [new Date(Date.now() + 3600000).toUTCString(), null]) {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response("rate limited", { status: 429, headers: header ? { "retry-after": header } : {} });
    }) as typeof fetch;
    const r = await callJev("{}", KEY, { fetchImpl: fake, timeoutMs: 50 });
    assert.equal(r.status, 429);
    assert.equal(calls, 1);
    assert.ok((r.retryAfterMs ?? 0) > 50);
  }
});

test("callJev: timeout fails the call", async () => {
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as typeof fetch;
  const r = await callJev("{}", KEY, { fetchImpl: fake, timeoutMs: 50 });
  assert.equal(r.ok, false);
});

test("callJev: 5xx and malformed JSON fail", async () => {
  const r1 = await callJev("{}", KEY, { fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch });
  assert.equal(r1.ok, false);
  const r2 = await callJev("{}", KEY, { fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch });
  assert.equal(r2.ok, false);
});

test("cache hit costs zero network calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-cache-"));
  try {
    const cachePath = join(dir, "decisions.jsonl");
    let calls = 0;
    const fake = (async () => {
      calls++;
      return okResponse(JSON.stringify({ answers: {}, usage: { input_tokens: 100 } }));
    }) as typeof fetch;
    const cache1 = new DecisionCache(cachePath);
    const r1 = await askBeat("{}", KEY, cache1, { fetchImpl: fake });
    assert.equal(r1.decisionSource, "api");
    assert.equal(calls, 1);
    // a fresh cache instance reading the same file hits without calling
    const cache2 = new DecisionCache(cachePath);
    const r2 = await askBeat("{}", KEY, cache2, { fetchImpl: fake });
    assert.equal(r2.decisionSource, "cache");
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache persistence failure does not discard successful response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-cache-fail-"));
  try {
    const cache = new DecisionCache(join(dir, "missing", "decisions.jsonl"));
    cache.put = () => { throw new Error("disk full"); };
    const r = await askBeat("{}", KEY, cache, { fetchImpl: (async () => okResponse(JSON.stringify({ answers: {}, usage: { input_tokens: 8 } }))) as typeof fetch });
    assert.equal(r.decisionSource, "api");
    assert.equal(r.inputTokens, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no key means failed without calling", async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return okResponse("{}");
  }) as typeof fetch;
  const r = await askBeat("{}", null, new DecisionCache(join(tmpdir(), "takeone-none.jsonl")), { fetchImpl: fake });
  assert.equal(r.decisionSource, "failed");
  assert.equal(calls, 0);
});

test("loadApiKey reads the env first, then the config file; never leaks into errors", async () => {
  assert.equal(loadApiKey({ TYPESAFE_API_KEY: "k1" }), "k1");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "takeone-env-"));
  try {
    mkdirSync(join(dir, "takeone"), { recursive: true });
    writeFileSync(join(dir, "takeone", "env"), "# comment\nTYPESAFE_API_KEY=k3\n");
    assert.equal(loadApiKey({}, dir), "k3");
    writeFileSync(join(dir, "takeone", "env"), "k4\n");
    assert.equal(loadApiKey({}, dir), "k4");
    assert.equal(loadApiKey({}, join(dir, "missing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrency constant is 8", () => {
  assert.equal(CONCURRENCY, 8);
});
