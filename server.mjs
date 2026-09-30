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
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, Message, Role } from "@a2a-js/sdk";
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from "@a2a-js/sdk/server";

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

const localCloudflaredBin = path.join(__dirname, ".sam-bin", "cloudflared");
const SAM_TUNNEL = process.env.SAM_TUNNEL ?? "cloudflare";

const samOnePort = await getFreePort();
const samOneDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sam-one-demos-"));
const samOneUrl = `http://127.0.0.1:${samOnePort}`;

const samOneArgs = [
  "--bind-address",
  "127.0.0.1",
  "--port",
  String(samOnePort),
  "--p2p-listen",
  "/ip4/127.0.0.1/tcp/0",
  "--data-dir",
  samOneDataDir,
];
if (SAM_TUNNEL === "cloudflare") {
  samOneArgs.push("--tunnel", "cloudflare", "--tunnel-install");
  if (fs.existsSync(localCloudflaredBin)) {
    samOneArgs.push("--cloudflared-path", localCloudflaredBin);
  }
}

const samOneProc = spawn(SAM_ONE_BIN, samOneArgs, {
  env: { ...process.env, SAM_ADMIN_TOKEN: ADMIN_TOKEN },
  stdio: ["ignore", "pipe", "pipe"],
});
samOneProc.stdout.on("data", () => {});
samOneProc.stderr.on("data", () => {});
await waitForReady(samOneUrl, 30000);

