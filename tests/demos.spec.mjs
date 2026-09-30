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

import { test, expect } from "@playwright/test";

test("1. Zero-Trust Two-Agent Playground: A2A messaging, live Datalog policy toggle, and GossipSub peer ban", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#d1-alpha-peer")).toHaveText(/^12D3KooW/);
  await expect(page.locator("#d1-beta-peer")).toHaveText(/^12D3KooW/);

  // Send A2A request from Alpha to Beta -> 200 OK
  await page.click("#d1-send-alpha");
  await expect(page.locator('#d1-stream-log .event-item[data-status="200"]').first()).toContainText("HTTP 200 OK");

  // Restrict Datalog policy -> 403 Forbidden
  await page.click("#d1-btn-deny");
  await expect(page.locator("#d1-policy-badge")).toHaveText("POLICY: DENY a2a://*");
  await page.click("#d1-send-alpha");
  await expect(page.locator('#d1-stream-log .event-item[data-status="403"]').first()).toContainText("HTTP 403 FORBIDDEN");

  // Restore Datalog policy -> 200 OK
  await page.click("#d1-btn-allow");
  await expect(page.locator("#d1-policy-badge")).toHaveText("POLICY: ALLOW *");

  // Revoke Beta via GossipSub PEER_BAN -> subsequent call fails
  await page.click("#d1-btn-ban");
  await expect(page.locator("#d1-beta-status")).toHaveText("REVOKED (PEER_BAN)");
  await page.click("#d1-send-alpha");
  await expect(page.locator('#d1-stream-log .event-item[data-status="banned"]').first()).toContainText("GOSSIPSUB PEER_BAN ENFORCED");

  // Toggling policy while Beta is banned succeeds without error, and Re-Enroll Beta restores connectivity
  await page.click("#d1-btn-deny");
  await expect(page.locator("#d1-policy-badge")).toHaveText("POLICY: DENY a2a://*");
  await page.click("#d1-btn-reset");
  await expect(page.locator("#d1-beta-status")).toHaveText("ADMITTED");
  await expect(page.locator("#d1-policy-badge")).toHaveText("POLICY: ALLOW *");
});

test("2. Polyglot Hop Tracer: 2-hop verified caller lineage across Coordinator -> Researcher -> GitAnalyzer", async ({ page }) => {
  await page.goto("/?demo=demo2");
  await expect(page.locator("#d2-peer-1")).toHaveText(/^12D3KooW/);
  await expect(page.locator("#d2-peer-2")).toHaveText(/^12D3KooW/);
  await expect(page.locator("#d2-peer-3")).toHaveText(/^12D3KooW/);

  await page.click("#d2-run-trace");
  await expect(page.locator('#d2-waterfall .event-item[data-trace-id="1"]')).toContainText("Hop 1 Verified Caller:");
  await expect(page.locator('#d2-waterfall .event-item[data-trace-id="1"]')).toContainText("Hop 2 Verified Caller:");
});

test("3. Scan-to-Join Multi-Agent Room: bounded 4-slot enrollment token, 5th rogue rejection, and A2A broadcast", async ({ page }) => {
  await page.goto("/?demo=demo3");
  await expect(page.locator("#d3-enroll-uri")).toContainText("sam://enroll?server=");

  await page.click("#d3-join-1");
  await page.click("#d3-join-2");
  await page.click("#d3-join-3");
  await page.click("#d3-join-4");
  await expect(page.locator("#d3-budget-badge")).toHaveText("4 / 4 Slots Claimed");

  // 5th join exceeds token budget and is rejected by sam-one
  await page.click("#d3-join-rogue");
  await expect(page.locator('#d3-rejections .event-item[data-rejected="Uninvited Scraper"]')).toContainText("max usages");

  // Broadcast directive from Commander to the 3 other room members over A2A
  await page.click("#d3-broadcast-btn");
  await expect(page.locator("#d3-messages .event-item").first()).toContainText("3 Verified Replies");
});

test("4. Federated Specialist Swarm: concurrent A2A fan-out across 3 mesh specialists", async ({ page }) => {
  await page.goto("/?demo=demo4");
  await expect(page.locator("#d4-orch-peer")).toHaveText(/^12D3KooW/);

  await page.click("#d4-fanout-btn");
  await expect(page.locator('#d4-verdict .event-item[data-verdict="approved"]')).toContainText("APPROVED (3/3 verified mesh specialists passed");
});

