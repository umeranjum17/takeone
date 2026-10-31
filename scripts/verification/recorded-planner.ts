// A recorded planner for in-process runs (tests, quality fixtures, proof scripts): the Jev wire's fetch,
// answering every planner request from the request itself with one fixed decision, so no live provider is
// called. For a beat: the shot its own hint suggests (start and end zone, tightness), a new subject (so the
// camera moves), a useful step, a camera move that follows, and idle only where nothing happened. For the
// film: pace 1, the lively camera, the last beat that is not idle as the ending, no title or emphasis.
// scripts/verification/recorded-engine.mjs is the same decision for the shipped CLI's signed-in engine.
// Pass it as `fetchImpl` with `apiKey: RECORDED_KEY` and `film: false` to keep a render's film as the base look.

export const RECORDED_KEY = "recorded-planner-key";

const TIGHTNESS = ["entire screen", "window or area", "zone with room", "zone tightly"];

type Question = { type: "choice" | "score" | "noul"; criteria?: Record<string, unknown> | unknown[] };
type Hint = { suggest_shot: { start: string; end: string; tightness: string } };
type Beat = { what_happened?: string; hint?: Hint };

const choice = (options: string[], pick: string) => ({
  choice: pick, confidence: 1, probabilities: Object.fromEntries(options.map((o) => [o, o === pick ? 1 : 0])),
});
const score = (levels: number, at: number) => ({ confidence: 1, probabilities: Array.from({ length: levels }, (_, i) => (i === at ? 1 : 0)) });

export function recordedPlanner(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const { state, questions } = JSON.parse(String(init?.body)) as { state: { beats?: Record<string, Beat>; timeline?: string[] }; questions: Record<string, Question> };
    const idleLine = (id: string) => (state.timeline ?? []).some((line) => line.startsWith(`${id},`) && /idle/.test(line));
    const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => {
      const [, id = "", field = name] = /^(b\d+)_(.+)$/.exec(name) ?? [];
      const beat = state.beats?.[id];
      const hint = beat?.hint?.suggest_shot;
      if (q.type === "choice") {
        const options = Object.keys(q.criteria ?? {});
        const live = [...options].reverse().find((o) => !idleLine(o)) ?? options.at(-1)!;
        const wanted = name === "ending" ? live : field === "focus_start" ? hint?.start : field === "focus_end" ? hint?.end : name === "camera_style" ? "lively" : undefined;
        return [name, choice(options, options.includes(wanted ?? "") ? wanted! : options[0]!)];
      }
      if (q.type === "score") {
        const levels = (q.criteria as unknown[] | undefined)?.length ?? 4;
        const at = field === "tightness" ? Math.max(0, TIGHTNESS.indexOf(hint?.tightness ?? "")) : name === "pace" ? 1 : field === "key_moment" ? 1 : 0;
        return [name, score(levels, Math.min(at, levels - 1))];
      }
      const yes = field === "idle" ? /screen was idle/.test(beat?.what_happened ?? "") : field !== "titled" && field !== "marked" && name !== "titled" && name !== "marked";
      return [name, { noul: yes ? 1 : 0 }];
    }));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 800 } }), { status: 200 });
  }) as typeof fetch;
}