const joinToken = fs.readFileSync(path.join(samOneDataDir, "join-token"), "utf8").trim();
let routerPeerId = null;
let cloudflareUrl = null;
let routerAddr = `/ip4/127.0.0.1/tcp/${samOnePort}/ws`;
for (let i = 0; i < 60; i++) {
  const statusRes = await fetch(`${samOneUrl}/admin/status`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (statusRes.ok) {
    const statusJson = await statusRes.json();
    const rt = statusJson.active_routers?.[0];
    if (rt) {
      routerPeerId = rt.PeerID || null;
      routerAddr = rt.Addresses?.[0] || routerAddr;
      const cfAddr = (rt.Addresses || []).find((a) => a.includes("trycloudflare.com"));
      if (cfAddr) {
        const m = cfAddr.match(/\/dns4\/([^/]+)\//);
        if (m) cloudflareUrl = `https://${m[1]}`;
      }
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
  const localWsAddr = routerPeerId
    ? `/ip4/127.0.0.1/tcp/${samOnePort}/ws/p2p/${routerPeerId}`
    : null;
  const routerAddresses = localWsAddr ? [localWsAddr] : undefined;
  const session = await mesh.join(routerAddresses ? { routerAddresses } : undefined);
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
// A2A Protocol (@a2a-js/sdk) Helpers over SAM Mesh (/libp2p-http)
// ============================================================================
async function registerA2AAgent(session, { name, title, description, onMessage }) {
  const url = sdk.MeshSession.meshURL(session.peerId, `a2a://${name}`);
  const card = {
    name: title,
    description,
    version: "1.0.0",
    supportedInterfaces: [
      {
        url,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: undefined,
    documentationUrl: "",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: name,
        name: title,
        description,
        tags: ["a2a", "sam-mesh", name],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ],
    signatures: [],
    iconUrl: "",
  };

  const verifiedCallers = new Map();
  const executor = {
    async execute(context, eventBus) {
      const text = context.userMessage.parts
        .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
        .join("");
      const callerPeerId = context.context?.user?.userName ?? "";
      const caller = verifiedCallers.get(callerPeerId) || {
        peerId: callerPeerId,
        roles: [],
      };
      let inputObj = { text };
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") inputObj = parsed;
      } catch {
        // plain text message
      }
      const resultPayload = await onMessage(inputObj, caller, text);
      const replyText =
        typeof resultPayload === "string"
          ? resultPayload
          : JSON.stringify(resultPayload);
      eventBus.publish(
        AgentEvent.message({
          messageId: crypto.randomUUID(),
          contextId: context.contextId,
          taskId: "",
          role: Role.ROLE_AGENT,
          parts: [
            {
              content: { $case: "text", value: replyText },
              filename: "",
              mediaType: "application/json",
              metadata: undefined,
            },
          ],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        }),
      );
      eventBus.finished();
    },
    async cancelTask() {},
  };

  const transport = new JsonRpcTransportHandler(
    new DefaultRequestHandler(card, new InMemoryTaskStore(), executor),
  );

  await session.acceptA2A({
    name,
    handler: async (request, caller) => {
      verifiedCallers.set(caller.peerId, caller);
      const reqPath = new URL(request.url).pathname;
      if (request.method === "GET" && reqPath === `/${AGENT_CARD_PATH}`) {
        return Response.json(card);
      }
      if (request.method !== "POST") {
        return new Response("not found\n", { status: 404 });
      }
      const callContext = new ServerCallContext({
        user: { isAuthenticated: true, userName: caller.peerId },
        requestedVersion: request.headers.get("a2a-version") ?? undefined,
      });
      const result = await transport.handle(await request.text(), callContext);
      if (Symbol.asyncIterator in result) {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
          async pull(controller) {
            const next = await result.next();
            if (next.done) {
              controller.close();
            } else {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
            }
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json(result);
    },
  });
}

async function callA2AAgent(senderSession, targetPeerId, targetService, payload) {
  await senderSession.connect(targetPeerId);
  const baseFetch = senderSession.fetch();
  let lastStatus = 200;
  let lastErrorText = "";
  const fetchImpl = async (input, init) => {
    const res = await baseFetch(input, init);
    lastStatus = res.status;
    if (!res.ok) {
      lastErrorText = await res.clone().text();
    }
    return res;
  };

  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  });
  const agentUrl = sdk.MeshSession.meshURL(targetPeerId, targetService);
  try {
    const client = await factory.createFromUrl(`${agentUrl}/`);
    const card = await client.getAgentCard();
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    const answer = await client.sendMessage({
      tenant: "",
      message: Message.fromJSON({
        messageId: crypto.randomUUID(),
        role: Role[Role.ROLE_USER],
        parts: [{ text }],
      }),
      configuration: undefined,
      metadata: undefined,
    });
    const parts = "parts" in answer ? answer.parts : (answer.status?.message?.parts ?? []);
    const replyText = parts
      .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
      .join("");
    let data;
    try {
      data = JSON.parse(replyText);
    } catch {
      data = { raw: replyText };
    }
    return { status: 200, card, data };
  } catch (err) {
    if (lastStatus === 403 || String(err.message).includes("403")) {
      return {
        status: 403,
        data: { raw: lastErrorText || err.message },
      };
    }
    throw err;
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

  await registerA2AAgent(demo1.alpha.session, {
    name: "planner",
    title: "Agent Alpha (Planner)",
    description: "Plans release deployments and coordinates audits over A2A.",
    onMessage: async (body, caller) => ({
      agent: "Agent Alpha (Planner)",
      responderPeerId: demo1.alpha.session.peerId,
      verifiedCallerPeerId: caller.peerId,
      verifiedCallerRoles: caller.roles,
      reply: `Plan updated with audit feedback: "${body.text}"`,
    }),
  });

  await registerA2AAgent(demo1.beta.session, {
    name: "auditor",
    title: "Agent Beta (Security Auditor)",
    description: "Verifies release SBOMs and cryptographic attestations over A2A.",
    onMessage: async (body, caller) => ({
      agent: "Agent Beta (Security Auditor)",
      responderPeerId: demo1.beta.session.peerId,
      verifiedCallerPeerId: caller.peerId,
      verifiedCallerRoles: caller.roles,
      reply: `Zero-trust audit passed for: "${body.text}" (Biscuit signature verified, no raw token forwarded)`,
    }),
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

  await registerA2AAgent(demo2.gitAnalyzer.session, {
    name: "git-analyzer",
    title: "GitAnalyzer Agent",
    description: "Inspects commit diffs and security posture over A2A.",
    onMessage: async (body, caller) => ({
      tool: "summarize_diff",
      providerPeerId: demo2.gitAnalyzer.session.peerId,
      verifiedCallerPeerId: caller.peerId,
      summary: `Analyzed ${body.commit || "HEAD~1..HEAD"}: TLS 1.3 WebSocket transport added in sdk/js/src/host.ts (+194/-0 lines), 0 vulnerabilities detected.`,
    }),
  });

  await registerA2AAgent(demo2.researcher.session, {
    name: "researcher",
    title: "Researcher Agent",
    description: "Delegates commit analysis to GitAnalyzer over a 2nd A2A hop.",
    onMessage: async (body, caller) => {
      const hop2Start = performance.now();
      const hop2Res = await callA2AAgent(
        demo2.researcher.session,
        demo2.gitAnalyzer.session.peerId,
        "a2a://git-analyzer",
        { commit: body.commit || "main@9f4c21a" },
      );
      const hop2Ms = Math.max(1, Math.round(performance.now() - hop2Start));
      const toolData = hop2Res.data;
      return {
        researcherPeerId: demo2.researcher.session.peerId,
        verifiedCoordinatorPeerId: caller.peerId,
        hop2Ms,
        downstream: toolData,
        synthesis: `Verified diff via ${toolData.providerPeerId.slice(0, 16)}...: ${toolData.summary}`,
      };
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
    await registerA2AAgent(spec.session, {
      name: spec.service,
      title: spec.name,
      description: `Specialist A2A reviewer for ${spec.domain}.`,
      onMessage: async (body, caller) => {
        const findingsBySpec = {
          sec: `Ed25519 PoP verified; Mutual TLS 1.3 + Biscuit attestation confirmed for "${body.proposal}". Verdict: PASS.`,
          perf: `Single-port WebSocket + Yamux multiplexing keeps P99 relay overhead < 4ms for "${body.proposal}". Verdict: PASS.`,
          comp: `Datalog policy predicates carry >=1 term; X-SAM-Biscuit stripped prior to workload handler. Verdict: PASS.`,
        };
        return {
          specialist: spec.name,
          domain: spec.domain,
          peerId: spec.session.peerId,
          verifiedOrchestratorPeerId: caller.peerId,
          finding: findingsBySpec[spec.id],
        };
      },
    });
  }
  activeDemo = "demo4";
}

// ============================================================================
// Gemini Egress Origin & Witty Persona Engine (Live Gemini API + Simulator)
// ============================================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const geminiVaultSecret = GEMINI_API_KEY || "AIzaSy_vault_gemini_egress_77c9a1";

function generateWittyCompletion(messages = [], personaHint = "") {
  const sys = messages.find((m) => m.role === "system")?.content || "";
  const userMsg = messages.filter((m) => m.role === "user").pop()?.content || "";
  const combined = `${personaHint} ${sys}`.toLowerCase();

  // Extract topic and any prior agent quotes passed in the prompt
  const topicMatch = userMsg.match(/INCIDENT_TOPIC:\s*"([^"]+)"/i);
  const topic = topicMatch ? topicMatch[1] : userMsg.slice(0, 140);
  const priorMatch = userMsg.match(/PRIOR_STATEMENTS:\s*([\s\S]+)$/i);
  const priorText = priorMatch ? priorMatch[1].trim() : "";

  if (combined.includes("cowboy") || combined.includes("chad")) {
    return `Look, regarding "${topic}" — unit tests were taking a whole 4 seconds, so I ran \`git push --force --no-verify\` straight to main from my Peloton. It compiled on my laptop! Honestly, if Vera's Datalog policy didn't stop me from shipping vibes-based code, that's on Security. LGTM! 🚀`;
  }
  if (combined.includes("paranoid") || combined.includes("vera")) {
    const chadRoast = priorText
      ? `Chad literally just admitted to force-pushing from an unattested exercise bike! `
      : "";
    return `${chadRoast}For "${topic}", I am treating this as a nation-state APT intrusion until proven otherwise. I've already rotated the Biscuit root key 4 times, revoked the office espresso machine's Peer ID, and locked down egress to POST-only.`;
  }
  if (combined.includes("sre") || combined.includes("blamebot")) {
    const bothRoast = priorText
      ? `After parsing Chad's Peloton confession and Vera's 4th key rotation, my circuits are weeping. `
      : "";
    return `Beep boop. PagerDuty woke me up at 03:14 UTC for "${topic}". ${bothRoast}\`git blame\` confirms Chad deleted the healthcheck and Vera's firewall blocked the auto-rollback pod. Remaining quarterly error budget: -418%. Filing SEV-1 and entering sleep mode.`;
  }
  if (combined.includes("detective") || combined.includes("verdict")) {
    return `CASE CLOSED on "${topic}": Chad broke prod with an unreviewed force-push, Vera quarantined half the cluster in retaliation, and BlameBot-9000 docked our SLA into the shadow realm. Zero-trust silver lining: every A2A hop was cryptographically verified by Biscuit and the Gemini API key never left the Egress PEP!`;
  }
  if (combined.includes("oracle") || combined.includes("roast")) {
    return `Mesh Roast Oracle here! You said: "${topic}". My diagnosis: 100% certified distributed systems chaos, delivered over a zero-trust WebSocket relay with Ed25519 Proof-of-Possession. Have you tried blaming DNS or bribing the Datalog authorizer?`;
  }
  return `Hello from Gemini over the Sovereign Agent Mesh! I received your message: "${topic}". Your request was authenticated with Biscuit Proof-of-Possession over /libp2p-http and routed through the mesh Egress PEP without exposing any API keys in the browser.`;
}

const geminiUpstreamLog = [];
const geminiUpstreamServer = http.createServer(async (req, res) => {
  const authHeader = req.headers.authorization || "none";
  const biscuitStripped = req.headers["x-sam-biscuit"] === undefined;

  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: GEMINI_MODEL, object: "model", owned_by: "google-gemini-egress" }],
      }),
    );
    return;
  }

  const body = await readJson(req);
  const messages = body.messages || [];
  const personaHeader = req.headers["x-sam-agent-persona"] || "";

  let replyText = "";
  let mode = "simulator";

  if (GEMINI_API_KEY) {
    try {
      const liveRes = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${GEMINI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: GEMINI_MODEL,
            messages,
            max_tokens: 512,
            temperature: 0.7,
          }),
        },
      );
      if (liveRes.ok) {
        const liveJson = await liveRes.json();
        replyText = liveJson.choices?.[0]?.message?.content?.trim() || "";
        if (replyText) mode = "live-gemini";
      }
    } catch {
      // Fallback to simulator when offline
    }
  }

  if (!replyText) {
    replyText = generateWittyCompletion(messages, personaHeader);
  }

  const logEntry = {
    id: geminiUpstreamLog.length + 1,
    method: req.method,
    path: req.url,
    agent: personaHeader || "mesh-agent",
    injectedAuth: authHeader.startsWith("Bearer ")
      ? `Bearer ${authHeader.slice(7, 19)}****`
      : authHeader,
    biscuitStripped,
    mode,
    timestamp: new Date().toISOString(),
  };
  geminiUpstreamLog.push(logEntry);

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
      object: "chat.completion",
      model: GEMINI_MODEL,
      mode,
      biscuitStripped,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: replyText },
          finish_reason: "stop",
        },
      ],
    }),
  );
});
await new Promise((resolve) => geminiUpstreamServer.listen(0, "127.0.0.1", resolve));
const geminiUpstreamUrl = `http://127.0.0.1:${geminiUpstreamServer.address().port}`;

