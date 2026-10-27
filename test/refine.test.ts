import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const [log, error] = [console.log, console.error];
  let out = "", err = "";
  console.log = (...a) => { out += a.join(" ") + "\n"; };
  console.error = (...a) => { err += a.join(" ") + "\n"; };
  try { return { code: await main(args), out, err }; } finally { console.log = log; console.error = error; }
}

test("zoom edits a take's zooms and a saved look expands into render options", async () => {
  const root = mkdtempSync(join(tmpdir(), "takeone-refine-"));
  const config = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(root, "config");
  try {
    const take = join(root, "take");
    mkdirSync(take);
    writeFileSync(join(take, "take.json"), JSON.stringify({ width: 1920, height: 1080 }));
    const zooms = () => (JSON.parse(readFileSync(join(take, "take.json"), "utf8")) as { zooms?: unknown[] }).zooms;

    assert.equal((await run(["zoom", take, "add", "5", "9", "100,100,800,450", "--level", "3"])).code, 0);
    assert.equal((await run(["zoom", take, "add", "1", "3", "0,0,640,360"])).code, 0);
    assert.deepEqual(zooms(), [{ t0: 1, t1: 3, bbox: [0, 0, 640, 360], level: 2 }, { t0: 5, t1: 9, bbox: [100, 100, 800, 450], level: 3 }]);
    assert.match((await run(["zoom", take, "list"])).out, /1 {2}1s-3s[\s\S]*2 {2}5s-9s/);

    assert.equal((await run(["zoom", take, "move", "2", "--from", "4", "--box", "200,200,960,540"])).code, 0);
    assert.deepEqual((zooms() as { t0: number; bbox: number[] }[])[1], { t0: 4, t1: 9, bbox: [200, 200, 960, 540], level: 3 });
    // The JSON trust boundary still rejects a box off the source, a short span and an overlap; the file stays as it was.
    for (const bad of [["add", "10", "12", "1800,0,400,400"], ["add", "10", "10.2", "0,0,100,100"], ["add", "2", "6", "0,0,100,100"]]) {
      const r = await run(["zoom", take, ...bad]);
      assert.equal(r.code, 1);
      assert.match(r.err, /invalid zooms/);
    }
    assert.equal(zooms()!.length, 2);
    assert.equal((await run(["zoom", take, "remove", "1"])).code, 0);
    assert.equal(zooms()!.length, 1);
    assert.equal((await run(["zoom", take, "remove", "1"])).code, 0);
    assert.equal(zooms(), undefined);

    assert.equal((await run(["look", "save", "launch", "--theme", "paper", "--aspect", "square", "--set", "accent=#123456"])).code, 0);
    assert.match((await run(["look", "list"])).out, /launch/);
    assert.equal((await run(["look", "save", "bad", "--theme", "nope"])).code, 1);
    assert.equal((await run(["look", "save", "bad", "--aspect", "tall"])).code, 1);
    assert.equal((await run(["render", take, "--look", "ghost"])).code, 1);
    assert.equal((await run(["look", "remove", "launch"])).code, 0);
    assert.match((await run(["look", "list"])).out, /no saved looks/);
  } finally {
    if (config === undefined) delete process.env["XDG_CONFIG_HOME"]; else process.env["XDG_CONFIG_HOME"] = config;
    rmSync(root, { recursive: true, force: true });
  }
});
