#!/usr/bin/env node
// Renders the /promo timeline frame-by-frame in headless Chrome and encodes
// it with ffmpeg. Requires the dev server (npm run dev) and ffmpeg.
//
//   node scripts/render-promo.mjs                      # full video → renders/cubs-promo.mp4
//   node scripts/render-promo.mjs --stills=0.5,4,12    # JPEG stills for checking shots
//   --samples=N   motion-blur subframes per frame (default 8; 1 = off)

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);
const webPort = Number(args.port ?? 3000);
const debugPort = 9444;
const outDir = path.resolve(args.outDir ?? "renders");
const samples = Number(args.samples ?? 8);
const outFile = path.join(outDir, args.out ?? "cubs-promo.mp4");
const chromePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });

const profileDir = mkdtempSync(path.join(tmpdir(), "promo-chrome-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1920,1080",
    "--force-device-scale-factor=1",
    "--use-angle=metal",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const cleanup = () => {
  chrome.kill();
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
};
process.on("exit", cleanup);

for (let i = 0; ; i++) {
  try {
    await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    break;
  } catch {
    if (i > 100) throw new Error("Chrome did not start");
    await sleep(100);
  }
}
const target = await (
  await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};

await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://localhost:${webPort}/promo?capture` });
for (let i = 0; ; i++) {
  if (await evaluate(`document.documentElement.dataset.promoReady === "true" && !!window.__promo`)) break;
  if (i > 600) throw new Error("Promo page never became ready");
  await sleep(100);
}
// Let textures upload and shaders compile before the first captured frame.
await evaluate(`(async () => { for (let i = 0; i < 20; i++) window.__promo.renderAt(0); })()`);

const { fps, duration } = await evaluate(`({ fps: window.__promo.fps, duration: window.__promo.duration })`);
const frameAt = async (t) => {
  const dataURL = await evaluate(`window.__promo.renderAt(${t}, ${samples})`);
  return Buffer.from(dataURL.slice(dataURL.indexOf(",") + 1), "base64");
};

if (args.stills) {
  for (const t of args.stills.split(",").map(Number)) {
    const file = path.join(outDir, `still-${t.toFixed(2)}.jpg`);
    writeFileSync(file, await frameAt(t));
    console.log(file);
  }
  process.exit(0);
}

const totalFrames = Math.round(duration * fps);
const ffmpeg = spawn(
  "ffmpeg",
  [
    "-y",
    "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-vf", "fade=t=in:st=0:d=0.4:color=white",
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outFile,
  ],
  { stdio: ["pipe", "ignore", "inherit"] },
);
const started = Date.now();
for (let frame = 0; frame < totalFrames; frame++) {
  const jpeg = await frameAt(frame / fps);
  if (!ffmpeg.stdin.write(jpeg)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
  if (frame % 60 === 0) {
    const elapsed = (Date.now() - started) / 1000;
    console.log(`frame ${frame}/${totalFrames}  ${elapsed.toFixed(0)}s`);
  }
}
ffmpeg.stdin.end();
await new Promise((resolve) => ffmpeg.on("close", resolve));
console.log(outFile);
process.exit(0);
