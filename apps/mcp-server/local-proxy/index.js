#!/usr/bin/env node
/**
 * Podgest MCP Local Proxy
 * 
 * This proxy runs locally and forwards MCP requests to the remote Cloudflare Worker.
 * It handles OAuth authentication with Supabase/Google.
 * 
 * Token is stored in ~/.podgest/token
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "http";
import { URL } from "url";
import fs from "fs";
import path from "path";
import os from "os";
import open from "open";

// Configuration
const REMOTE_URL = process.env.PODGEST_MCP_URL || "https://podgest-mcp.pztest.workers.dev/mcp";
const SUPABASE_URL = "https://xpviiukiavtpsnafpdmy.supabase.co";
const CALLBACK_PORT = 9876;
const TOKEN_DIR = path.join(os.homedir(), ".podgest");
const TOKEN_FILE = path.join(TOKEN_DIR, "token");
const REFRESH_TOKEN_FILE = path.join(TOKEN_DIR, "refresh_token");

// Ensure token directory exists
if (!fs.existsSync(TOKEN_DIR)) {
  fs.mkdirSync(TOKEN_DIR, { mode: 0o700 });
}

// Token management
let currentToken = null;
let refreshToken = null;
let authInProgress = null; // Promise to prevent concurrent OAuth flows

function loadSavedToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      currentToken = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      console.error("[Auth] Loaded saved access token");
    }
    if (fs.existsSync(REFRESH_TOKEN_FILE)) {
      refreshToken = fs.readFileSync(REFRESH_TOKEN_FILE, "utf8").trim();
      console.error("[Auth] Loaded saved refresh token");
    }
  } catch (err) {
    console.error("[Auth] Error loading saved token:", err.message);
  }
}

function saveToken(accessToken, newRefreshToken) {
  try {
    fs.writeFileSync(TOKEN_FILE, accessToken, { mode: 0o600 });
    currentToken = accessToken;
    if (newRefreshToken) {
      fs.writeFileSync(REFRESH_TOKEN_FILE, newRefreshToken, { mode: 0o600 });
      refreshToken = newRefreshToken;
    }
    console.error("[Auth] Token saved to ~/.podgest/");
  } catch (err) {
    console.error("[Auth] Error saving token:", err.message);
  }
}

// Try to refresh the token using refresh_token
async function tryRefreshToken() {
  if (!refreshToken) return false;
  
  console.error("[Auth] Attempting to refresh token...");
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFhYmFzZSIsInJlZiI6InhwdmlpdWtpYXZ0cHNuYWZwZG15Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1MDU4NzAsImV4cCI6MjA4NDA4MTg3MH0.ZabAkmSAA6mzPGdnEfA30n6gNK-XqlHJoM2n1m9uyHs"
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    
    if (response.ok) {
      const data = await response.json();
      saveToken(data.access_token, data.refresh_token);
      console.error("[Auth] Token refreshed successfully");
      return true;
    }
  } catch (err) {
    console.error("[Auth] Refresh failed:", err.message);
  }
  return false;
}

// Validate token with Supabase
async function validateToken(token) {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 
        "Authorization": `Bearer ${token}`,
        "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFhYmFzZSIsInJlZiI6InhwdmlpdWtpYXZ0cHNuYWZwZG15Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1MDU4NzAsImV4cCI6MjA4NDA4MTg3MH0.ZabAkmSAA6mzPGdnEfA30n6gNK-XqlHJoM2n1m9uyHs"
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Start OAuth flow - opens browser and waits for callback
function startOAuthFlow() {
  return new Promise((resolve, reject) => {
    console.error("[Auth] Starting OAuth flow...");
    
    let resolved = false; // Prevent multiple resolutions
    
    // Create callback server
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      
      if (url.pathname === "/callback") {
        // Serve HTML that extracts token from URL fragment
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Podgest Authentication</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #eee;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
    }
    h1 { color: #4ade80; margin-bottom: 16px; }
    p { color: #aaa; }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #333;
      border-top-color: #4ade80;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 20px auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .success { display: none; }
    .success h1 { color: #4ade80; }
  </style>
</head>
<body>
  <div class="container loading">
    <div class="spinner"></div>
    <h1>Authenticating...</h1>
    <p>Please wait while we complete the sign-in process.</p>
  </div>
  <div class="container success" style="display:none;">
    <h1>✓ Authenticated!</h1>
    <p>You can close this window and return to Claude.</p>
  </div>
  <script>
    // Extract token from URL fragment
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    
    if (accessToken) {
      // Send token to our callback endpoint
      fetch('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken })
      }).then(() => {
        document.querySelector('.loading').style.display = 'none';
        document.querySelector('.success').style.display = 'block';
        setTimeout(() => window.close(), 2000);
      });
    } else {
      document.querySelector('.loading').innerHTML = '<h1 style="color:#ef4444;">Authentication Failed</h1><p>No access token received. Please try again.</p>';
    }
  </script>
</body>
</html>
        `);
      } else if (url.pathname === "/token" && req.method === "POST") {
        // Receive token from browser (only process once)
        if (resolved) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, duplicate: true }));
          return;
        }
        
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          if (resolved) return; // Double-check after body received
          
          try {
            const { access_token, refresh_token } = JSON.parse(body);
            resolved = true; // Mark as resolved immediately
            
            saveToken(access_token, refresh_token);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
            
            // Close server and resolve immediately
            server.close();
            resolve(access_token);
          } catch (err) {
            res.writeHead(400);
            res.end("Invalid request");
          }
        });
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    
    server.listen(CALLBACK_PORT, () => {
      console.error(`[Auth] Callback server listening on port ${CALLBACK_PORT}`);
      
      // Build OAuth URL
      const redirectUri = `http://localhost:${CALLBACK_PORT}/callback`;
      const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUri)}`;
      
      console.error("[Auth] Opening browser for authentication...");
      open(authUrl).catch(err => {
        console.error("[Auth] Failed to open browser:", err.message);
        console.error(`[Auth] Please manually open: ${authUrl}`);
      });
    });
    
    // Timeout after 5 minutes
    setTimeout(() => {
      if (!resolved) {
        server.close();
        reject(new Error("OAuth timeout - no callback received within 5 minutes"));
      }
    }, 5 * 60 * 1000);
  });
}

// Ensure we have a valid token (with lock to prevent concurrent OAuth flows)
async function ensureAuthenticated() {
  // If OAuth is already in progress, wait for it
  if (authInProgress) {
    console.error("[Auth] OAuth already in progress, waiting...");
    return await authInProgress;
  }
  
  // Try existing token
  if (currentToken && await validateToken(currentToken)) {
    return currentToken;
  }
  
  // Try refresh
  if (await tryRefreshToken()) {
    return currentToken;
  }
  
  // Need fresh OAuth - acquire lock
  console.error("[Auth] No valid token found, starting OAuth flow...");
  authInProgress = startOAuthFlow();
  
  try {
    const token = await authInProgress;
    return token;
  } finally {
    authInProgress = null; // Release lock
  }
}

// Forward a request to the remote server
async function forwardRequest(method, params) {
  const token = await ensureAuthenticated();
  
  const response = await fetch(REMOTE_URL, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });

  if (response.status === 401) {
    // Token expired, try refresh and retry
    console.error("[Auth] Token rejected, attempting refresh...");
    if (await tryRefreshToken()) {
      return forwardRequest(method, params);
    }
    // Refresh failed, need full re-auth
    currentToken = null;
    const newToken = await startOAuthFlow();
    return forwardRequest(method, params);
  }

  if (!response.ok) {
    throw new Error(`Remote server error: ${response.status}`);
  }

  const data = await response.json();
  
  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.result;
}

// Create MCP server
const server = new Server(
  {
    name: "podgest-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tools/list
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await forwardRequest("tools/list", {});
  return result;
});

// Handle tools/call
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await forwardRequest("tools/call", request.params);
  return result;
});

// Start the server
async function main() {
  // Load any saved token
  loadSavedToken();
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Podgest] MCP proxy ready");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
