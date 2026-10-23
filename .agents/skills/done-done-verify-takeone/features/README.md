# takeone features

The repo's maintained verification map; a proof that drives one entry point is incomplete when this lists others.

- [Render a synthetic take to a framed demo MP4 offline](render-a-synthetic-take-to-a-framed-demo.md): Run the README quick start from a git checkout: install dependencies, then generate the demo take
- [Render a fast preview of the same film](render-a-fast-preview-of-the-same-film.md): `takeone render <take> --preview` renders the same camera path at about 480p and 30 fps from a 1080p proxy
- [Check the rendered offline MP4 visually](check-the-rendered-offline-mp4-visually.md): After make writes the MP4, run the offline-render journey's visual check on the take
- [Drive the Tidewater board in a browser through the staged scene](drive-the-tidewater-board-in-a-browser-t.md): Open scripts/e2e/scene.html directly as a file:// page; it is the staged Tidewater board used by the e2e takes
- [Run the repo's static checks as a verification journey](run-the-repo-s-static-checks-as-a-verifi.md): From a checkout, run the checks journey
- [Print the installed version](print-the-installed-version.md): `takeone --version` and `-v` print the package.json version with no ffmpeg and no subcommand
- [Prove a plan edit follows its beat across a re-cut](prove-a-plan-edit-follows-its-beat-across-a-re-cut.md): Edit `analysis/plan.json` by hand, trim the take, run `make` again, and assert the edit lands on the same beat key at its new id (`src/beats/key.ts`, `src/decide/plan.ts`)
- [Prove the camera drag ease on a real take](prove-the-camera-drag-ease-on-a-real-take.md): Render a real take with a drag, then measure the camera bars and the per-frame text cuts (`src/camera/gesture.ts`)
- [Plan a capture with the user's account](plan-a-capture-with-the-users-account.md): `takeone capture make <take> --planner-account` plans through the signed-in account `takeone make` resolves, and stops with `planner-unavailable` instead of planning with local rules when there is none