// ============================================================================
// DEMO 5: Zero-Install Browser Playground + Interactive Mesh Oracle
// ============================================================================
const browserToken = await mintBootstrapToken("sam:role:node", 100, "Browser Playground Token");
const demo5 = {
  samOneUrl,
  browserToken,
  enrollUri: `sam://enroll?server=${encodeURIComponent(samOneUrl)}&token=${encodeURIComponent(browserToken)}`,
  verifier: null,
  geminiPep: null,
  companionService: "a2a://mesh-oracle",
  geminiService: "egress://generativelanguage.googleapis.com",
};

async function ensureGeminiPep() {
  if (!demo5.geminiPep) {
    demo5.geminiPep = await enrollAndJoin();
    await demo5.geminiPep.session.acceptA2A({
      name: "generativelanguage.googleapis.com",
      url: geminiUpstreamUrl,
    });
    demo5.geminiPep.session.endpoint.service = demo5.geminiService;
  }
  await demo5.geminiPep.session.syncPolicy().catch(() => {});
  await demo5.geminiPep.session.node.contentRouting
    .provide(await sdk.serviceCID("egress"))
    .catch(() => {});
  await demo5.geminiPep.session.node.contentRouting
    .provide(await sdk.serviceCID("egress", "generativelanguage.googleapis.com"))
    .catch(() => {});
}

