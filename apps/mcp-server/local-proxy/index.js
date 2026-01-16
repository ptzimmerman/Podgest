#!/usr/bin/env node
/**
 * Podgest MCP Local Proxy
 * 
 * This proxy runs locally and forwards MCP requests to the remote Cloudflare Worker.
 * Claude Desktop connects to this local process via stdio.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const REMOTE_URL = process.env.PODGEST_MCP_URL || "https://podgest-mcp.pztest.workers.dev/mcp";
const USER_ID = process.env.PODGEST_USER_ID || "18f513bd-8ecf-4922-84b7-4ab7c7cc14df";

// Forward a request to the remote server
async function forwardRequest(method, params) {
  const response = await fetch(`${REMOTE_URL}?user_id=${USER_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });

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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Podgest MCP proxy connected to remote server");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
