import test from "node:test";
import assert from "node:assert/strict";
import { askBeat, JevFileCache, CONCURRENCY } from "../src/decide/jev.ts";
import { buildRequest } from "../src/decide/request.ts";
import type { Question } from "@byokit/decide";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Beat } from "../src/types.ts";

const KEY = "test-key-000";

const QUESTIONS: Record<string, Question> = {
  focus: { kind: "choice", options: { a: "Zone A", b: "Zone B" } },
};
const STATE = { current_shot: "Framing the entire screen." };

function okResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function jevOk(inputTokens = 812): Response {
  return okResponse(JSON.stringify({
    answers: { focus: { choice: "a", probabilities: { a: 1, b: 0 }, confidence: 1 } },
    usage: { input_tokens: inputTokens },
  }));
}

function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "takeone-jev-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("usage is recorded and the key goes only in the header", async () => {
  await withTmp(async (dir) => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body) };
      return jevOk();
    }) as typeof fetch;
    const r = await askBeat(STATE, QUESTIONS, KEY, new JevFileCache(join(dir, "c.jsonl")), { fetchImpl: fake });
    assert.equal(r.decisionSource, "api");
    assert.equal(r.inputTokens, 812);
    assert.ok(r.response && typeof r.response === "object");
    assert.equal(seen!.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(seen!.headers["authorization"], `Bearer ${KEY}`);
  });
});

test("cache hit on repeat costs zero network calls and records zero tokens", async () => {
  await withTmp(async (dir) => {
    const cachePath = join(dir, "c.jsonl");
    let calls = 0;
    const fake = (async () => {
      calls++;
      return jevOk(100);
    }) as typeof fetch;
    const r1 = await askBeat(STATE, QUESTIONS, KEY, new JevFileCache(cachePath), { fetchImpl: fake });
    assert.equal(r1.decisionSource, "api");
    assert.equal(r1.inputTokens, 100);
    assert.equal(calls, 1);
    // a fresh cache instance reading the same file hits without calling
    const r2 = await askBeat(STATE, QUESTIONS, KEY, new JevFileCache(cachePath), { fetchImpl: fake });
    assert.equal(r2.decisionSource, "cache");
    assert.equal(r2.inputTokens, undefined);
    assert.deepEqual(r2.response, r1.response);
    assert.equal(calls, 1);
  });
});

test("a 429 then success is retried", async () => {
  await withTmp(async (dir) => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      return jevOk(7);
    }) as typeof fetch;
    const r = await askBeat(STATE, QUESTIONS, KEY, new JevFileCache(join(dir, "c.jsonl")), { fetchImpl: fake });
    assert.equal(r.decisionSource, "api");
    assert.equal(r.inputTokens, 7);
    assert.equal(calls, 2);
  });
});

test("repeated 429s allow only one retry per beat and do not populate the cache", async () => {
  await withTmp(async (dir) => {
    let calls = 0;
    const cache = new JevFileCache(join(dir, "c.jsonl"));
    const fake = (async () => {
      calls++;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }) as typeof fetch;
    const r = await askBeat(STATE, QUESTIONS, KEY, cache, { fetchImpl: fake });
    assert.equal(r.decisionSource, "failed");
    assert.equal(r.inputTokens, undefined);
    assert.equal(calls, 2);
    const next = await askBeat(STATE, QUESTIONS, null, cache);
    assert.equal(next.decisionSource, "failed");
  });
});

test("5xx and malformed JSON fail", async () => {
  await withTmp(async (dir) => {
    const r1 = await askBeat(STATE, QUESTIONS, KEY, new JevFileCache(join(dir, "c1.jsonl")), {
      fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch,
    });
    assert.equal(r1.decisionSource, "failed");
    const r2 = await askBeat(STATE, QUESTIONS, KEY, new JevFileCache(join(dir, "c2.jsonl")), {
      fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch,
    });
    assert.equal(r2.decisionSource, "failed");
  });
});

