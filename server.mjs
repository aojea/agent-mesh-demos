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
const localSamNodeBin = path.join(__dirname, ".sam-bin", "sam-node");
const SAM_ONE_BIN =
  process.env.SAM_ONE_BIN || (fs.existsSync(localSamBin) ? localSamBin : "sam-one");
const SAM_NODE_BIN =
  process.env.SAM_NODE_BIN || (fs.existsSync(localSamNodeBin) ? localSamNodeBin : "sam-node");
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

async function enrollAndJoin(token = joinToken, role = undefined) {
  const opts = {
    controlPlaneUrl: samOneUrl,
    bootstrapToken: token,
  };
  if (role) opts.role = role;
  const mesh = await sdk.AgentMesh.enroll(opts);
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

async function mintBootstrapToken(role = "sam:role:node", maxUsages = 4, description = "Demo Bootstrap Token") {
  const res = await fetch(`${samOneUrl}/admin/bootstrap-tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      role,
      max_usages: maxUsages,
      ttl_hours: 1,
      description,
    }),
  });
  const data = await res.json();
  return data.token;
}

// Track active sessions so we never exceed go-libp2p's per-IP relay slot cap (8) on 127.0.0.1.
let activeDemo = null;
let activeSessions = [];
let activePepProc = null;

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
  if (activePepProc && activePepProc.exitCode === null) {
    activePepProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
  }
  activePepProc = null;
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

  await demo1.alpha.session.acceptA2A({
    name: "planner",
    handler: async (req, caller) => {
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

  await demo1.beta.session.acceptA2A({
    name: "auditor",
    handler: async (req, caller) => {
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

  await demo2.gitAnalyzer.session.acceptA2A({
    name: "git-analyzer",
    handler: async (req, caller) => {
      const body = await req.json();
      return Response.json({
        tool: "summarize_diff",
        providerPeerId: demo2.gitAnalyzer.session.peerId,
        verifiedCallerPeerId: caller.peerId,
        summary: `Analyzed ${body.commit || "HEAD~1..HEAD"}: TLS 1.3 WebSocket transport added in sdk/js/src/host.ts (+194/-0 lines), 0 vulnerabilities detected.`,
      });
    },
  });

  await demo2.researcher.session.acceptA2A({
    name: "researcher",
    handler: async (req, caller) => {
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
const roomToken = await mintBootstrapToken("sam:role:node", 4, "Incident Response Room QR Token");
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
    await spec.session.acceptA2A({
      name: spec.service,
      handler: async (req, caller) => {
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

// ============================================================================
// DEMO 5: Zero-Install Browser Playground
// ============================================================================
const browserToken = await mintBootstrapToken("sam:role:node", 10, "Browser Playground Token");
const demo5 = {
  samOneUrl,
  browserToken,
  enrollUri: `sam://enroll?server=${encodeURIComponent(samOneUrl)}&token=${encodeURIComponent(browserToken)}`,
};

async function ensureDemo5() {
  if (activeDemo === "demo5") return;
  await closeActiveSessions();
  await setMeshPolicy("allow");
  activeDemo = "demo5";
}

// ============================================================================
// DEMO 6: Egress PEP & Fine-Grained HTTP Method/Path Grants
// ============================================================================
const demo6 = {
  pepPeerId: null,
  pepTcpAddr: null,
  pepLabel: "site=eu",
  secretName: "github-eu",
  secretPreview: "ghp_eu_sovereign_vault_99a8b7c6",
  contractor: null,
  datalogRules: [],
  requests: [],
  upstreamLog: [],
};

const demo6UpstreamServer = http.createServer((req, res) => {
  const authHeader = req.headers.authorization || "none";
  const biscuitStripped = req.headers["x-sam-biscuit"] === undefined;
  const entry = {
    id: demo6.upstreamLog.length + 1,
    method: req.method,
    path: req.url,
    injectedAuth: authHeader,
    biscuitStripped,
    timestamp: new Date().toISOString(),
  };
  demo6.upstreamLog.push(entry);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      destination: "api.github.com (EU Sovereign Egress Origin)",
      method: req.method,
      path: req.url,
      injectedCredential: "github-eu (Bearer ghp_eu_sovereign_vault_****)",
      biscuitStripped,
      pulls: [
        {
          number: 479,
          repo: "acme/dubbing",
          title: "docs: egress destinations, HTTP grants and the request facts",
          state: "open",
        },
      ],
    }),
  );
});
await new Promise((resolve) => demo6UpstreamServer.listen(0, "127.0.0.1", resolve));
const demo6UpstreamUrl = `http://127.0.0.1:${demo6UpstreamServer.address().port}`;