test("5. Browser Gemini Chat: in-browser WebAssembly Biscuit + Cloudflare/WebSocket libp2p enrollment and Gemini chat", async ({ page, context }) => {
  await page.goto("/?demo=demo5");
  await expect(page.locator("#d5-enroll-url")).toHaveValue(/^sam:\/\/enroll\?server=/);
  await expect(page.locator("#d5-gemini-peer")).toHaveValue(/^12D3KooW/);

  const enrollUri = await page.locator("#d5-enroll-url").inputValue();
  const geminiPeer = await page.locator("#d5-gemini-peer").inputValue();

  await page.click("#d5-parse-btn");
  await page.click("#d5-join-btn");
  await expect(page.locator("#d5-peer-id")).toHaveText(/^12D3KooW/, { timeout: 15000 });
  const tab1PeerId = (await page.locator("#d5-peer-id").textContent()).trim();
  await expect(page.locator("#d5-status-badge")).toHaveText("Connected");
  await expect(page.locator("#d5-console")).toContainText("Served /.well-known/agent-card.json to verified peer");
  await expect(page.locator("#d5-console")).toContainText("Consulted mesh Gemini (egress://generativelanguage.googleapis.com) from browser");
  await expect(page.locator("#d5-console")).toContainText("Accepted A2A SendMessage from verified peer");

  // Discover services and populate clickable endpoint chips
  await page.click("#d5-discover-btn");
  await expect(page.locator("#d5-discovered-list button")).toHaveCount(2);

  // Send a normal chat message from the browser tab to Gemini over the mesh
  await page.click("#d5-banter-btn");
  await expect(page.locator("#d5-chat-log")).toContainText("egress://generativelanguage.googleapis.com • Verified Biscuit", { timeout: 15000 });

  // Open a 2nd browser tab in pure standalone GitHub Pages mode (/api/* blocked) with ?enroll=sam://... (auto-discovers Gemini via DHT)
  const page2 = await context.newPage();
  await page2.route("**/api/**", (route) => route.fulfill({ status: 404, body: "Not Found" }));
  await page2.goto(
    `/?enroll=${encodeURIComponent(enrollUri)}&targetPeer=${encodeURIComponent(tab1PeerId)}&targetService=${encodeURIComponent("a2a://browser-agent")}`,
  );
  await expect(page2.locator("#panel-demo5")).toHaveClass(/active/);
  await page2.click("#d5-join-btn");
  await expect(page2.locator("#d5-peer-id")).toHaveText(/^12D3KooW/, { timeout: 15000 });
  await expect(page2.locator("#d5-status-badge")).toHaveText("Connected");
  await expect(page2.locator("#d5-gemini-peer")).toHaveValue(geminiPeer, { timeout: 10000 });

  // Browser Tab 2 sends an A2A message directly to Browser Tab 1 over WebSocket Circuit Relay v2
  await page2.fill("#d5-chat-input", "Ping from standalone GitHub Pages Tab 2!");
  await page2.click("#d5-send-a2a-btn");
  await expect(page2.locator("#d5-chat-log")).toContainText("Verified A2A Reply", { timeout: 15000 });

  await page2.click("#d5-leave-btn");
  await page2.close();

  await page.click("#d5-leave-btn");
  await expect(page.locator("#d5-status-badge")).toHaveText("Disconnected");
});

test("6. Egress PEP & HTTP Grants: sam-node egress gateway, method/path Datalog narrowing, and secret injection", async ({ page }) => {
  await page.goto("/?demo=demo6");
  await expect(page.locator("#d6-contractor-peer")).toHaveText(/^12D3KooW/, { timeout: 15000 });
  await expect(page.locator("#d6-pep-peer")).toContainText("site=eu");

  // 1. Allowed GET /repos/acme/dubbing/pulls?state=open -> 200 OK, Biscuit stripped, secret injected
  await page.click("#d6-btn-allow");
  await expect(page.locator('#d6-requests .event-item[data-status="200"]')).toContainText("injected github-eu secret");
  await expect(page.locator("#d6-upstream-count")).toHaveText("1 Requests Seen");
  await expect(page.locator("#d6-upstream-log .event-item").first()).toContainText("Biscuit Stripped: YES");

  // 2. Denied POST /repos/acme/dubbing/pulls -> 403 Forbidden (method not in ["GET"])
  await page.click("#d6-btn-deny-method");
  await expect(page.locator('#d6-requests .event-item[data-status="403"][data-method="POST"]')).toContainText("http_request_denied");

  // 3. Denied GET /user/keys -> 403 Forbidden (path outside /repos/acme/*)
  await page.click("#d6-btn-deny-path");
  await expect(page.locator('#d6-requests .event-item[data-status="403"]')).toHaveCount(2);

  // Denied calls never touch the upstream destination
  await expect(page.locator("#d6-upstream-count")).toHaveText("1 Requests Seen");
});

test("7. AI Incident War Room: multi-agent A2A roast chain and Gemini Egress PEP enforcement", async ({ page }) => {
  await page.goto("/?demo=demo7");
  await expect(page.locator("#d7-detective-peer")).toHaveText(/^12D3KooW/, { timeout: 15000 });
  await expect(page.locator("#d7-pep-peer")).toContainText("site=us-central1");

  // Interrogate all 3 suspect agents over A2A; each consults Gemini through the sam-node Egress PEP
  await page.click("#d7-interrogate-all-btn");
  await expect(page.locator('#d7-chat-feed .event-item[data-conv-id="1"]')).toContainText("Chad (10x Cowboy Coder)");
  await expect(page.locator('#d7-chat-feed .event-item[data-conv-id="1"]')).toContainText("Vera (Paranoid Zero-Trust Auditor)");
  await expect(page.locator('#d7-chat-feed .event-item[data-conv-id="1"]')).toContainText("BlameBot-9000 (Sleepless SRE Oracle)");
  await expect(page.locator('#d7-chat-feed .event-item[data-conv-id="1"]')).toContainText("SYNTHESIZED POST-MORTEM VERDICT");

  // Verify 4 authorized POST /v1beta/openai/chat/completions calls (3 suspects + 1 detective verdict)
  await expect(page.locator('#d7-egress-log .event-item[data-egress-status="200"]')).toHaveCount(4);

  // Rogue DELETE /v1beta/models/gemini-2.5-flash is rejected by Datalog HTTP narrowing rules
  await page.click("#d7-test-deny-btn");
  await expect(page.locator('#d7-egress-log .event-item[data-egress-status="403"][data-egress-method="DELETE"]')).toContainText("http_request_denied");
});