test("malformed usage tokens cannot enter accounting", async () => {
  await withTmp(async (dir) => {
    for (const input_tokens of ["100", -1, 1.5]) {
      const r = await askBeat(STATE, QUESTIONS, KEY, new JevFileCache(join(dir, `c-${String(input_tokens)}.jsonl`)), {
        fetchImpl: (async () => okResponse(JSON.stringify({ answers: { focus: {} }, usage: { input_tokens } }))) as typeof fetch,
      });
      assert.equal(r.decisionSource, "failed");
    }
  });
});

test("the backend sends byte-identical bodies to buildRequest", async () => {
  await withTmp(async (dir) => {
    const beat: Beat = {
      id: "b1", t0: 0, t1: 1000, anchor_t: 0, window_cls: "", kind: "click",
      actions: [{ k: "click", t: 100, x: 10, y: 10, window_cls: "" }],
      zones: [
        { name: "a", kind: "all", bbox: [0, 0, 100, 100], area_frac: 1, desc: { shows: "the screen", size: "large, the screen", where: "center", activity: "idle" } },
        { name: "b", kind: "res", bbox: [10, 10, 20, 20], area_frac: 0.04, desc: { shows: "a dialog", size: "small, a dialog", where: "center", activity: "appeared" } },
      ],
    };
    const request = buildRequest(beat, { currentShot: "Framing the entire screen." }, false);
    let sent = "";
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = String(init?.body);
      const questions = JSON.parse(sent).questions as Record<string, { type: string; criteria: unknown }>;
      const answers: Record<string, unknown> = {};
      for (const [k, q] of Object.entries(questions)) {
        if (q.type === "choice") {
          const names = Object.keys(q.criteria as Record<string, unknown>);
          answers[k] = { choice: names[0], probabilities: Object.fromEntries(names.map((n, i) => [n, i === 0 ? 1 : 0])), confidence: 1 };
        } else if (q.type === "score") {
          const n = (q.criteria as unknown[]).length;
          answers[k] = { probabilities: Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0)), confidence: 1 };
        } else {
          answers[k] = { noul: 0.1 };
        }
      }
      return okResponse(JSON.stringify({ answers, usage: { input_tokens: 812 } }));
    }) as typeof fetch;
    const r = await askBeat(request.state, request.questions, KEY, new JevFileCache(join(dir, "c.jsonl")), { fetchImpl: fake });
    assert.equal(r.decisionSource, "api");
    assert.equal(sent, request.body);
  });
});

test("capture cache stores hash plus response only, never request bodies", async () => {
  await withTmp(async (dir) => {
    const marker = "marker-never-store-me-8f3a1";
    const cachePath = join(dir, "c.jsonl");
    const r = await askBeat({ ...STATE, secret: marker }, QUESTIONS, KEY, new JevFileCache(cachePath, { omitRequestBody: true }), {
      fetchImpl: (async () => jevOk()) as typeof fetch,
    });
    assert.equal(r.decisionSource, "api");
    const raw = readFileSync(cachePath, "utf8");
    assert.ok(!raw.includes(marker), "request body leaked into the cache file");
    assert.ok(!raw.includes("\"request\""), "request field stored in the cache file");
  });
});

test("no key means failed without calling", async () => {
  await withTmp(async (dir) => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return okResponse("{}");
    }) as typeof fetch;
    const r = await askBeat(STATE, QUESTIONS, null, new JevFileCache(join(dir, "c.jsonl")), { fetchImpl: fake });
    assert.equal(r.decisionSource, "failed");
    assert.equal(calls, 0);
  });
});

test("a hanging backend fails on the timeout", async () => {
  await withTmp(async (dir) => {
    const fake = (() => new Promise<Response>(() => {})) as typeof fetch;
    const r = await askBeat(STATE, QUESTIONS, KEY, new JevFileCache(join(dir, "c.jsonl")), { fetchImpl: fake, timeoutMs: 50 });
    assert.equal(r.decisionSource, "failed");
  });
});

test("concurrency constant is 8", () => {
  assert.equal(CONCURRENCY, 8);
});