async function ensureDemo6() {
  if (activeDemo === "demo6" && demo6.contractor && activePepProc && activePepProc.exitCode === null) {
    return;
  }
  await closeActiveSessions();

  const policyBody = {
    roles: [
      { name: "sam-admin", allowed_services: ["*"], allowed_targets: ["*"] },
      { name: "sam:role:router", allowed_services: ["*"], allowed_targets: ["*"] },
      {
        name: "sam:role:node",
        allowed_services: ["*"],
        allowed_targets: ["*"],
        allowed_labels: ["*"],
      },
      {
        name: "contractor",
        allowed_services: ["egress://api.github.com"],
        allowed_targets: ["*"],
        http: [
          {
            service: "egress://api.github.com",
            methods: ["GET"],
            paths: ["/repos/acme/*"],
          },
        ],
      },
    ],
    bindings: [],
    egress: [
      {
        name: "api.github.com",
        target_url: demo6UpstreamUrl,
        credential: "github-eu",
        served_by: ["site=eu"],
      },
    ],
  };
  const polRes = await fetch(`${samOneUrl}/policies`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(policyBody),
  });
  if (!polRes.ok) {
    throw new Error(`POST /policies failed for demo6: ${polRes.status}`);
  }

  const pepDir = fs.mkdtempSync(path.join(samOneDataDir, "pep-"));
  const secretsDir = path.join(pepDir, "secrets");
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(secretsDir, "github-eu"), `${demo6.secretPreview}\n`, { mode: 0o600 });
  const pepConfig = path.join(pepDir, "pep.yaml");
  fs.writeFileSync(pepConfig, 'version: "v1alpha1"\nlabels:\n  site: eu\n');
  const apiTokenPath = path.join(pepDir, "api-token");
  const pepApiToken = "pep-local-api-token";
  fs.writeFileSync(apiTokenPath, `${pepApiToken}\n`, { mode: 0o600 });
  const joinTokenPath = path.join(samOneDataDir, "join-token");

  const pepApiPort = await getFreePort();
  activePepProc = spawn(
    SAM_NODE_BIN,
    [
      "run",
      "--control-plane",
      samOneUrl,
      "--insecure-control-plane",
      "--data-dir",
      path.join(pepDir, "data"),
      "--api-token-path",
      apiTokenPath,
      "--bootstrap-token-path",
      joinTokenPath,
      "--bind-addr",
      `127.0.0.1:${pepApiPort}`,
      "--listen",
      "/ip4/127.0.0.1/tcp/0",
      "--allow-loopback",
      "--config",
      pepConfig,
      "--secrets-dir",
      secretsDir,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${pepApiPort}/healthz`);
      if (r.ok) break;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  const meshInfo = await (
    await fetch(`http://127.0.0.1:${pepApiPort}/debug/mesh-info`, {
      headers: { "X-Sam-Authentication": `Bearer ${pepApiToken}` },
    })
  ).json();
  const netInfo = await (
    await fetch(`http://127.0.0.1:${pepApiPort}/debug/network-info`, {
      headers: { "X-Sam-Authentication": `Bearer ${pepApiToken}` },
    })
  ).json();
  demo6.pepPeerId = meshInfo.peer_id;
  const tcpListen = netInfo.listen_addresses.find((a) => a.includes("/tcp/"));
  demo6.pepTcpAddr = `${tcpListen}/p2p/${demo6.pepPeerId}`;

  const contractorToken = await mintBootstrapToken("contractor", 10, "Contractor Egress Token");
  demo6.contractor = await enrollAndJoin(contractorToken, "contractor");
  activeSessions.push(demo6.contractor.session);
  await demo6.contractor.session.syncPolicy();
  demo6.datalogRules = demo6.contractor.session.policyRules;
  await demo6.contractor.session.connect(demo6.pepTcpAddr);

  activeDemo = "demo6";
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