async function ensureDemo5() {
  if (activeDemo === "demo5" && demo5.verifier && demo5.geminiPep) return;
  await closeActiveSessions();
  await setMeshPolicy("allow");
  await ensureGeminiPep();
  demo5.verifier = await enrollAndJoin();
  activeSessions.push(demo5.verifier.session);

  await registerA2AAgent(demo5.verifier.session, {
    name: "mesh-oracle",
    title: "Mesh Roast Oracle (AI Peer)",
    description: "Interactive AI companion agent on the mesh that banters with browser agents over A2A.",
    onMessage: async (body, caller) => {
      const promptText = body.text || "Hello from the browser!";
      const persona = body.persona || "oracle";
      const reply = generateWittyCompletion(
        [
          {
            role: "system",
            content: "You are the Mesh Roast Oracle, a witty AI agent on the SAM mesh.",
          },
          { role: "user", content: `INCIDENT_TOPIC: "${promptText}"` },
        ],
        persona,
      );
      return {
        agent: "Mesh Roast Oracle",
        responderPeerId: demo5.verifier.session.peerId,
        verifiedCallerPeerId: caller.peerId,
        reply,
      };
    },
  });
  await demo5.verifier.session.node.contentRouting
    .provide(await sdk.serviceCID("a2a"))
    .catch(() => {});
  await demo5.verifier.session.node.contentRouting
    .provide(await sdk.serviceCID("a2a", "mesh-oracle"))
    .catch(() => {});

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
  secretPreview: "ghp_eu_vault_99a8b7c6",
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
      destination: "api.github.com (EU Egress Origin)",
      method: req.method,
      path: req.url,
      injectedCredential: "github-eu (Bearer ghp_eu_vault_****)",
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

async function spawnPepNode({ site, secretName, secretValue }) {
  const pepDir = fs.mkdtempSync(path.join(samOneDataDir, `pep-${site}-`));
  const secretsDir = path.join(pepDir, "secrets");
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(secretsDir, secretName), `${secretValue}\n`, { mode: 0o600 });
  const pepConfig = path.join(pepDir, "pep.yaml");
  fs.writeFileSync(pepConfig, `version: "v1alpha1"\nlabels:\n  site: ${site}\n`);
  const apiTokenPath = path.join(pepDir, "api-token");
  const pepApiToken = `pep-${site}-api-token`;
  fs.writeFileSync(apiTokenPath, `${pepApiToken}\n`, { mode: 0o600 });
  const joinTokenPath = path.join(samOneDataDir, "join-token");

  const pepApiPort = await getFreePort();
  let stderrBuf = "";
  const proc = spawn(
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
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });
  activePepProc = proc;

  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`sam-node (${site}) exited early with code ${proc.exitCode}: ${stderrBuf}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${pepApiPort}/healthz`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!ready) {
    throw new Error(`sam-node (${site}) did not become healthy in time: ${stderrBuf}`);
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
  const pepPeerId = meshInfo.peer_id;
  const tcpListen = netInfo.listen_addresses.find((a) => a.includes("/tcp/"));
  const pepTcpAddr = `${tcpListen}/p2p/${pepPeerId}`;
  return { pepPeerId, pepTcpAddr };
}

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

  const { pepPeerId, pepTcpAddr } = await spawnPepNode({
    site: "eu",
    secretName: "github-eu",
    secretValue: demo6.secretPreview,
  });
  demo6.pepPeerId = pepPeerId;
  demo6.pepTcpAddr = pepTcpAddr;

  const contractorToken = await mintBootstrapToken("contractor", 10, "Contractor Egress Token");
  demo6.contractor = await enrollAndJoin(contractorToken, "contractor");
  activeSessions.push(demo6.contractor.session);
  await demo6.contractor.session.syncPolicy();
  demo6.datalogRules = demo6.contractor.session.policyRules;
  await demo6.contractor.session.connect(demo6.pepTcpAddr);

  activeDemo = "demo6";
}

