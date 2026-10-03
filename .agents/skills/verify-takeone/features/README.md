# takeone feature map

User-facing features of the takeone CLI, in README order. Each file tells you what the feature is, how a user reaches it, how to drive it with the takeone CLI from a shell, and what observable end state proves it works. Proofs drive these journeys; a proof that only exercises a convenient entry point is incomplete when the map lists others.

| # | Feature | Offline? | File |
|---|---|---|---|
| 1 | Render a demo without recording anything (synth take + `make --no-jev`) | yes | [offline-demo-render.md](offline-demo-render.md) |
| 2 | Plan and render a recorded take (`make`) | planning offline with `--no-jev`; Jev calls cost tokens | [plan-and-render-take.md](plan-and-render-take.md) |
| 3 | Tweak the look and rerender (`render --theme`/`--set`) | yes — never calls the planner | [rerender-look-tweaks.md](rerender-look-tweaks.md) |
| 4 | Record a take (`record`/`stop`/list; desktop, `--android`, `--ios-sim`) | no — needs capture hardware | [record-a-take.md](record-a-take.md) |
| 5 | Motion films from screens (`motion`) | yes after one shell install | [motion-films.md](motion-films.md) |

Supporting surface, not mapped separately: `takeone doctor` (read-only environment report), `takeone key set` (BYOKit secret store), and the `takeone capture` verbs (`hello`/`record`/`stop`/`make`) implementing the BYOKit recorder protocol — drive those only when the change touches them.
