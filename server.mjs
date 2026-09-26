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

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localSamBin = path.join(__dirname, ".sam-bin", "sam-one");
const SAM_ONE_BIN =
  process.env.SAM_ONE_BIN || (fs.existsSync(localSamBin) ? localSamBin : "sam-one");
const PORT = Number(process.env.PORT || 4400);
const ADMIN_TOKEN = process.env.SAM_ADMIN_TOKEN || "demo-admin-secret-token";

const sdk = process.env.SAM_SDK_DIST
  ? await import(pathToFileURL(path.resolve(process.env.SAM_SDK_DIST)).href)
  : await import("@sam-mesh/sdk");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForReady(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/readyz`);
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`sam-one did not become ready at ${url}`);
}

const samOnePort = await getFreePort();
const samOneDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sam-one-demos-"));
const samOneUrl = `http://127.0.0.1:${samOnePort}`;

const samOneProc = spawn(
  SAM_ONE_BIN,
  [
    "--bind-address",
    "127.0.0.1",
    "--port",
    String(samOnePort),
    "--p2p-listen",
    "/ip4/127.0.0.1/tcp/0",
    "--data-dir",
    samOneDataDir,
  ],
  {
    env: { ...process.env, SAM_ADMIN_TOKEN: ADMIN_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
await waitForReady(samOneUrl);

const joinToken = fs.readFileSync(path.join(samOneDataDir, "join-token"), "utf8").trim();
let routerAddr = `/ip4/127.0.0.1/tcp/${samOnePort}/ws`;
for (let i = 0; i < 30; i++) {
  const statusRes = await fetch(`${samOneUrl}/admin/status`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (statusRes.ok) {
    const statusJson = await statusRes.json();
    if (statusJson.active_routers?.length > 0) {
      routerAddr = statusJson.active_routers[0].Addresses?.[0] || routerAddr;
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 150));
}

async function enrollAndJoin(token = joinToken) {
  const mesh = await sdk.AgentMesh.enroll({
    controlPlaneUrl: samOneUrl,
    bootstrapToken: token,
  });
  const session = await mesh.join();
  return { mesh, session };
}

async function setMeshPolicy(mode) {
  const allowedServices = mode === "allow" ? ["*"] : ["mcp://*"];
  const policyBody = {
    roles: [
      { name: "sam-admin", allowed_services: ["*"], allowed_targets: ["*"] },
      { name: "sam:role:router", allowed_services: ["*"], allowed_targets: ["*"] },
      {
        name: "sam:role:node",
        allowed_services: allowedServices,
        allowed_targets: ["*"],
        allowed_labels: ["*"],
      },
    ],
    bindings: [],
  };
  const res = await fetch(`${samOneUrl}/policies`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(policyBody),
  });
  if (!res.ok) {
    throw new Error(`POST /policies failed: ${res.status}`);
  }
}

async function mintRoomToken(maxUsages = 4) {
  const res = await fetch(`${samOneUrl}/admin/bootstrap-tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      role: "sam:role:node",
      max_usages: maxUsages,
      ttl_hours: 1,
      description: "Incident Response Room QR Token",
    }),
  });
  const data = await res.json();
  return data.token;
}

// Track active sessions so we never exceed go-libp2p's per-IP relay slot cap (8) on 127.0.0.1.
let activeDemo = null;
let activeSessions = [];

async function closeActiveSessions() {
  const toClose = activeSessions;
  activeSessions = [];
  for (const s of toClose) {
    try {
      await s.close();
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// DEMO 1: Zero-Trust Two-Agent Playground (Alpha <-> Beta over sam-one /ws)
// ============================================================================
const demo1 = {
  alpha: null,
  beta: null,
  policyMode: "allow",
  betaBanned: false,
  messages: [],
};

async function ensureDemo1() {
  if (activeDemo === "demo1" && demo1.alpha && demo1.beta) return;
  await closeActiveSessions();
  await setMeshPolicy("allow");
  demo1.policyMode = "allow";
  demo1.betaBanned = false;
  demo1.alpha = await enrollAndJoin();
  demo1.beta = await enrollAndJoin();
  activeSessions.push(demo1.alpha.session, demo1.beta.session);

  await demo1.alpha.session.serve({
    type: "a2a",
    name: "planner",
    target: async (req, caller) => {
      const body = await req.json();
      return Response.json({
        agent: "Agent Alpha (Planner)",
        responderPeerId: demo1.alpha.session.peerId,
        verifiedCallerPeerId: caller.peerId,
        verifiedCallerRoles: caller.roles,
        reply: `Plan updated with audit feedback: "${body.text}"`,
      });
    },
  });

  await demo1.beta.session.serve({
    type: "a2a",
    name: "auditor",
    target: async (req, caller) => {
      const body = await req.json();
      return Response.json({
        agent: "Agent Beta (Security Auditor)",
        responderPeerId: demo1.beta.session.peerId,
        verifiedCallerPeerId: caller.peerId,
        verifiedCallerRoles: caller.roles,
        reply: `Zero-trust audit passed for: "${body.text}" (Biscuit signature verified, no raw token forwarded)`,
      });
    },
  });
  activeDemo = "demo1";
}

// ============================================================================
// DEMO 2: Polyglot "Follow the Packet" Hop Tracer
// ============================================================================
const demo2 = {
  coordinator: null,
  researcher: null,
  gitAnalyzer: null,
  traces: [],
};

async function ensureDemo2() {
  if (activeDemo === "demo2" && demo2.coordinator) return;
  await closeActiveSessions();
  await setMeshPolicy("allow");
  demo2.coordinator = await enrollAndJoin();
  demo2.researcher = await enrollAndJoin();
  demo2.gitAnalyzer = await enrollAndJoin();
  activeSessions.push(
    demo2.coordinator.session,
    demo2.researcher.session,
    demo2.gitAnalyzer.session,
  );

  await demo2.gitAnalyzer.session.serve({
    type: "a2a",
    name: "git-analyzer",
    target: async (req, caller) => {
      const body = await req.json();
      return Response.json({
        tool: "summarize_diff",
        providerPeerId: demo2.gitAnalyzer.session.peerId,
        verifiedCallerPeerId: caller.peerId,
        summary: `Analyzed ${body.commit || "HEAD~1..HEAD"}: TLS 1.3 WebSocket transport added in sdk/js/src/host.ts (+194/-0 lines), 0 vulnerabilities detected.`,
      });
    },
  });

  await demo2.researcher.session.serve({
    type: "a2a",
    name: "researcher",
    target: async (req, caller) => {
      const body = await req.json();
      const hop2Start = performance.now();
      await demo2.researcher.session.connect(demo2.gitAnalyzer.session.peerId);
      const toolRes = await demo2.researcher.session.request(
        demo2.gitAnalyzer.session.peerId,
        "a2a://git-analyzer",
        "/invoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commit: body.commit || "main@9f4c21a" }),
        },
      );
      const hop2Ms = Math.max(1, Math.round(performance.now() - hop2Start));
      const toolData = JSON.parse(toolRes.text());
      return Response.json({
        researcherPeerId: demo2.researcher.session.peerId,
        verifiedCoordinatorPeerId: caller.peerId,
        hop2Ms,
        downstream: toolData,
        synthesis: `Verified diff via ${toolData.providerPeerId.slice(0, 16)}...: ${toolData.summary}`,
      });
    },
  });
  activeDemo = "demo2";
}

// ============================================================================
// DEMO 3: "Scan-to-Join" Multi-Agent Collaboration Room
// ============================================================================
const roomToken = await mintRoomToken(4);
const demo3 = {
  roomToken,
  enrollUri: `sam://enroll?server=${encodeURIComponent(samOneUrl)}&token=${encodeURIComponent(roomToken)}`,
  maxUsages: 4,
  usedCount: 0,
  members: [],
  rejections: [],
  roomMessages: [],
};

async function ensureDemo3() {
  if (activeDemo === "demo3") return;
  await closeActiveSessions();
  await setMeshPolicy("allow");
  activeDemo = "demo3";
}

// ============================================================================
// DEMO 4: Federated Specialist Swarm
// ============================================================================
const demo4 = {
  orchestrator: null,
  specialists: [],
  runs: [],
};

async function ensureDemo4() {
  if (activeDemo === "demo4" && demo4.orchestrator) return;
  await closeActiveSessions();
  await setMeshPolicy("allow");
  demo4.orchestrator = await enrollAndJoin();
  demo4.specialists = [
    {
      id: "sec",
      name: "Security Specialist",
      service: "sec-review",
      domain: "Zero-Trust & Cryptography",
      ...(await enrollAndJoin()),
    },
    {
      id: "perf",
      name: "Performance Profiler",
      service: "perf-review",
      domain: "Stream Multiplexing & Latency",
      ...(await enrollAndJoin()),
    },
    {
      id: "comp",
      name: "Compliance Verifier",
      service: "comp-review",
      domain: "Datalog Policy & Audit Trail",
      ...(await enrollAndJoin()),
    },
  ];
  activeSessions.push(
    demo4.orchestrator.session,
    ...demo4.specialists.map((s) => s.session),
  );

  for (const spec of demo4.specialists) {
    await spec.session.serve({
      type: "a2a",
      name: spec.service,
      target: async (req, caller) => {
        const body = await req.json();
        const findingsBySpec = {
          sec: `Ed25519 PoP verified; Mutual TLS 1.3 + Biscuit attestation confirmed for "${body.proposal}". Verdict: PASS.`,
          perf: `Single-port WebSocket + Yamux multiplexing keeps P99 relay overhead < 4ms for "${body.proposal}". Verdict: PASS.`,
          comp: `Datalog policy predicates carry >=1 term; X-SAM-Biscuit stripped prior to workload handler. Verdict: PASS.`,
        };
        return Response.json({
          specialist: spec.name,
          domain: spec.domain,
          peerId: spec.session.peerId,
          verifiedOrchestratorPeerId: caller.peerId,
          finding: findingsBySpec[spec.id],
        });
      },
    });
  }
  activeDemo = "demo4";
}

// Start with Demo 1 active
await ensureDemo1();

// ============================================================================
// HTTP Server & JSON API
// ============================================================================
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // ---- DEMO 1 ENDPOINTS ----
    if (req.method === "GET" && url.pathname === "/api/demo1/state") {
      await ensureDemo1();
      sendJson(res, 200, {
        samOneUrl,
        routerAddr,
        alphaPeerId: demo1.alpha.session.peerId,
        betaPeerId: demo1.beta.session.peerId,
        alphaRelay: demo1.alpha.session.relayAddresses[0]?.toString() || "",
        betaRelay: demo1.beta.session.relayAddresses[0]?.toString() || "",
        policyMode: demo1.policyMode,
        datalogRules: demo1.beta.session.policyRules,
        betaBanned: demo1.betaBanned,
        messages: demo1.messages,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo1/send") {
      await ensureDemo1();
      const { from = "alpha", text = "Audit release v0.2.0 artifact signatures" } = await readJson(req);
      const sender = from === "alpha" ? demo1.alpha.session : demo1.beta.session;
      const receiver = from === "alpha" ? demo1.beta.session : demo1.alpha.session;
      const targetService = from === "alpha" ? "a2a://auditor" : "a2a://planner";
      const t0 = performance.now();
      try {
        await sender.connect(receiver.peerId);
        const r = await sender.request(receiver.peerId, targetService, "/task", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const latencyMs = Math.max(1, Math.round(performance.now() - t0));
        let parsed = {};
        try {
          parsed = JSON.parse(r.text());
        } catch {
          parsed = { raw: r.text() };
        }
        const entry = {
          id: demo1.messages.length + 1,
          from,
          fromPeerId: sender.peerId,
          toPeerId: receiver.peerId,
          targetService,
          text,
          status: r.status,
          latencyMs,
          response: parsed,
        };
        demo1.messages.push(entry);
        sendJson(res, 200, entry);
      } catch (err) {
        const latencyMs = Math.max(1, Math.round(performance.now() - t0));
        const entry = {
          id: demo1.messages.length + 1,
          from,
          fromPeerId: sender.peerId,
          toPeerId: receiver.peerId,
          targetService,
          text,
          status: 0,
          latencyMs,
          error: err.message,
        };
        demo1.messages.push(entry);
        sendJson(res, 200, entry);
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo1/policy") {
      await ensureDemo1();
      const { mode } = await readJson(req);
      demo1.policyMode = mode === "deny" ? "deny" : "allow";
      await setMeshPolicy(demo1.policyMode);
      await demo1.alpha.session.refresh();
      await demo1.beta.session.refresh();
      await demo1.alpha.session.syncPolicy();
      await demo1.beta.session.syncPolicy();
      sendJson(res, 200, {
        policyMode: demo1.policyMode,
        datalogRules: demo1.beta.session.policyRules,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo1/ban") {
      await ensureDemo1();
      const revokeRes = await fetch(
        `${samOneUrl}/user/revoke?id=${encodeURIComponent(demo1.beta.session.peerId)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        },
      );
      if (!revokeRes.ok) {
        throw new Error(`Revoke failed: ${revokeRes.status}`);
      }
      demo1.betaBanned = true;
      await demo1.alpha.session.sync();
      sendJson(res, 200, { betaBanned: true, bannedPeerId: demo1.beta.session.peerId });
      return;
    }

    // ---- DEMO 2 ENDPOINTS ----
    if (req.method === "GET" && url.pathname === "/api/demo2/state") {
      await ensureDemo2();
      sendJson(res, 200, {
        routerAddr,
        coordinatorPeerId: demo2.coordinator.session.peerId,
        researcherPeerId: demo2.researcher.session.peerId,
        gitAnalyzerPeerId: demo2.gitAnalyzer.session.peerId,
        traces: demo2.traces,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo2/trace") {
      await ensureDemo2();
      const { commit = "main@9f4c21a" } = await readJson(req);
      const t0 = performance.now();
      await demo2.coordinator.session.connect(demo2.researcher.session.peerId);
      const r = await demo2.coordinator.session.request(
        demo2.researcher.session.peerId,
        "a2a://researcher",
        "/analyze",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commit }),
        },
      );
      const totalMs = Math.max(2, Math.round(performance.now() - t0));
      const payload = JSON.parse(r.text());
      const trace = {
        id: demo2.traces.length + 1,
        commit,
        totalMs,
        hop1Ms: Math.max(1, totalMs - payload.hop2Ms),
        hop2Ms: payload.hop2Ms,
        coordinatorPeerId: demo2.coordinator.session.peerId,
        researcherPeerId: payload.researcherPeerId,
        gitAnalyzerPeerId: payload.downstream.providerPeerId,
        verifiedAtHop1: payload.verifiedCoordinatorPeerId,
        verifiedAtHop2: payload.downstream.verifiedCallerPeerId,
        synthesis: payload.synthesis,
      };
      demo2.traces.push(trace);
      sendJson(res, 200, trace);
      return;
    }

    // ---- DEMO 3 ENDPOINTS ----
    if (req.method === "GET" && url.pathname === "/api/demo3/state") {
      await ensureDemo3();
      sendJson(res, 200, {
        roomToken: demo3.roomToken,
        enrollUri: demo3.enrollUri,
        maxUsages: demo3.maxUsages,
        usedCount: demo3.usedCount,
        members: demo3.members.map((m) => ({
          name: m.name,
          roleLabel: m.roleLabel,
          peerId: m.session.peerId,
        })),
        rejections: demo3.rejections,
        roomMessages: demo3.roomMessages,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo3/join") {
      await ensureDemo3();
      const { name, roleLabel } = await readJson(req);
      try {
        const enrolled = await enrollAndJoin(demo3.roomToken);
        activeSessions.push(enrolled.session);
        const memberIndex = demo3.members.length;
        await enrolled.session.serve({
          type: "a2a",
          name: "room",
          target: async (reqMsg, caller) => {
            const body = await reqMsg.json();
            return Response.json({
              member: name,
              peerId: enrolled.session.peerId,
              verifiedSender: caller.peerId,
              ack: `${name} (${roleLabel}) confirmed action for: "${body.directive}"`,
            });
          },
        });
        demo3.members.push({ name, roleLabel, ...enrolled, index: memberIndex });
        demo3.usedCount += 1;
        sendJson(res, 200, {
          admitted: true,
          name,
          roleLabel,
          peerId: enrolled.session.peerId,
          usedCount: demo3.usedCount,
          maxUsages: demo3.maxUsages,
        });
      } catch (err) {
        const rejection = {
          name,
          roleLabel,
          reason: err.message,
        };
        demo3.rejections.push(rejection);
        sendJson(res, 200, {
          admitted: false,
          ...rejection,
          usedCount: demo3.usedCount,
          maxUsages: demo3.maxUsages,
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo3/broadcast") {
      await ensureDemo3();
      const { directive = "Isolate compromised egress key and rotate Biscuit root" } = await readJson(req);
      if (demo3.members.length < 2) {
        sendJson(res, 400, { error: "Need at least 2 members in the room" });
        return;
      }
      const commander = demo3.members[0];
      const replies = [];
      for (const target of demo3.members.slice(1)) {
        await commander.session.connect(target.session.peerId);
        const r = await commander.session.request(target.session.peerId, "a2a://room", "/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ directive }),
        });
        replies.push(JSON.parse(r.text()));
      }
      const broadcastEntry = {
        commander: commander.name,
        commanderPeerId: commander.session.peerId,
        directive,
        replies,
      };
      demo3.roomMessages.push(broadcastEntry);
      sendJson(res, 200, broadcastEntry);
      return;
    }

    // ---- DEMO 4 ENDPOINTS ----
    if (req.method === "GET" && url.pathname === "/api/demo4/state") {
      await ensureDemo4();
      sendJson(res, 200, {
        orchestratorPeerId: demo4.orchestrator.session.peerId,
        specialists: demo4.specialists.map((s) => ({
          id: s.id,
          name: s.name,
          service: `a2a://${s.service}`,
          domain: s.domain,
          peerId: s.session.peerId,
        })),
        runs: demo4.runs,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo4/fanout") {
      await ensureDemo4();
      const { proposal = "Enable cross-cluster WebSocket relay for browser SDK agents" } = await readJson(req);
      const t0 = performance.now();
      const results = await Promise.all(
        demo4.specialists.map(async (s) => {
          const s0 = performance.now();
          await demo4.orchestrator.session.connect(s.session.peerId);
          const r = await demo4.orchestrator.session.request(
            s.session.peerId,
            `a2a://${s.service}`,
            "/review",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ proposal }),
            },
          );
          const latencyMs = Math.max(1, Math.round(performance.now() - s0));
          return {
            ...JSON.parse(r.text()),
            service: `a2a://${s.service}`,
            latencyMs,
          };
        }),
      );
      const wallTimeMs = Math.max(2, Math.round(performance.now() - t0));
      const run = {
        id: demo4.runs.length + 1,
        proposal,
        orchestratorPeerId: demo4.orchestrator.session.peerId,
        wallTimeMs,
        results,
        verdict: `APPROVED (${results.length}/${results.length} verified mesh specialists passed in ${wallTimeMs}ms parallel wall-clock time)`,
      };
      demo4.runs.push(run);
      sendJson(res, 200, run);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`SAM Demos server listening on http://127.0.0.1:${PORT} (sam-one at ${samOneUrl})`);
});

async function shutdown() {
  await closeActiveSessions();
  server.close();
  if (samOneProc && samOneProc.exitCode === null) {
    samOneProc.kill("SIGTERM");
  }
  fs.rmSync(samOneDataDir, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
