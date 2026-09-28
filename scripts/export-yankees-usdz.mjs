#!/usr/bin/env node

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDirectory, "..");
const defaultMobileRoot = "/Users/jeshuasharkey/dev/mobile-app";
const mobileRoot = process.env.POLYMARKET_IOS_ROOT || defaultMobileRoot;
const modelDirectory = path.join(
  mobileRoot,
  "ios/polymarket-ios/Sources/USViews/_Resources/Models",
);
const exportTargets = {
  yankees: {
    displayName: "Yankees",
    logoURL: "/logos/yankees.svg",
    fileName: "YankeesEnamelPin.usdz",
  },
  phillies: {
    displayName: "Phillies",
    logoURL: "/logos/phillies.svg",
    fileName: "PhilliesEnamelPin.usdz",
  },
};
const logoArgument = process.argv.find((argument) => argument.startsWith("--logo="));
const logoSlug = logoArgument?.slice("--logo=".length) || "yankees";
const exportTarget = exportTargets[logoSlug];
if (!exportTarget) {
  throw new Error(`Unsupported logo "${logoSlug}". Expected one of: ${Object.keys(exportTargets).join(", ")}`);
}
const outputPath = path.join(modelDirectory, exportTarget.fileName);
const environmentSource = path.join(webRoot, "public/hdri/cave_studio_chrome.jpg");
const environmentOutput = path.join(modelDirectory, "cave_studio_chrome.jpg");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const existingWebPort = 3000;
const fallbackWebPort = 3107;
const debugPort = 9300 + (process.pid % 500);
const receiverPort = 18000 + (process.pid % 1000);

const children = [];
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function launch(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  children.push(child);
  return child;
}

