import { rename } from "node:fs/promises";
import { resolve } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import { runFfmpeg } from "./ffmpeg.ts";

/** Click ticks of 40 ms are cheap, but a graph needs one branch per click; past this the rest stay silent. */
const MAX_TICKS = 400;

/**
 * Mux the film's sound into a finished silent MP4 by stream copy: narration
 * (normalised to -16 LUFS) from the first frame, an optional music bed that
 * ducks whenever the narration speaks, and a synthesised tick under each click
 * ring. Does nothing, and leaves the film silent, when none are asked for.
 */
export async function addSound(dir: string, output: string, d: CameraDefaults, clickTimes: number[], duration: number): Promise<void> {
  const ticks = d.click_sound > 0 ? clickTimes.filter(t => t >= 0 && t < duration).slice(0, MAX_TICKS) : [];
  if (!d.narration && !d.music && !ticks.length) return;
  const inputs: string[] = [];
  const graph: string[] = [];
  const mix: string[] = [];
  let count = 0;
  const input = (...args: string[]) => { inputs.push(...args); return count++; };
  const video = input("-i", output);
  const file = (path: string) => resolve(dir, path);
  let voice = -1;
  if (d.narration) {
    voice = input("-i", file(d.narration));
    graph.push(d.music
      ? `[${voice}:a]loudnorm=I=-16:TP=-1.5:LRA=11,asplit=2[voice][quiet]`
      : `[${voice}:a]loudnorm=I=-16:TP=-1.5:LRA=11[voice]`);
    mix.push("[voice]");
  }
  if (d.music) {
    const bed = input("-stream_loop", "-1", "-i", file(d.music));
    if (voice < 0) graph.push(`[${bed}:a]volume=${d.music_volume}[bed]`);
    else {
      // sidechaincompress outputs silence while its key is digitally silent, so the key carries a noise floor.
      const floor = input("-f", "lavfi", "-i", "anoisesrc=amplitude=0.0003:sample_rate=48000");
      graph.push(`[quiet][${floor}:a]amix=inputs=2:normalize=0:duration=longest[key]`,
        `[${bed}:a]volume=${d.music_volume}[loud]`, "[loud][key]sidechaincompress=threshold=0.005:ratio=10:attack=20:release=400[bed]");
    }
    mix.push("[bed]");
  }
  if (ticks.length) {
    const tick = input("-f", "lavfi", "-i", `sine=frequency=1800:duration=0.04,afade=t=out:st=0.005:d=0.035,volume=${d.click_sound * 0.5},aformat=channel_layouts=stereo:sample_rates=48000`);
    graph.push(`[${tick}:a]asplit=${ticks.length}${ticks.map((_, i) => `[c${i}]`).join("")}`);
    ticks.forEach((t, i) => graph.push(`[c${i}]adelay=${Math.round(t * 1000)}:all=1[t${i}]`));
    mix.push(...ticks.map((_, i) => `[t${i}]`));
  }
  graph.push(`${mix.join("")}amix=inputs=${mix.length}:normalize=0:duration=longest,apad,alimiter=limit=0.95[sound]`);
  const withSound = output.replace(/\.mp4$/, ".sound.mp4");
  await runFfmpeg(["-y", "-v", "error", ...inputs, "-filter_complex", graph.join(";"),
    "-map", `${video}:v`, "-map", "[sound]", "-shortest", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", withSound]);
  await rename(withSound, output);
}
