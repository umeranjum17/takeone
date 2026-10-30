#!/usr/bin/env node
// A recorded stand-in for the installed `claude` CLI, for tests and journeys that drive the
// shipped takeone CLI without a live provider. It answers `auth status` as a signed-in Claude
// subscription and every planner ask from the request's own JSON schema, with the same fixed
// decision each time. For a beat: the shot its own hint suggests (start and end zone, tightness),
// always a new subject (so the camera moves), a useful step, a camera move that follows, and idle
// only where nothing happened. For the film: pace 1, the lively camera, the last beat of the
// request's timeline that is not idle as the ending, and no title or emphasis. Anything else takes
// its first option. It never opens a network connection and never reads a credential. Put it on
// PATH under the name `claude` (see recorded-engine.sh).
const args = process.argv.slice(2);
if (args.includes("auth") && args.includes("status")) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) + "\n");
  process.exit(0);
}

const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
let asked = "";
process.stdin.on("data", (chunk) => { asked += chunk; });
// The beats the request describes, in order, as `b2, 2.3 seconds: Nothing happened; the screen was idle.`
const state = () => {
  try {
    const content = JSON.parse(asked).message.content;
    return JSON.parse(content.at(-1).text).state;
  } catch {
    return {};
  }
};
const TIGHTNESS = ["entire screen", "window or area", "zone with room", "zone tightly"];
const BEAT_FIXED = { new_subject: "true", key_moment: "1", shot: "true", follow: "true" };
const fixed = { pace: "1", camera_style: "lively", titled: "false", marked: "false" };
process.stdin.on("end", () => {
  const { timeline: beats = [], beats: asked_beats = {} } = state();
  const answers = {};
  for (const [name, question] of Object.entries(schema.properties)) {
    const keys = Object.keys(question.properties.probabilities.properties);
    const live = keys.findLast((key) => !beats.some((line) => line.startsWith(`${key},`) && /idle/.test(line)));
    const [, beat, field] = /^(b\d+)_(.+)$/.exec(name) ?? [];
    const hint = asked_beats[beat]?.hint;
    const suggested = {
      focus_start: hint?.suggest_shot.start, focus_end: hint?.suggest_shot.end,
      tightness: String(TIGHTNESS.indexOf(hint?.suggest_shot.tightness)),
      idle: String(/screen was idle/.test(asked_beats[beat]?.what_happened ?? "")),
    }[field];
    const pick = name === "ending" ? live ?? keys.at(-1) : fixed[name] ?? BEAT_FIXED[field] ?? (keys.includes(suggested) ? suggested : keys[0]);
    answers[name] = {
      probabilities: Object.fromEntries(keys.map((key) => [key, key === pick ? 1 : 0])),
      pick,
      // Free-text fields (title, captions, emphasis lists) are only read on a yes.
      ...Object.fromEntries(question.required.filter((field) => field !== "probabilities" && field !== "pick").map((field) => [field, null])),
    };
  }
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, structured_output: answers, result: "",
    usage: { input_tokens: 800, output_tokens: 50 },
  }) + "\n");
});
