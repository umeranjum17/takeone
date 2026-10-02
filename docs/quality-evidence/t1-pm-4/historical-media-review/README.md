# Historical MP4 visual/content/provenance review

Reviewed during the assigned Review phase at starting HEAD
`f76010dfd35d5bda181a3e3eeb5656d1c6345395` on 2026-10-02.
This identifies the reviewer checkout, not the renderer of these videos.

Coverage: all seven MP4s named by the executor audit were opened as freshly
decoded overview, action-detail, and ending images and visually inspected.
Every MP4 also completed a full video decode with `ffmpeg -xerror` and exit 0.
Exact MP4 SHA-256, media metadata and derived-image filenames are in
[metadata.json](metadata.json); the parent `SHA256SUMS` binds all these files.
Original media, plans, receipts and their historical source bindings remain
unchanged. Receipt attribution below is reported as recorded; missing exact
source digests for earlier files have not been invented.

Method: 1 fps overview images from each actual MP4, scaled to 384×216 with
output-clock labels; 640×360 detail images from Acme 16–32 s at 1 fps and
Tidewater 15.5–19 s at 2 fps; a 960×540 frame extracted from the final 0.02 s.
Detail labels are interval start plus elapsed time. The Acme sheets contain
16–31 s samples; the final partial second is reviewed separately in the ending
image. Black unused sheet cells are padding, not black video frames.
All ffmpeg invocations were run separately and sequentially under the existing
`takeone-heavy.lock`, including their children. No new product render, build,
test, provider call or reference refresh was performed.

This is decoded-image content review, not continuous playback or a visual
inspection of every 60 fps frame. It covers each film's sampled storyline,
drag sequence and ending, but does not establish sub-frame motion quality,
every-frame thumb/card visibility, or new numerical quality scores. All seven
files are silent H.264, 1920×1080, 60 fps, with no audio streams.

## 01: acme-before.mp4

[MP4](../acme-before.mp4) · [Overview](01-overview.png) · [Action detail](01-detail.png) · [Ending](01-ending.png)

SHA-256: `0b2a32a9f8c10d81d1092d98012751284d0d0c3db1b162865f5dad59c26337fc`. Duration: 32.35 s; 1941 frames. Full decode: exit 0.

Historical baseline: main `9baea61a62b08fa464d6a578e6f3c0ac74ded592`; associated receipt [output-report.txt](../output-report.txt). Exact output-source digest not recorded there.

Overview: welcome, Reports, search typing, churn-detail dialog, retention adjustment, export-complete banner, and fade. Detail: the dialog enters with its left edge/title cropped at 18–19 s; the thumb/cursor are visible in the sampled 20–27 s slider movement. This is a historical before comparison, not a whole-interval visibility PASS.

## 02: acme-after.mp4

[MP4](../acme-after.mp4) · [Overview](02-overview.png) · [Action detail](02-detail.png) · [Ending](02-ending.png)

SHA-256: `0f6d74cf33a38e7cb987a8cf5ad2a33c7eb5e4d2ad9deb4f74910a8301124e1f`. Duration: 32.35 s; 1941 frames. Full decode: exit 0.

Historical after: receipt associates candidate `97328b4` and base main `9baea61a62b08fa464d6a578e6f3c0ac74ded592`; [output-report.txt](../output-report.txt). Exact output-source digest not recorded there.

Overview: the same Acme report/search/detail/retention/export story. Detail: wider framing from 16 s retains the dialog, thumb and cursor in sampled slider frames; export confirmation remains visible afterward. Ending image shows the fade over the retained dialog.

## 03: acme-candidate-after.mp4

[MP4](../acme-candidate-after.mp4) · [Overview](03-overview.png) · [Action detail](03-detail.png) · [Ending](03-ending.png)

SHA-256: `ae52bcb885520aee9ad6191250fa69ec6acffdf66a12fd18312bbf699c80f8fe`. Duration: 32.35 s; 1941 frames. Full decode: exit 0.

Renderer `8f8cf08903046cf9fb258dc4eb84dfb70b3fb27e`, tree `b4daccbb8e8a609ac7a6b733728de99eedf8c4d2`, source digest `090109f3eeaa7d54a7dd233b94343ca7536ccc8ceffc8919f6fc11cc3e7debe3`; [original receipt](../previous-8f8-receipts/candidate-output-report.txt).

Overview: full Acme stage during the opening, tighter report/search views, then a wider detail/slider view and export confirmation. Detail: sampled 18–27 s frames retain the full panel and show thumb/cursor progressing along the track. Ending image shows the fade. Fine cursor ink and inter-frame motion are not proven by downsampled sheets.

