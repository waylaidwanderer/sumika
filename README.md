<p align="center">
  <img src="./public/sumika-hero.svg" alt="Sumika Hero Image" width="800" />
</p>

# Sumika

Sumika (住処), from the Japanese word for "dwelling," is a stateful API server that acts as a bridge for agents compatible with the Agent Client Protocol (ACP), such as the Gemini CLI. It provides a persistent, multi-session chat interface with support for tool calls and streaming events.

## Core Concepts

Sumika is built around two primary concepts:

-   **Workspaces**: A Workspace is the primary data model for isolating an agent's context. It maps a unique ID to a directory on the filesystem, either managed by Sumika (`~/.sumika/workspaces/<workspace-id>`) or a custom user-provided path. A Workspace is a persistent entity that holds configuration (like environment variables and MCP servers) and contains multiple Sessions.
-   **Sessions**: A Session represents a single, stateful conversation with an agent. It's a persistent JSON object containing the full message history, including user prompts, agent responses, and tool calls. Each Session is mapped to a live, underlying ACP process. If the agent process terminates, the Session becomes `disconnected` but retains its history, allowing it to be re-initialized into a new process without data loss.

## Getting Started

### Prerequisites

- Node.js
- pnpm

### Installation

1.  Clone the repository.
2.  Navigate to the `server` directory:
    ```bash
    cd server
    ```
3.  Install dependencies:
    ```bash
    pnpm install
    ```
4.  Create a `.env` file from the example:
    ```bash
    cp .env.example .env
    ```
5.  Add your `GEMINI_API_KEY` to the `.env` file.

### Configuration

You can configure the server using the following environment variables in your `.env` file:

-   `GEMINI_API_KEY` (Required): Your API key for the Gemini service.
-   `GEMINI_MODEL` (Optional): The specific Gemini model to use (e.g., `gemini-2.5-pro`). Defaults to the Gemini CLI's default model if not set.
-   `SUMIKA_ROOT_DIR` (Optional): By default, Sumika stores all workspaces and session data in `~/.sumika`. You can specify a different root directory by setting this variable to an absolute path.

### Custom Agent and Environment Variables

For advanced use cases, you can configure Sumika to launch a custom ACP-compliant agent or to inject global environment variables into the agent's process. This is managed via the `~/.sumika/settings.json` file.

-   `customAcpCommand` (string): A shell command used to launch your custom agent. If this is blank or omitted, Sumika defaults to using the built-in `@google/gemini-cli`.
-   `env` (object): A key-value map of environment variables to set in the agent's process. These will override any system-level variables with the same name.

**Example `settings.json`:**
```json
{
  "customAcpCommand": "/path/to/my-custom-agent --acp --verbose",
  "env": {
    "CUSTOM_AGENT_API_KEY": "your-secret-api-key"
  },
  "mcpServers": {}
}
```

**Note:** The Sumika server must be restarted for any changes to `settings.json` to take effect.

### Running the Server

To start the development server, run:

```bash
pnpm dev
```

The API will be available at `http://localhost:8787`. Interactive OpenAPI documentation is available at `http://localhost:8787/docs`.

## Global MCP Servers

Sumika supports global MCP servers configured at `~/.sumika/settings.json` in addition to per-workspace servers. When creating or reinitializing a session, Sumika merges the two sets and sends the merged list to the ACP agent. If both define the same server name, the workspace definition takes precedence.

Example `~/.sumika/settings.json`:

```
{
  "mcpServers": {
    "serverName": {
      "command": "npx",
      "args": ["serverName"],
      "env": { "ENV_VAR": "1" }
    }
  }
}
```

### API

- `GET /api/settings` → Returns the global settings.
- `PUT /api/settings` → Replaces the global settings (full-replace semantics). Payload shape matches the example above.

Notes:
- Settings are validated and written atomically. If a corrupt file is detected, the original is backed up to `settings.json.bak` and reset.
- Changes take effect for new or reinitialized sessions.