function resolveBrowserSdkAsset(filename) {
  const publicCandidate = path.join(__dirname, "public", "sdk", filename);
  if (fs.existsSync(publicCandidate)) return publicCandidate;
  const samBinCandidate = path.join(__dirname, ".sam-bin", "sdk", filename);
  if (fs.existsSync(samBinCandidate)) return samBinCandidate;
  return path.join(__dirname, "..", "sam", "sdk", "js", "build", "browser", filename);
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

    if (req.method === "GET" && url.pathname === "/sdk/index.js") {
      try {
        const content = fs.readFileSync(resolveBrowserSdkAsset("index.js"), "utf8");
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(content);
      } catch (err) {
        res.writeHead(500);
        res.end(`Failed to load SDK bundle: ${err.message}`);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/sdk/biscuit_bg.wasm") {
      try {
        const content = fs.readFileSync(resolveBrowserSdkAsset("biscuit_bg.wasm"));
        res.writeHead(200, { "Content-Type": "application/wasm" });
        res.end(content);
      } catch (err) {
        res.writeHead(500);
        res.end(`Failed to load WASM: ${err.message}`);
      }
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
        await enrolled.session.acceptA2A({
          name: "room",
          handler: async (reqMsg, caller) => {
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

    // ---- DEMO 5 ENDPOINTS ----
    if (req.method === "GET" && url.pathname === "/api/demo5/state") {
      await ensureDemo5();
      sendJson(res, 200, {
        samOneUrl: demo5.samOneUrl,
        browserToken: demo5.browserToken,
        enrollUri: demo5.enrollUri,
      });
      return;
    }

    // ---- DEMO 6 ENDPOINTS ----
    if (req.method === "GET" && url.pathname === "/api/demo6/state") {
      await ensureDemo6();
      sendJson(res, 200, {
        pepPeerId: demo6.pepPeerId,
        pepLabel: demo6.pepLabel,
        secretName: demo6.secretName,
        contractorPeerId: demo6.contractor.session.peerId,
        contractorRole: "contractor",
        datalogRules: demo6.datalogRules,
        requests: demo6.requests,
        upstreamLog: demo6.upstreamLog,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo6/request") {
      await ensureDemo6();
      const { method = "GET", path: reqPath = "/repos/acme/dubbing/pulls?state=open" } = await readJson(req);
      const t0 = performance.now();
      await demo6.contractor.session.connect(demo6.pepTcpAddr);
      const r = await demo6.contractor.session.request(
        demo6.pepPeerId,
        "egress://api.github.com",
        reqPath,
        { method },
      );
      const latencyMs = Math.max(1, Math.round(performance.now() - t0));
      const cleanPath = reqPath.split("?")[0];
      let parsedBody;
      try {
        parsedBody = JSON.parse(r.text());
      } catch {
        parsedBody = { message: r.text().trim() };
      }
      const entry = {
        id: demo6.requests.length + 1,
        method,
        path: reqPath,
        status: r.status,
        latencyMs,
        proxyStatus: r.headers["proxy-status"] || null,
        facts: [
          `service("egress", "api.github.com")`,
          `method("${method}")`,
          `path("${cleanPath}")`,
          `host("api.github.com")`,
        ],
        response: parsedBody,
      };
      demo6.requests.push(entry);
      sendJson(res, 200, {
        entry,
        upstreamLog: demo6.upstreamLog,
      });
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
  demo6UpstreamServer.close();
  if (samOneProc && samOneProc.exitCode === null) {
    samOneProc.kill("SIGTERM");
  }
  fs.rmSync(samOneDataDir, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
