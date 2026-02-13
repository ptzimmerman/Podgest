#!/usr/bin/env node
/**
 * Podgest Auth CLI
 * 
 * One-time authentication setup for Podgest MCP.
 * Run this once to authenticate and configure your MCP client.
 * 
 * Usage: npx podgest-auth
 */

import { createServer } from "http";
import { URL } from "url";
import fs from "fs";
import path from "path";
import os from "os";
import open from "open";

const MCP_SERVER_URL = "https://mcp.podgest.app";
const CALLBACK_PORT = 9876;
const TOKEN_DIR = path.join(os.homedir(), ".podgest");
const API_KEY_FILE = path.join(TOKEN_DIR, "api_key");

// Ensure token directory exists
if (!fs.existsSync(TOKEN_DIR)) {
  fs.mkdirSync(TOKEN_DIR, { mode: 0o700 });
}

console.log(`
🎙️  Podgest Authentication
━━━━━━━━━━━━━━━━━━━━━━━━━━━

Opening browser for Google sign-in...
`);

// Start local server to receive the API key
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
  
  if (url.pathname === "/save") {
    const apiKey = url.searchParams.get("key");
    
    if (!apiKey) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h1>Error: No API key received</h1>");
      return;
    }
    
    // Save the API key
    fs.writeFileSync(API_KEY_FILE, apiKey, { mode: 0o600 });
    console.log(`✅ API key saved to ${API_KEY_FILE}`);
    
    // Find and update Cursor config
    const cursorConfigs = [
      path.join(process.cwd(), ".cursor", "mcp.json"),
      path.join(os.homedir(), ".cursor", "mcp.json"),
    ];
    
    let configUpdated = false;
    for (const configPath of cursorConfigs) {
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
          config.mcpServers = config.mcpServers || {};
          config.mcpServers.podgest = {
            url: `${MCP_SERVER_URL}/sse`,
            headers: {
              Authorization: `Bearer ${apiKey}`
            }
          };
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          console.log(`✅ Updated Cursor config: ${configPath}`);
          configUpdated = true;
          break;
        } catch (err) {
          console.error(`⚠️  Could not update ${configPath}: ${err.message}`);
        }
      }
    }
    
    if (!configUpdated) {
      // Create new config
      const newConfigPath = path.join(process.cwd(), ".cursor", "mcp.json");
      const configDir = path.dirname(newConfigPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      const config = {
        mcpServers: {
          podgest: {
            url: `${MCP_SERVER_URL}/sse`,
            headers: {
              Authorization: `Bearer ${apiKey}`
            }
          }
        }
      };
      fs.writeFileSync(newConfigPath, JSON.stringify(config, null, 2));
      console.log(`✅ Created Cursor config: ${newConfigPath}`);
    }
    
    // Redirect back to success page
    res.writeHead(302, { Location: `${MCP_SERVER_URL}/auth/callback?success=true` });
    res.end();
    
    // Close server and exit
    setTimeout(() => {
      server.close();
      console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Setup complete!

Reload Cursor to start using Podgest MCP.
`);
      process.exit(0);
    }, 500);
    
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(CALLBACK_PORT, () => {
  // Open browser to auth page
  const authUrl = `${MCP_SERVER_URL}/auth`;
  open(authUrl).catch(() => {
    console.log(`Please open this URL in your browser:\n${authUrl}`);
  });
});

// Timeout after 5 minutes
setTimeout(() => {
  console.error("\n❌ Authentication timed out. Please try again.");
  server.close();
  process.exit(1);
}, 5 * 60 * 1000);
