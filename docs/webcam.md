# Webcam bubble

A take can carry a face-cam clip. The film shows it as a bubble in one corner of the output, over the footage and under captions and keycaps, and the bubble shrinks as the camera zooms in so it stays out of the way of the detail being shown.

## Record

```sh
takeone record --webcam                          # first /dev/video*
takeone record --webcam --webcam-device /dev/video2
```

Linux, V4L2. `ffmpeg` reads the camera (720p when it offers it, its own size otherwise) beside the screen capture and writes `webcam.mkv` (H.264) into the take. `take.json` gets `webcam: { file, start_ms, device }`, where `start_ms` is the clip's first frame on the event clock (within about 0.1 s); `render` uses it to line the face up with the screen. A camera that does not exist is refused before the screen-share prompt. A camera that opens but gives no frames (busy, for example) is reported on stderr and in `take.json` `warnings`, and the screen take is kept without it. The camera's audio is not recorded.

Any clip also works: copy a video into the take directory and render with `--set webcam=face.mp4`. It is laid from the first frame of the screen video.

## Look

All of these are `--set` keys, so they re-render without calling the planner:

| key | values | default | |
|---|---|---|---|
| `webcam` | `""`, `off`, a file | `""` | `""` uses the take's own clip; `off` leaves it out; a file (relative to the take) replaces it |
| `webcam_shape` | `circle`, `rounded` | `circle` | the circle crops the camera square; `rounded` keeps a 4:3 rounded rectangle |
| `webcam_corner` | `br` `bl` `tr` `tl` | `br` | bottom/top, right/left |
| `webcam_size` | 0.08 to 0.5 | 0.24 | edge as a share of the output's short side, at rest |
| `webcam_shrink` | 0.25 to 1 | 0.5 | scale at deep zoom; `1` keeps the size fixed |

The bubble is full size while the camera shows the whole stage and eases (smoothstep) to `webcam_shrink` as the zoom goes from 1x to 2.5x, following the camera path frame by frame, so a push-in and the shrink arrive together. It carries a thin white ring and a soft edge. The clip follows the same clock as the footage: idle stretches that the film speeds up, and cuts and speed regions, apply to the face as well. When the clip is shorter than the film, the bubble leaves when it ends.

Renders, previews and `--aspect`, `--resolution` and `--format` exports all draw it.

## Limits

Mic and system audio, background removal, hiding the bubble during silence and mirroring are not part of this. Phone and iOS Simulator recordings have no `--webcam`. The bubble does not move out of the way of a caption that reaches its corner; pick another `webcam_corner` if one does.
