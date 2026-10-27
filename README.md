<h1 align="center">
  <img src="docs/assets/readme/icon-288.png" width="44" alt="" valign="middle" /> takeone
</h1>

<p align="center">
  <strong>Record once. Direct the camera afterwards.</strong><br/>
  Turn a raw screen recording into a framed, paced demo video, on your own machine.<br/>
  <a href="https://github.com/umeranjum17/takeone/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/umeranjum17/takeone/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=nodedotjs&logoColor=white" />
  <img alt="Renders locally with ffmpeg" src="https://img.shields.io/badge/renders-locally%20with%20ffmpeg-0b7a5f" />
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/hero-dark.webp" />
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/hero-light.webp" />
    <img src="docs/assets/readme/hero-light.jpg" width="960" alt="The takeone render of the Tidewater demo board on a warm themed stage, at double speed. It opens pushed in on the New task dialog while the title and notes are typed and Priority is set to High, pulls back as the task is created, the card is dragged to In progress, then the wide board returns with its title, From idea to launch, and the camera pushes in on the dialog again" />
  </picture>
</p>

<p align="center"><sub>One take, rendered by takeone: the camera holds the dialog you type into, then pulls back for the result. <code>sand</code> theme in light mode, <code>aurora</code> in dark mode.</sub></p>

## Why takeone

A good demo needs camera work: show every click, hold the dialog you type into, pull back when the result lands.
Doing that while you demo means performing and directing at the same time.

takeone splits the two jobs. You record the way you normally use your app.
takeone plans the shots afterwards from what actually happened on screen, then renders the video locally.

## How it works

1. **Record** the whole screen, plus your clicks and key presses. Key presses are logged by type only, never as letters.

   <img src="docs/assets/readme/step-record.webp" width="640" alt="The raw recording: the Tidewater board with the new Draft launch announcement card at the top of To do" />

2. **Plan** the camera: takeone splits the take into moments and finds what you acted on (the green box).

   <img src="docs/assets/readme/step-plan.webp" width="640" alt="A raw frame, dimmed, with a green box around the New task dialog and its open Priority dropdown" />

3. **Render** a framed, paced MP4 on a themed stage, with click rings, a crisp cursor and captions.

   <picture>
     <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/step-render-dark.webp" />
     <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/step-render-light.webp" />
     <img src="docs/assets/readme/step-render-light.webp" width="640" alt="A 1:1 detail of the rendered frame: a click ring on the Priority field of the New task dialog" />
   </picture>

Verification and evidence: [done-done journeys and feature recipes](docs/verification/README.md).

## Quick start

### Install

On Linux or macOS, with [Node.js](https://nodejs.org/) 22.19 or newer and [ffmpeg](https://ffmpeg.org/) on your PATH:

```sh
npm install -g takeone-axi
takeone doctor
```

If you prefer the GitHub release tarball:

```sh
npm install -g --allow-remote=all https://github.com/umeranjum17/takeone/releases/latest/download/takeone.tgz
```

npm 12 refuses the tarball URL without `--allow-remote=all`. npm 11 may print `npm warn Unknown cli config "--allow-remote"` for the same flag; that warning is harmless and the install still succeeds.

`takeone doctor` is the first check: it reports what this machine can record and render, and whether the AI planner found an account or key (the `ai-planner` row).

### From source

On Linux, you need [Node.js](https://nodejs.org/) 22.19 or newer, [ffmpeg](https://ffmpeg.org/) on your PATH, and the Liberation Sans or DejaVu Sans font (most distributions ship one).

```sh
git clone https://github.com/umeranjum17/takeone
cd takeone && npm install
node scripts/synth-take.ts tmp/demo
node bin/takeone.mjs make \
  "$PWD/tmp/demo" --no-ai
```

Your video is at `tmp/demo/out/synth-demo.mp4`. The demo recording is generated, so you need no screen recorder or API key, and planning runs offline.
To record your own screen, a phone or the iOS Simulator, follow the [guide](docs/guide.md#quickstart).

Isolated installs (CI, throwaway test HOMEs) can set `TAKEONE_NO_KEYRING=1` so takeone never reads the OS keyring and cannot see the host's stored key even when `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS` are inherited; keys then come only from a `TAKEONE_SECRETS_PASSPHRASE_FD` sealed file.

## Features

- **Records your real workflow.** The Linux desktop (Wayland and Hyprland), the macOS desktop (preview), an Android phone or emulator, or the iOS Simulator on a Mac.
- **Plans the camera after you record.** From your clicks, typing and what changed on screen.
- **Keeps the action readable.** Click rings, a drawn vector cursor and keycaps for shortcuts like `Ctrl+S`.
- **Looks finished out of the box.** A rounded screen card on a stage, in six themes from dark `midnight` to cream `paper`.
- **Titles and captions.** In every shape, phone takes too, they sit in a band below the screen, never over your app ([how](docs/look.md)).
- **Paces itself.** Idle stretches play faster, typing can too, and spotlight and blur boxes follow the content.
- **AI planning.** A normal `takeone make` needs a signed-in AI engine: it [discovers an existing account](docs/guide.md#discovery-order) or uses a configured key, and stops before analysis if none is available. Sign in with `claude` or `codex login`; no token needs to be pasted into TakeOne. The legacy explicit `--no-ai` mode is still present pending removal. Planner cost is in [docs/cost.md](docs/cost.md).
- **Exports what you need.** MP4 by default, plus GIF, WebM and ProRes 4444, in landscape, portrait, square or 4:5.
- **Scores its own film.** `takeone make --target-score 9` renders, judges against a written rubric, fixes the weakest items and renders again, with the per-round score in `out/score.json`.
- **Motion films from screens.** `takeone motion` turns screenshots, HTML or a URL into a short film.

## Learn more

- [Vision](VISION.md): who takeone is for, where it is going and what it is not
- [Guide](docs/guide.md): install, the full quickstart, planning and rendering
- [Recording](docs/recording.md): desktop, phone and Simulator capture, commands and take files
- [Look and pacing](docs/look.md): themes, stage, zoom, captions and every look setting
- [Edit controls](docs/edit-controls.md): output size and format, hold-style camera, speed regions
- [Overlays](docs/overlays.md): spotlight and blur regions, shortcut keycaps
- [Motion films](docs/motion.md): films from screenshots, HTML or a URL
- [Score loop](docs/score-loop.md): render, judge, improve and the call cap
- [Cost](docs/cost.md): measured planner cost per minute and its hard caps
- [Demo scene](docs/headless-scene.md): reproduce the board demo shown above (needs a [git checkout](#from-source): its scripts are not in the npm package)

## Development

```sh
npm install
npm test
```

Questions and bugs go to [GitHub issues](https://github.com/umeranjum17/takeone/issues).
