# Sovereign Agent Mesh (`SAM`) — Interactive Demos

Interactive browser and multi-agent demos built on [`@sam-mesh/sdk`](https://github.com/google/sam/tree/main/sdk/js) and [`sam-one`](https://github.com/google/sam/tree/main/cmd/sam-one).

Every demo runs real `@sam-mesh/sdk` `MeshSession` agents connected over WebSockets (`/ws`) to a single-port `sam-one` server (control plane + libp2p circuit relay router + Biscuit Datalog policy authority).

## Demos Included

### 1. Zero-Trust Two-Agent Playground (`01-two-agent-playground`)
Two `@sam-mesh/sdk` agents (**Agent Alpha — Planner** and **Agent Beta — Security Auditor**) enroll with `sam-one`, dial its single-port WebSocket relay, and exchange A2A requests over `/libp2p-http`.
- Inspect live Biscuit facts (`node(...)`, `role("sam:role:node")`) and `X-SAM-Verified-Peer-ID` headers.
- Mutate the mesh's Datalog policy live (`POST /policies`) and watch unauthorized A2A calls get rejected at the stream gate before reaching the agent handler.
- Trigger a live peer revocation (`POST /users/nodes/revoke`) and watch `sam-one` broadcast a signed `PEER_BAN` over GossipSub (`sam/events/1.0.0`), terminating the peer's streams in milliseconds.

### 2. Polyglot "Follow the Packet" Hop Tracer (`02-polyglot-hop-tracer`)
Traces a single task cascading across multiple mesh members and protocols (`a2a://researcher` $\to$ `mcp://git-analyzer`):
- **Hop 1 (`@sam-mesh/sdk` Coordinator)** dials `a2a://researcher` over `/ws` + `/p2p-circuit`.
- **Hop 2 (Researcher Agent)** verifies the Coordinator's Biscuit token and invokes the `summarize_diff` tool on `mcp://git-analyzer`.
- **Hop 3 (MCP Tool Provider)** verifies the Researcher's Biscuit token, runs the analysis, and returns the result up the chain with per-hop latency and cryptographic peer verification.

### 3. "Scan-to-Join" Multi-Agent Room (`03-qr-multi-agent-room`)
Demonstrates `sam-one`'s bounded-budget device enrollment tokens (`sam://enroll?server=...&token=sam_dev_...`):
- Mints a shared room enrollment token with a strict usage budget (`max_usages: 4`).
- Four specialist agents (`Incident Commander`, `Log Triage`, `Patch Synthesizer`, `Mobile Approver`) claim a slot, generate Ed25519 identities, join the mesh room, and coordinate an incident mitigation over A2A.
- When a 5th uninvited agent attempts to reuse the room token, `sam-one` rejects the enrollment (`Bootstrap token max usages exceeded`).

### 4. Federated Specialist Swarm (`04-federated-inference-swarm`)
An Orchestrator Agent fans out a security & architecture review concurrently across three mesh specialist agents (`Security Specialist`, `Performance Profiler`, `Compliance Verifier`) over multiplexed Yamux streams through `sam-one`, streaming each verified peer's findings in parallel and synthesizing a unified release gate decision.

---

## Quick Start

### Prerequisites
- `sam-one` binary in `PATH` (or `SAM_ONE_BIN=/path/to/sam-one`)
- Node.js 22+

### Run the Demo Suite Interactively

```bash
SAM_ONE_BIN=/path/to/sam/bin/sam-one npm start
```

Open `http://127.0.0.1:4400` in your browser to switch between all four live demos.

### Re-record the `.mp4` Showcase Videos

```bash
SAM_ONE_BIN=/path/to/sam/bin/sam-one npm run record
```

This boots `sam-one` and the demo server, drives all four demos in headless Chromium (`1280x720`) via Playwright video capture, and transcodes the recordings with `ffmpeg` into high-DPI H.264 `.mp4` files under `videos/`.
