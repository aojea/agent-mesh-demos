// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SAM_ROOT = process.env.SAM_REPO_ROOT || path.resolve(ROOT, "../../../../../src/sam");
const PLAYWRIGHT_ENTRY = pathToFileURL(
  path.join(SAM_ROOT, "tests", "ui", "node_modules", "playwright", "index.mjs"),
).href;
const { chromium } = await import(PLAYWRIGHT_ENTRY);

const DEMO_PORT = 4415;
const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}`;
const OUT_DIR = process.env.VIDEOS_OUT_DIR || path.join(ROOT, "videos");
fs.mkdirSync(OUT_DIR, { recursive: true });

async function waitForDemoServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/api/demo1/state`);
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Demo server at ${url} did not start in time`);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function recordScenario(browser, name, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sam-rec-${name}-`));
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: tmpDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  await fn(page);
  const video = page.video();
  await context.close();
  const webmPath = await video.path();
  const mp4Path = path.join(OUT_DIR, `${name}.mp4`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      webmPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
      mp4Path,
    ],
    { stdio: "ignore" },
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`Recorded ${mp4Path}`);
}

const serverProc = spawn("node", [path.join(ROOT, "server.mjs")], {
  env: {
    ...process.env,
    PORT: String(DEMO_PORT),
    SAM_ONE_BIN: path.join(SAM_ROOT, "bin", "sam-one"),
    SAM_SDK_DIST: path.join(SAM_ROOT, "sdk", "js", "dist", "index.js"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForDemoServer(DEMO_URL);
  const browser = await chromium.launch({ headless: true });

  // 1. Zero-Trust Two-Agent Playground
  await recordScenario(browser, "demo-two-agent-playground", async (page) => {
    await page.goto(DEMO_URL);
    await pause(1000);

    // Alpha sends A2A task to Beta -> 200 OK
    await page.click("#d1-send-alpha");
    await pause(1200);

    // Beta replies to Alpha -> 200 OK
    await page.fill("#d1-input", "SBOM and Ed25519 attestation verified");
    await pause(500);
    await page.click("#d1-send-beta");
    await pause(1200);

    // Operator restricts Datalog policy (denies a2a://*)
    await page.click("#d1-btn-deny");
    await pause(1000);

    // Alpha tries again -> 403 Forbidden by Biscuit Datalog
    await page.fill("#d1-input", "Request production deployment approval");
    await pause(400);
    await page.click("#d1-send-alpha");
    await pause(1400);

    // Operator restores Datalog policy -> 200 OK
    await page.click("#d1-btn-allow");
    await pause(900);
    await page.click("#d1-send-alpha");
    await pause(1200);

    // Operator revokes Beta via GossipSub PEER_BAN -> Connection terminated
    await page.click("#d1-btn-ban");
    await pause(900);
    await page.fill("#d1-input", "Attempt call to revoked peer");
    await page.click("#d1-send-alpha");
    await pause(1600);
  });

  // 2. Polyglot "Follow the Packet" Hop Tracer
  await recordScenario(browser, "demo-polyglot-hop-tracer", async (page) => {
    await page.goto(DEMO_URL);
    await page.click("#tab-demo2");
    await pause(1000);

    await page.click("#d2-run-trace");
    await pause(1500);

    await page.fill("#d2-commit", "commit 4b19e80: enforce Biscuit Datalog policy at stream gate");
    await pause(600);
    await page.click("#d2-run-trace");
    await pause(1800);
  });

  // 3. "Scan-to-Join" Multi-Agent Collaboration Room
  await recordScenario(browser, "demo-qr-multi-agent-room", async (page) => {
    await page.goto(DEMO_URL);
    await page.click("#tab-demo3");
    await pause(1000);

    await page.click("#d3-join-1");
    await pause(900);
    await page.click("#d3-join-2");
    await pause(900);
    await page.click("#d3-join-3");
    await pause(900);
    await page.click("#d3-join-4");
    await pause(1000);

    // 5th rogue agent tries to use the exhausted room token -> rejected!
    await page.click("#d3-join-rogue");
    await pause(1300);

    // Commander broadcasts incident directive to all admitted room members over A2A
    await page.click("#d3-broadcast-btn");
    await pause(1800);
  });

  // 4. Federated Specialist Swarm
  await recordScenario(browser, "demo-federated-inference-swarm", async (page) => {
    await page.goto(DEMO_URL);
    await page.click("#tab-demo4");
    await pause(1000);

    await page.click("#d4-fanout-btn");
    await pause(1500);

    await page.fill("#d4-proposal", "RFC-043: Cross-region GossipSub ban propagation under 50ms");
    await pause(600);
    await page.click("#d4-fanout-btn");
    await pause(1800);
  });

  await browser.close();
} finally {
  if (serverProc && serverProc.exitCode === null) {
    serverProc.kill("SIGTERM");
  }
}
