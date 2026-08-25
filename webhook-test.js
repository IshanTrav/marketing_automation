// A tiny throwaway webhook receiver, just to prove comment events actually
// arrive from Meta — not part of the real pipeline (that'll live in
// travafa-admin later). Handles the GET verification handshake and logs
// every POST payload it receives.
//
// Usage: node webhook-test.js
// Then use the printed public URL as the Callback URL in the app's
// webhook config, with VERIFY_TOKEN below as the Verify token.

import "dotenv/config";
import http from "http";

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "travafa-test-verify-123";
const PORT = 3456;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET") {
    // Meta's verification handshake
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    console.log("Verification request received:", { mode, token, challenge });

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Verify token matched — confirming subscription.");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(challenge);
    } else {
      console.log("Verify token did NOT match — rejecting.");
      res.writeHead(403);
      res.end();
    }
    return;
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      console.log("\n=== Webhook event received ===");
      console.log(JSON.stringify(JSON.parse(body || "{}"), null, 2));
      console.log("===============================\n");
      res.writeHead(200);
      res.end("EVENT_RECEIVED");
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Local webhook receiver listening on http://localhost:${PORT}`);
  console.log(`Verify token to use in the Meta dashboard: ${VERIFY_TOKEN}`);
  console.log("\nNow run, in a SEPARATE terminal:");
  console.log(`  ./cloudflared tunnel --url http://localhost:${PORT}`);
  console.log("and use the https://*.trycloudflare.com URL it prints as the Callback URL.\n");
  console.log("Leave this running. Waiting for events... (Ctrl+C to stop)\n");
});
