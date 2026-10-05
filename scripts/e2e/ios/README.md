# iOS camera proof fixture

This is a task-owned Tidewater app with fictional Umer launch-board data. It runs
only in a disposable iOS Simulator. Its deep links update task details in three
parts of the board; TakeOne records video without receiving those navigation
commands as input events.

Build inside the isolated Mac lab with `bash scripts/e2e/ios/build.sh <lab-dir>`.
Create and boot a new Simulator, install `<lab-dir>/Tidewater.app` with its exact
UDID, and launch `design.takeone.lab.pm14` on that UDID. Record using:

```sh
TAKEONE_STATE_DIR=<lab-dir>/state TMPDIR=<lab-dir>/scratch \
  takeone record --ios-sim --ios-udid <task-UDID> \
  --root <lab-dir>/takes --state-dir <lab-dir>/state
```

Start the recorder first, then launch this app with `--demo` using
`xcrun simctl launch --terminate-running-process <task-UDID> design.takeone.lab.pm14 --demo`.
The app navigates task details after its view loads, at 1.5, 4.5, 7.5, 10.5,
13.5 and 16.5 seconds. Keep a 20-second session after launch. This app-owned
mode avoids iOS's external URL confirmation dialog. It emits no touch events.
Stop with `TAKEONE_STATE_DIR=<lab-dir>/state takeone stop`. Make the resulting
video-only take through the ordinary shared planner and renderer. Keep the
source recording, planning usage, camera path, rendered MP4 and twelve sampled
frames for output review.

Never operate another Simulator or use personal app data. Shutdown and delete
only the exact Simulator created for this proof. This fixture adds no capture
backend and requires no installed or upgraded tools.
