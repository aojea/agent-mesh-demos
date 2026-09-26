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
});

test("2. Polyglot Hop Tracer: 2-hop verified caller lineage across Coordinator -> Researcher -> GitAnalyzer", async ({ page }) => {
  await page.goto("/");
  await page.click("#tab-demo2");
  await expect(page.locator("#d2-peer-1")).toHaveText(/^12D3KooW/);
  await expect(page.locator("#d2-peer-2")).toHaveText(/^12D3KooW/);
  await expect(page.locator("#d2-peer-3")).toHaveText(/^12D3KooW/);

  await page.click("#d2-run-trace");
  await expect(page.locator('#d2-waterfall .event-item[data-trace-id="1"]')).toContainText("Hop 1 Verified Caller:");
  await expect(page.locator('#d2-waterfall .event-item[data-trace-id="1"]')).toContainText("Hop 2 Verified Caller:");
});

test("3. Scan-to-Join Multi-Agent Room: bounded 4-slot enrollment token, 5th rogue rejection, and A2A broadcast", async ({ page }) => {
  await page.goto("/");
  await page.click("#tab-demo3");
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
  await page.goto("/");
  await page.click("#tab-demo4");
  await expect(page.locator("#d4-orch-peer")).toHaveText(/^12D3KooW/);

  await page.click("#d4-fanout-btn");
  await expect(page.locator('#d4-verdict .event-item[data-verdict="approved"]')).toContainText("APPROVED (3/3 verified mesh specialists passed");
});