## 04: previous-87d-render/acme-candidate-after.mp4

[MP4](../previous-87d-render/acme-candidate-after.mp4) · [Overview](04-overview.png) · [Action detail](04-detail.png) · [Ending](04-ending.png)

SHA-256: `559f665cd6a95ade93499f26cccc26565219633bd9157a081e8a1f4095ac5efa`. Duration: 32.35 s; 1941 frames. Full decode: exit 0.

Renderer `87d47178573488510efcff493c583f01e7b3b29c`; baseline main `684fb6c4f6b1216c5b2aab1f5ebfc35a16569bf3`; [receipt](../previous-87d-render/candidate-output-report.txt).

Overview and detail were inspected separately for this file: Acme report/search, opening churn dialog, moving retention thumb/cursor in the wide panel, export confirmation, then fade. It resembles the later historical candidate visually, but has its own distinct MP4 hash and renderer binding.

## 05: previous-87d-render/tidewater-candidate-after.mp4

[MP4](../previous-87d-render/tidewater-candidate-after.mp4) · [Overview](05-overview.png) · [Action detail](05-detail.png) · [Ending](05-ending.png)

SHA-256: `8bc097b6e6e309228a9708ba8e7117c61834274c3a7c9dacee87f36bbc2e6fc9`. Duration: 39.933333 s; 2396 frames. Full decode: exit 0.

Renderer `87d47178573488510efcff493c583f01e7b3b29c`; baseline main `684fb6c4f6b1216c5b2aab1f5ebfc35a16569bf3`; [receipt](../previous-87d-render/candidate-output-report.txt).

Overview: Tidewater launch board with Umer activity, new task dialog, title/description entry, priority selection, task creation, drag/drop, and later board actions. Detail: the complete Draft launch announcement card and cursor remain visible in samples as it crosses from To do to In progress; 19 s shows the card at rest after the recorded drop. At 38–39 s the crop contains little board context and a narrow activity edge; the ending fades nearly to the background. No blanket whole-film quality PASS is issued.

## 06: tidewater-candidate-after.mp4

[MP4](../tidewater-candidate-after.mp4) · [Overview](06-overview.png) · [Action detail](06-detail.png) · [Ending](06-ending.png)

SHA-256: `5aa3d0808506cdcf5a8789a3f4b6c4495070d03c93ab7fb3995542795184be34`. Duration: 39.933333 s; 2396 frames. Full decode: exit 0.

Renderer `8f8cf08903046cf9fb258dc4eb84dfb70b3fb27e`, tree `b4daccbb8e8a609ac7a6b733728de99eedf8c4d2`, source digest `090109f3eeaa7d54a7dd233b94343ca7536ccc8ceffc8919f6fc11cc3e7debe3`; [original receipt](../previous-8f8-receipts/candidate-output-report.txt).

Overview and detail were inspected separately for this file: Tidewater task creation, priority selection, board drag and settled post-drop card. The sampled dragged-card footprint and cursor are retained during crossing, with the card at rest by 19 s. The 38–39 s closing crop again provides little board context before fading; this is retained as a historical limitation, not relabelled as current output.

## 07: tidewater-real-after.mp4

[MP4](../tidewater-real-after.mp4) · [Overview](07-overview.png) · [Action detail](07-detail.png) · [Ending](07-ending.png)

SHA-256: `060c3aca785349a2b29744d89aea5d50b7e44b6958827b8795a955b01254a436`. Duration: 39.933333 s; 2396 frames. Full decode: exit 0.

Historical after: receipt associates candidate `97328b4` and base main `9baea61a62b08fa464d6a578e6f3c0ac74ded592`; [output-report.txt](../output-report.txt). Exact output-source digest not recorded there.

Overview: earlier Tidewater render with tighter entry/dialog crops, task creation, full-board drag/drop, and subsequent board actions. Detail: the whole Draft launch announcement card is visible at 17–18 s and at rest at 19 s; cursor is visible in the moving-card samples. The 38–39 s crop loses most board context; the ending is nearly the background with a faint cursor. Original provenance limitations remain as recorded.

## Current-candidate status

Historical review coverage is complete at the sampled-image level described
above. These observations do not change any historical receipt or promote any
old MP4 to current-candidate evidence. The five accepted fresh public-CLI
output scenarios remain pending in the parent [validation handoff](../README.md).
The assigned Test phase must regenerate and inspect them after the source
fixes, including whole-card/cursor coverage through drop, Acme every-frame
16–30 s visibility, 16–32 s sheet, every-beat no regression, and actual trim
alignment and no-match CLI exit. No acceptance criterion or quality limit is
waived by this historical review.