async function waitForURL(url, attempts = 120) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await pause(250);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function connectCDP(webSocketURL) {
  const socket = new WebSocket(webSocketURL);
  let sequence = 0;
  const pending = new Map();
  const events = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      if (message.method === "Runtime.exceptionThrown" || message.method === "Log.entryAdded") {
        events.push(message);
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result);
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  return {
    ready,
    call(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
    getEvents() {
      return events;
    },
  };
}

async function main() {
  if (!existsSync(chromePath)) throw new Error(`Google Chrome not found at ${chromePath}`);
  if (!existsSync(environmentSource)) throw new Error(`Environment image not found at ${environmentSource}`);

  let webPort = existingWebPort;
  let nextProcess;
  let nextLog = "";
  try {
    const response = await fetch(`http://127.0.0.1:${existingWebPort}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    webPort = fallbackWebPort;
    nextProcess = launch(
      process.execPath,
      ["node_modules/next/dist/bin/next", "dev", "-p", String(webPort)],
      { cwd: webRoot },
    );
    nextProcess.stdout.on("data", (chunk) => { nextLog += chunk.toString(); });
    nextProcess.stderr.on("data", (chunk) => { nextLog += chunk.toString(); });
    try {
      await waitForURL(`http://127.0.0.1:${webPort}`);
    } catch (error) {
      throw new Error(`Could not start Enamel Pin dev server: ${error}\n${nextLog}`);
    }
  }
  console.log(`Web app ready on port ${webPort}`);

  let resolveUSDZ;
  let rejectUSDZ;
  const receivedUSDZ = new Promise((resolve, reject) => {
    resolveUSDZ = resolve;
    rejectUSDZ = reject;
  });
  const receiver = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "content-type");
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const bytes = Buffer.concat(chunks);
      resolveUSDZ(bytes);
      response.writeHead(200);
      response.end("ok");
    });
    request.on("error", rejectUSDZ);
  });
  await new Promise((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(receiverPort, "127.0.0.1", resolve);
  });
  receiver.unref();

  const profilePath = `/tmp/enamel-pin-usdz-chrome-${process.pid}`;
  const chromeArguments = [
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profilePath}`,
    "--window-size=1280,900",
    "about:blank",
  ];
  // The exact R3F scene requires a real WebGL context. Chrome's macOS
  // headless SwiftShader path never commits Canvas.onCreated on some hosts,
  // so GUI/Metal is the deterministic default. CI can opt back into
  // headless with ENAMEL_PIN_EXPORT_HEADLESS=1.
  if (process.env.ENAMEL_PIN_EXPORT_HEADLESS === "1") {
    chromeArguments.unshift(
      "--headless=new",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
    );
  }
  const chrome = launch(chromePath, chromeArguments);
  let chromeLog = "";
  chrome.stderr.on("data", (chunk) => { chromeLog += chunk.toString(); });
  await waitForURL(`http://127.0.0.1:${debugPort}/json/version`);
  console.log("Headless Chrome ready");

  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {
    method: "PUT",
  });
  const target = await targetResponse.json();
  const cdp = connectCDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Log.enable");

  // ExtrudedSVG's rough normal is intentionally procedural. Seeding random
  // before application code executes makes the generated normal map and the
  // resulting USDZ byte-for-byte reproducible.
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      (() => {
        let state = 0x59414e4b;
        Math.random = () => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return state / 4294967296;
        };
        try {
          localStorage.clear();
          localStorage.setItem("enamel-pin-selected-logo", ${JSON.stringify(exportTarget.logoURL)});
          localStorage.setItem("enamel-pin-selected-preset", "Enamel Pin");
        } catch {}
      })();
    `,
  });
  await cdp.call("Page.navigate", {
    url: `http://127.0.0.1:${webPort}/?export-usdz=1&usdz-logo=${logoSlug}`,
  });
  // Page.navigate acknowledges before the new document has replaced
  // about:blank. Let that context settle so the long async export evaluation
  // cannot be invalidated by the initial navigation.
  await pause(4000);

  console.log("Waiting for Three.js export bridge");
  const bridgeDeadline = Date.now() + 60000;
  while (Date.now() < bridgeDeadline) {
    try {
      const probe = await cdp.call("Runtime.evaluate", {
        expression: "typeof window.__exportYankeesEnamelPinUSDZ",
        returnByValue: true,
      });
      if (probe.result.value === "function") break;
    } catch (error) {
      if (!String(error).includes("Inspected target navigated")) throw error;
    }
    await pause(500);
  }
  const finalProbe = await cdp.call("Runtime.evaluate", {
    expression: "typeof window.__exportYankeesEnamelPinUSDZ",
    returnByValue: true,
  });
  if (finalProbe.result.value !== "function") {
    const diagnostic = await cdp.call("Runtime.evaluate", {
      expression: `JSON.stringify({
        href: location.href,
        readyState: document.readyState,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        isMobile: window.matchMedia("(max-width: 767px)").matches,
        canvases: Array.from(document.querySelectorAll("canvas"), (canvas) => ({
          width: canvas.width,
          height: canvas.height,
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
        })),
        bodyText: document.body.innerText.slice(0, 1000),
        bodyHTML: document.body.innerHTML.slice(0, 1000),
        resources: performance.getEntriesByType("resource").slice(-20).map((entry) => entry.name),
      })`,
      returnByValue: true,
    });
    throw new Error(
      `USDZ bridge did not install; browser says ${finalProbe.result.value}; page ${diagnostic.result.value}; events ${JSON.stringify(cdp.getEvents()).slice(0, 8000)}`,
    );
  }
  console.log("Bridge ready; exporting geometry and materials");

  let evaluation;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      evaluation = await cdp.call("Runtime.evaluate", {
        expression: `
          (async () => {
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return window.__exportYankeesEnamelPinUSDZ("http://127.0.0.1:${receiverPort}/${exportTarget.fileName}");
          })()
        `,
        awaitPromise: true,
        returnByValue: true,
      });
      break;
    } catch (error) {
      if (!String(error).includes("Inspected target navigated") || attempt === 5) throw error;
      await pause(3000);
    }
  }
  if (!evaluation) throw new Error("Browser evaluation did not complete");
  if (evaluation.exceptionDetails) {
    const detail = evaluation.exceptionDetails.exception?.description
      ?? evaluation.exceptionDetails.text;
    throw new Error(`Browser export failed: ${detail}\n${chromeLog}\n${nextLog}`);
  }

  if (evaluation.result.value !== "uploaded") {
    throw new Error(`Browser did not confirm USDZ upload\n${chromeLog}\n${nextLog}`);
  }
  const bytes = await receivedUSDZ;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("USDZ output is not a ZIP archive");
  }

  mkdirSync(modelDirectory, { recursive: true });
  writeFileSync(outputPath, bytes);
  copyFileSync(environmentSource, environmentOutput);
  receiver.close();
  cdp.close();
  chrome.kill("SIGTERM");
  nextProcess?.kill("SIGTERM");

  console.log(`USDZ: ${outputPath}`);
  console.log(`Environment: ${environmentOutput}`);
  console.log(`Bytes: ${bytes.length}`);
  console.log(`Preset: Enamel Pin (custom), ${exportTarget.displayName}, environment rotation 311 degrees`);
}

if (process.argv.includes("--copy-environment-only")) {
  mkdirSync(modelDirectory, { recursive: true });
  copyFileSync(environmentSource, environmentOutput);
  console.log(`Environment: ${environmentOutput}`);
} else {
  try {
    await main();
  } finally {
    for (const child of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
  }
}