// ============================================================================
// DEMO 7: "Who Broke Prod?" AI Incident War Room (Gemini Egress PEP + A2A)
// ============================================================================
const demo7 = {
  pepPeerId: null,
  pepTcpAddr: null,
  pepLabel: "site=us-central1",
  egressService: "egress://generativelanguage.googleapis.com",
  inferenceService: "inference://gemini",
  secretName: "gemini-api-key",
  detective: null,
  suspects: [],
  datalogRules: [],
  conversations: [],
  egressCalls: [],
};

async function callGeminiThroughPep(callerSession, agentLabel, systemPrompt, userPrompt, method = "POST", reqPath = "/v1beta/openai/chat/completions") {
  const t0 = performance.now();
  await callerSession.connect(demo7.pepTcpAddr);
  const r = await callerSession.request(
    demo7.pepPeerId,
    demo7.egressService,
    reqPath,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Sam-Agent-Persona": agentLabel,
      },
      body:
        method === "POST"
          ? new TextEncoder().encode(
              JSON.stringify({
                model: GEMINI_MODEL,
                messages: [
                  { role: "system", content: systemPrompt },
                  { role: "user", content: userPrompt },
                ],
              }),
            )
          : undefined,
    },
  );
  const latencyMs = Math.max(1, Math.round(performance.now() - t0));
  const cleanPath = reqPath.split("?")[0];
  let parsed;
  try {
    parsed = JSON.parse(r.text());
  } catch {
    parsed = { message: r.text().trim() };
  }
  const egressEntry = {
    id: demo7.egressCalls.length + 1,
    agent: agentLabel,
    callerPeerId: callerSession.peerId,
    method,
    path: reqPath,
    status: r.status,
    latencyMs,
    proxyStatus: r.headers["proxy-status"] || null,
    facts: [
      `service("egress", "generativelanguage.googleapis.com")`,
      `method("${method}")`,
      `path("${cleanPath}")`,
    ],
    reply: parsed.choices?.[0]?.message?.content || parsed.message || "",
    mode: parsed.mode || (GEMINI_API_KEY ? "live-gemini" : "witty-simulator"),
  };
  demo7.egressCalls.push(egressEntry);
  return egressEntry;
}

