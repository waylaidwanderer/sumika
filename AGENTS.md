# Onboarding Guide for Gemini CLI Integration

## Current Status (As of 2025-09-05)

This project is a headless API server that wraps the Gemini CLI to provide stateful, multi-session chat. It's important to remember that **Sumika is a wrapper, not the agent itself.** The underlying ACP agent (the Gemini CLI) is what advertises and possesses capabilities like `embeddedContext`. Sumika's role is to manage the agent processes and correctly proxy API requests to them according to the ACP specification.

Key features include:
- Persistent sessions saved to the filesystem.
- Lazy-loading of Gemini agent processes.
- API endpoints for session CRUD, export, and interactive agent communication via SSE.

## Key Findings & Protocol Details

### 1. Launching the Gemini CLI in ACP Mode

The Gemini CLI must be launched with a specific experimental flag to enable the JSON-RPC-based Agent Client Protocol. The most reliable method is to run the script from the locally installed NPM package.

- **Command**: `node ./node_modules/@google/gemini-cli/dist/index.js --experimental-acp`

### 2. Environment Variables

The CLI requires environment variables for authentication and model selection. These should be loaded from a `.env` file.

- `GEMINI_API_KEY`: The API key for authenticating with the Gemini API.
- `GEMINI_MODEL`: The specific Gemini model to be used (e.g., `gemini-2.5-pro`).

### 3. Communication Protocol: Newline-Delimited JSON-RPC

This is a critical and non-obvious finding. The communication between our application and the Gemini CLI process does **not** use the `Content-Length` header-based framing.

Instead, it uses a simpler **newline-delimited JSON-RPC** protocol. Each JSON-RPC message sent to the CLI's `stdin` must be a single line terminated by a newline character (`\n` or `EOL`). The CLI's responses on `stdout` will also be newline-delimited.

### 4. Handshake and Authentication

A specific handshake process must be followed to establish a connection.

1.  **Initialize**: Send an `initialize` request.
2.  **Authentication Check**: The response to `initialize` may be an error with code `-32000`, indicating that authentication is required.
3.  **Authenticate**: If authentication is required, send an `authenticate` request with the `methodId` set to `api_key`.
4.  **Re-initialize**: After a successful authentication, the Gemini CLI requires the client to send the `initialize` request *again*. The connection is only ready after the second `initialize` call succeeds.

### 5. Parameter Naming Convention: `camelCase`

All parameters in the JSON-RPC messages must be in `camelCase`. This is a crucial detail, as using `snake_case` (as seen in the Zed Rust source) will result in "Invalid params" errors.

### 6. Authoritative Source of Truth

The definitive source for the ACP schema, method names, and parameter structures is the Gemini CLI's own source code, which can be found within this project's `node_modules`.

- **Primary Files**:
    - `node_modules/@google/gemini-cli/dist/zed-integration/acp.js`: Defines the agent-side connection logic and method handling.
    - `node_modules/@google/gemini-cli/dist/zed-integration/schema.js`: Contains the schemas for all ACP messages, defining the exact structure and casing of requests and responses.

Any future work on this integration should refer directly to these files to avoid ambiguity.


