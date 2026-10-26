# Vision

## Who it is for

People who show an app in a demo video. You record yourself using the app, on a desktop or on a phone, and takeone turns that raw take into a polished demo.

## The problem

A good demo needs camera work: zoom in on what you act on, pan with it, hold the dialog you type into, pull back when the result lands.
Doing that live means performing and directing at the same time.
Asking a model about every frame of a recording instead is an absurd bill when done naively.

## Where it is going

Record once, on any screen, and get the same polished demo:

- **Camera work decided afterwards, frame by frame**, not performed live. Zoom, pan and hold are planned from what actually happened on screen.
- **Attention is decided by a model.** The planner analyses the recording and returns where attention belongs, as a zone or coordinates. Jev is the default planner, and you can use your own signed-in AI account or key instead.
- **Desktop or mobile, one shared core.** Desktop capture comes from the desklink package. Android phones and emulators and the iOS Simulator are capture sources too. Every source is an adapter behind one shared core: planner, attention, camera path, render.
- **On your own machine.** takeone records and renders locally. There is no takeone service to sign up for.

## Principles and quality bar

- **Best in class or it has failed.** Output must look and feel best in class. A demo tool whose own output is unpolished has failed at the only thing it does.
- **Bounded cost per minute of video.** Every design states its cost per minute of video and what keeps it bounded. Today's measured numbers and hard caps are in [docs/cost.md](docs/cost.md).
- **Your screen stays yours.** Key presses are recorded by type, never as letters. Planning can also run fully offline, with no AI at all.
- **Proof is the real render.** A change is proven on a real rendered video, not on a synthetic clip alone. The quality gates are in [docs/quality.md](docs/quality.md).
- **Main path first.** Ship the main path working and looking right, then polish.

## What it is not

- Not a screen-capture engine. Desktop capture is consumed from desklink, never written a second time.
- Not a hosted service. There is no takeone server, account or operated infrastructure.
- Not a live camera operator. You never direct the camera while you record.
- Not one codebase per platform. Desktop and mobile share one core.
- Not a part of another app. Other apps can call takeone as a package or CLI; takeone stays a standalone product.

## Next milestones

Releases and their notes are on the [releases page](https://github.com/umeranjum17/takeone/releases) and in [docs/release-notes](docs/release-notes/).

1. **v0.2.2:** a host app can plan a capture with the user's signed-in AI account instead of passing a key. It ships when its live proof passes.
2. **Later:** Mac takes get click rings, keycaps and click-driven camera once desklink captures Mac input.

A docs-only edit such as this line should not queue the render gates.