async function ensureDemo7() {
  if (activeDemo === "demo7" && demo7.detective && activePepProc && activePepProc.exitCode === null) {
    return;
  }
  await closeActiveSessions();

  const policyBody = {
    roles: [
      { name: "sam-admin", allowed_services: ["*"], allowed_targets: ["*"] },
      { name: "sam:role:router", allowed_services: ["*"], allowed_targets: ["*"] },
      {
        name: "sam:role:node",
        allowed_services: [
          "a2a://*",
          "egress://generativelanguage.googleapis.com",
          "inference://*",
        ],
        allowed_targets: ["*"],
        allowed_labels: ["*"],
        http: [
          {
            service: "egress://generativelanguage.googleapis.com",
            methods: ["POST"],
            paths: ["/v1beta/openai/*"],
          },
        ],
      },
    ],
    bindings: [],
    egress: [
      {
        name: "generativelanguage.googleapis.com",
        target_url: geminiUpstreamUrl,
        credential: "gemini-api-key",
        served_by: ["site=us-central1"],
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
    throw new Error(`POST /policies failed for demo7: ${polRes.status}`);
  }

  const { pepPeerId, pepTcpAddr } = await spawnPepNode({
    site: "us-central1",
    secretName: "gemini-api-key",
    secretValue: geminiVaultSecret,
  });
  demo7.pepPeerId = pepPeerId;
  demo7.pepTcpAddr = pepTcpAddr;

  demo7.detective = await enrollAndJoin();
  const suspectSpecs = [
    {
      id: "cowboy",
      name: "Chad (10x Cowboy Coder)",
      emoji: "🤠",
      service: "cowboy-coder",
      roleDesc: "Force-pushes straight to main with --no-verify",
      systemPrompt:
        "You are Chad, a chaotic 10x Cowboy Coder agent on a SAM mesh. In 2 funny sentences, defend your reckless code change for the user's incident and blame Vera (Security) or BlameBot (SRE).",
    },
    {
      id: "sec",
      name: "Vera (Paranoid Zero-Trust Auditor)",
      emoji: "🕵️‍♀️",
      service: "paranoid-sec",
      roleDesc: "Suspects every packet is a nation-state APT",
      systemPrompt:
        "You are Vera, a paranoid Zero-Trust Security Auditor agent on a SAM mesh. In 2 funny sentences, roast Chad's excuse, cite Biscuit Datalog rules, and propose an over-the-top quarantine.",
    },
    {
      id: "sre",
      name: "BlameBot-9000 (Sleepless SRE Oracle)",
      emoji: "🤖",
      service: "sre-oracle",
      roleDesc: "Passive-aggressively quotes git blame & SLA burn rates",
      systemPrompt:
        "You are BlameBot-9000, a deadpan passive-aggressive SRE agent woken up at 3 AM. In 2 funny sentences, roast both Chad and Vera with git blame receipts and announce the negative error budget.",
    },
  ];

  demo7.suspects = [];
  for (const spec of suspectSpecs) {
    const enrolled = await enrollAndJoin();
    const suspectObj = { ...spec, ...enrolled };
    demo7.suspects.push(suspectObj);

    await registerA2AAgent(enrolled.session, {
      name: spec.service,
      title: spec.name,
      description: spec.roleDesc,
      onMessage: async (body, caller) => {
        const userPrompt = `INCIDENT_TOPIC: "${body.prompt}"\n${
          body.priorStatements ? `PRIOR_STATEMENTS:\n${body.priorStatements}` : ""
        }`;
        const gemRes = await callGeminiThroughPep(
          enrolled.session,
          spec.name,
          spec.systemPrompt,
          userPrompt,
        );
        return {
          suspectId: spec.id,
          agent: spec.name,
          emoji: spec.emoji,
          service: `a2a://${spec.service}`,
          peerId: enrolled.session.peerId,
          verifiedCallerPeerId: caller.peerId,
          egressLatencyMs: gemRes.latencyMs,
          egressMode: gemRes.mode,
          reply: gemRes.reply,
        };
      },
    });
  }

  activeSessions.push(
    demo7.detective.session,
    ...demo7.suspects.map((s) => s.session),
  );
  await demo7.detective.session.syncPolicy();
  demo7.datalogRules = demo7.detective.session.policyRules;

  activeDemo = "demo7";
}

// Start with Gemini PEP online in the DHT and Demo 1 active
await ensureGeminiPep();
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, X-Sam-Challenge-Ts, X-Sam-Challenge-Sig",
  "Access-Control-Max-Age": "600",
};

const CONTROL_PLANE_PATHS = new Set([
  "/enroll",
  "/enroll/status",
  "/register",
  "/refresh",
  "/keys",
  "/info",
  "/policies",
  "/egress",
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (CONTROL_PLANE_PATHS.has(url.pathname)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyBuf = chunks.length ? Buffer.concat(chunks) : undefined;
      const fwdHeaders = {};
      for (const h of [
        "content-type",
        "accept",
        "authorization",
        "x-sam-challenge-ts",
        "x-sam-challenge-sig",
      ]) {
        if (req.headers[h]) fwdHeaders[h] = req.headers[h];
      }
      const cpRes = await fetch(`${samOneUrl}${url.pathname}${url.search}`, {
        method: req.method,
        headers: fwdHeaders,
        body: bodyBuf,
      });
      const respBuf = Buffer.from(await cpRes.arrayBuffer());
      const respHeaders = { ...CORS_HEADERS };
      const ct = cpRes.headers.get("content-type");
      if (ct) respHeaders["Content-Type"] = ct;
      res.writeHead(cpRes.status, respHeaders);
      res.end(respBuf);
      return;
    }

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
        datalogRules: demo1.alpha.session.policyRules,
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
        const r = await callA2AAgent(sender, receiver.peerId, targetService, { text });
        const latencyMs = Math.max(1, Math.round(performance.now() - t0));
        const entry = {
          id: demo1.messages.length + 1,
          from,
          fromPeerId: sender.peerId,
          toPeerId: receiver.peerId,
          targetService,
          text,
          status: r.status,
          latencyMs,
          response: r.data,
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
      await demo1.alpha.session.syncPolicy();
      if (!demo1.betaBanned) {
        await demo1.beta.session.refresh().catch(() => {});
        await demo1.beta.session.syncPolicy().catch(() => {});
      }
      sendJson(res, 200, {
        policyMode: demo1.policyMode,
        datalogRules: demo1.alpha.session.policyRules,
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

    if (req.method === "POST" && url.pathname === "/api/demo1/reset") {
      activeDemo = null;
      demo1.messages = [];
      await ensureDemo1();
      sendJson(res, 200, {
        alphaPeerId: demo1.alpha.session.peerId,
        betaPeerId: demo1.beta.session.peerId,
        betaBanned: demo1.betaBanned,
        policyMode: demo1.policyMode,
      });
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
      const r = await callA2AAgent(
        demo2.coordinator.session,
        demo2.researcher.session.peerId,
        "a2a://researcher",
        { commit },
      );
      const totalMs = Math.max(2, Math.round(performance.now() - t0));
      const payload = r.data;
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
        await registerA2AAgent(enrolled.session, {
          name: "room",
          title: `${name} (${roleLabel})`,
          description: `Incident response room member: ${name} (${roleLabel}).`,
          onMessage: async (body, caller) => ({
            member: name,
            peerId: enrolled.session.peerId,
            verifiedSender: caller.peerId,
            ack: `${name} (${roleLabel}) confirmed action for: "${body.directive}"`,
          }),
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
        const r = await callA2AAgent(
          commander.session,
          target.session.peerId,
          "a2a://room",
          { directive },
        );
        replies.push(r.data);
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
          const r = await callA2AAgent(
            demo4.orchestrator.session,
            s.session.peerId,
            `a2a://${s.service}`,
            { proposal },
          );
          const latencyMs = Math.max(1, Math.round(performance.now() - s0));
          return {
            ...r.data,
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
      const hostHeader = req.headers.host || `127.0.0.1:${PORT}`;
      const localCpUrl = `http://${hostHeader}`;
      const preferredCpUrl = cloudflareUrl || localCpUrl;
      const browserEnrollUri = `sam://enroll?server=${encodeURIComponent(preferredCpUrl)}&token=${encodeURIComponent(demo5.browserToken)}`;
      sendJson(res, 200, {
        samOneUrl: preferredCpUrl,
        cloudflareUrl,
        localCpUrl,
        browserToken: demo5.browserToken,
        enrollUri: browserEnrollUri,
        companionPeerId: demo5.verifier.session.peerId,
        companionService: demo5.companionService,
        geminiPeerId: demo5.geminiPep.session.peerId,
        geminiService: demo5.geminiService,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo5/verify") {
      await ensureDemo5();
      const { peerId, service = "a2a://browser-agent" } = await readJson(req);
      const r = await callA2AAgent(
        demo5.verifier.session,
        peerId,
        service,
        { text: "Verify in-browser A2A AgentCard & JSON-RPC endpoint over WebSocket relay" },
      );
      sendJson(res, 200, {
        verifierPeerId: demo5.verifier.session.peerId,
        agentCardName: r.card?.name,
        reply: r.data,
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

    // ---- DEMO 7 ENDPOINTS ----
    if (req.method === "GET" && url.pathname === "/api/demo7/state") {
      await ensureDemo7();
      sendJson(res, 200, {
        pepPeerId: demo7.pepPeerId,
        pepLabel: demo7.pepLabel,
        egressService: demo7.egressService,
        inferenceService: demo7.inferenceService,
        secretName: demo7.secretName,
        geminiMode: GEMINI_API_KEY ? "live-gemini" : "witty-simulator",
        detectivePeerId: demo7.detective.session.peerId,
        suspects: demo7.suspects.map((s) => ({
          id: s.id,
          name: s.name,
          emoji: s.emoji,
          service: `a2a://${s.service}`,
          roleDesc: s.roleDesc,
          peerId: s.session.peerId,
        })),
        datalogRules: demo7.datalogRules,
        conversations: demo7.conversations,
        egressCalls: demo7.egressCalls,
        upstreamLog: geminiUpstreamLog,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo7/interrogate") {
      await ensureDemo7();
      const {
        prompt = "Who pushed `DROP TABLE users; -- YOLO` to main on Friday at 4:59 PM?",
        target = "all",
      } = await readJson(req);

      const targets =
        target === "all"
          ? demo7.suspects
          : demo7.suspects.filter((s) => s.id === target);

      const t0 = performance.now();
      const turns = [];
      const priorLines = [];

      for (const suspect of targets) {
        const hopStart = performance.now();
        const a2aRes = await callA2AAgent(
          demo7.detective.session,
          suspect.session.peerId,
          `a2a://${suspect.service}`,
          {
            prompt,
            priorStatements: priorLines.join("\n"),
          },
        );
        const a2aMs = Math.max(1, Math.round(performance.now() - hopStart));
        const turn = {
          ...a2aRes.data,
          a2aMs,
        };
        turns.push(turn);
        priorLines.push(`${suspect.name}: "${turn.reply}"`);
      }

      let verdict = null;
      if (target === "all" && turns.length > 1) {
        const verdictGem = await callGeminiThroughPep(
          demo7.detective.session,
          "Agent Zero (Detective)",
          "You are Agent Zero, the Chief Incident Detective on a SAM mesh. Summarize the chaotic blame-game between Chad, Vera, and BlameBot-9000 in 2 hilarious sentences.",
          `INCIDENT_TOPIC: "${prompt}"\nPRIOR_STATEMENTS:\n${priorLines.join("\n")}`,
        );
        verdict = {
          agent: "Agent Zero (Incident Detective)",
          peerId: demo7.detective.session.peerId,
          egressLatencyMs: verdictGem.latencyMs,
          text: verdictGem.reply,
        };
      }

      const totalMs = Math.max(2, Math.round(performance.now() - t0));
      const conv = {
        id: demo7.conversations.length + 1,
        prompt,
        target,
        detectivePeerId: demo7.detective.session.peerId,
        totalMs,
        turns,
        verdict,
      };
      demo7.conversations.push(conv);
      sendJson(res, 200, {
        conversation: conv,
        egressCalls: demo7.egressCalls,
        upstreamLog: geminiUpstreamLog,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/demo7/egress-test") {
      await ensureDemo7();
      const {
        method = "DELETE",
        path: reqPath = "/v1beta/models/gemini-2.5-flash",
      } = await readJson(req);
      const egressEntry = await callGeminiThroughPep(
        demo7.detective.session,
        "Rogue Prompt Attempt",
        "",
        "",
        method,
        reqPath,
      );
      sendJson(res, 200, {
        egressEntry,
        egressCalls: demo7.egressCalls,
        upstreamLog: geminiUpstreamLog,
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("API Error:", url.pathname, err);
    sendJson(res, 500, { error: err.message });
  }
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(samOnePort, "127.0.0.1", () => {
    const reqLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      reqLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    reqLines.push("", "");
    upstream.write(reqLines.join("\r\n"));
    if (head && head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  const preferredCpUrl = cloudflareUrl || `http://127.0.0.1:${PORT}`;
  const enrollUri = `sam://enroll?server=${encodeURIComponent(preferredCpUrl)}&token=${encodeURIComponent(demo5.browserToken)}`;
  console.log(`SAM Demos server listening on http://127.0.0.1:${PORT} (sam-one at ${samOneUrl})`);
  console.log(`  Browser Gemini Chat: http://127.0.0.1:${PORT}/?demo=demo5`);
  if (cloudflareUrl) {
    console.log(`  Cloudflare Tunnel:   ${cloudflareUrl}`);
  }
  console.log(`  Enrollment URI:      ${enrollUri}`);
});

async function shutdown() {
  await closeActiveSessions();
  if (demo5.geminiPep?.session) {
    await demo5.geminiPep.session.close().catch(() => {});
  }
  server.close();
  demo6UpstreamServer.close();
  geminiUpstreamServer.close();
  if (samOneProc && samOneProc.exitCode === null) {
    samOneProc.kill("SIGTERM");
  }
  fs.rmSync(samOneDataDir, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
