# Add click ticks, narration and ducked music

Part of the takeone verification map. Source: `src/render/sound.ts`, `src/camera/defaults.ts`, `src/render/render.ts`.

## How to get to it (user POV)

A render is silent by default. `--set click_sound=0..1` adds a short tick under every click ring; `--set narration=FILE` lays a voice-over from the first frame, loudness-normalised to -16 LUFS; `--set music=FILE [--set music_volume=0..1]` adds a looping bed that ducks whenever the narration speaks. The MP4 gets one AAC stream the length of the video; the picture is stream-copied. Mic capture and transcription are not shipped: narration is a file you supply.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` and `render-slot.sh` for every render. Use the synthetic take from [Render a synthetic take](render-a-synthetic-take-to-a-framed-demo.md) after its recorded-response test make or a signed-in engine make.

1. Make a narration with silent gaps (ffmpeg `sine` gated with `volume='if(lt(mod(t,8),4),0.5,0)':eval=frame`) and a steady music file.
2. `node bin/takeone.mjs render <take> --set click_sound=1 --set narration=<n.wav> --set music=<m.wav> --set music_volume=0.5`.
3. `ffprobe` shows one `aac` audio stream and a duration within a frame of the video. Per-second RMS (`astats`) shows the music level while the narration is silent and a lower music share while it speaks; click ticks show as 1.8 kHz bursts at the take's click times.
4. Capture the MP4 to $DONE_DONE_EVIDENCE_ROOT/takeone-film-sound-after.mp4 and the RMS list to takeone-film-sound-after.txt.

The drive changes no repo file: note findings in the run's report.
