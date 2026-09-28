#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const [, , outputArgument, portArgument = "3199"] = process.argv;
if (!outputArgument) {
  console.error("Usage: node scripts/receive-usdz.mjs /absolute/output.usdz [port]");
  process.exit(1);
}

const outputPath = path.resolve(outputArgument);
const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${portArgument}`);
  process.exit(1);
}

const server = http.createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end("POST the USDZ payload to this URL\n");
    return;
  }

  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try {
      const bytes = Buffer.concat(chunks);
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        throw new Error("Payload is not a USDZ ZIP archive");
      }
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, bytes);
      response.writeHead(200, { "Content-Type": "text/plain" }).end("saved\n");
      console.log(`Saved ${bytes.length} bytes to ${outputPath}`);
      server.close();
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/plain" }).end(`${error.message}\n`);
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Receiver URL: http://127.0.0.1:${port}/YankeesEnamelPin.usdz`);
  console.log(`Output: ${outputPath}`);
});
