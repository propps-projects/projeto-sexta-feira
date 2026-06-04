// Anchor cwd + .env to the project root before any module loads. Claude Desktop
// often ignores the `cwd` field in its MCP config and spawns the server from $HOME.
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import dotenv from "dotenv";
const __projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(__projectRoot);
dotenv.config({ path: resolvePath(__projectRoot, ".env") });

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./build-server.ts";

const server = buildServer();
await server.connect(new StdioServerTransport());
