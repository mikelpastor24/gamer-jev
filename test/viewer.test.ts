import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { startViewer } from "../src/server/viewer.js";

test("the local viewer exposes frames, controls, screenshots, and compatible checkpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-test-"));
  const checkpointPath = join(directory, "checkpoint.json");
  const emulator = new GameBoyEmulator(createDemoRom());
  const viewer = await startViewer(emulator, { port: 0, speed: 1, paused: true, checkpointPath });
  const post = (path: string, body: unknown = {}) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: viewer.url }, body: JSON.stringify(body),
  });
  try {
    const page = await fetch(viewer.url);
    assert.match(await page.text(), /lang="en"/);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal((await fetch(`${viewer.url}/viewer.js`)).status, 200);
    assert.equal((await fetch(`${viewer.url}/style.css`)).status, 200);
    const before = await fetch(`${viewer.url}/api/frame`);
    assert.equal((await before.arrayBuffer()).byteLength, 160 * 144 * 4);
    assert.equal((await post("/api/input", { buttons: ["BAD"] })).status, 400);
    assert.equal(emulator.frameNumber, 0);
    assert.equal((await post("/api/step")).status, 200);
    assert.equal(emulator.frameNumber, 1);
    assert.equal((await post("/api/save")).status, 200);
    assert.equal(JSON.parse(await readFile(checkpointPath, "utf8")).frame, 1);
    await post("/api/step");
    assert.equal(emulator.frameNumber, 2);
    assert.equal((await post("/api/load")).status, 200);
    assert.equal(emulator.frameNumber, 1);
    const screenshot = await fetch(`${viewer.url}/api/screenshot`);
    const png = PNG.sync.read(Buffer.from(await screenshot.arrayBuffer()));
    assert.equal(png.width, 160);
    assert.equal(png.height, 144);
    assert.equal((await post("/api/reset")).status, 200);
    assert.equal(emulator.frameNumber, 0);
    const foreign = await fetch(`${viewer.url}/api/reset`, { method: "POST", headers: {
      "Content-Type": "application/json", Origin: "https://example.com",
    }, body: "{}" });
    assert.equal(foreign.status, 403);
    const form = await fetch(`${viewer.url}/api/reset`, { method: "POST", body: "{}" });
    assert.equal(form.status, 403);
    assert.equal((await fetch(`${viewer.url}/missing`)).status, 404);
  } finally {
    await viewer.close();
    emulator.dispose();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
