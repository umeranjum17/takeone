# Drive the Tidewater board in a browser through the staged scene

Part of the takeone verification map. Source: `scripts/e2e/scene.html`.

## How to get to it (user POV)

Open scripts/e2e/scene.html directly as a file:// page; it is the staged Tidewater board used by the e2e takes.

## Driving it

Harness: Shell (bash), with ffmpeg and ffprobe to decode frames; a browser tool is needed only for the scene.html feature.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Click + New task (#newTask), type a title into #title, pick a priority from #prio and choose High in #menu, then click Create task (#create); the new card appears in #lane0.
3. Capture: screenshot the resulting page to $DONE_DONE_EVIDENCE_ROOT/drive-the-tidewater-board-in-a-browser-t.png, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
