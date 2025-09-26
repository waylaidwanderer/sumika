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

### **Lint and Build Error Resolution Protocol**

**Prime Directive:** Your memory of a file's state is unreliable and must not be trusted. Base every action on fresh data obtained directly from the file system in the present moment.

1.  **Triage the Target File:**
    *   **a.** Run `pnpm lint:fix` to get the initial, authoritative list of all files with errors. To get the errors for a *single* target file, use `pnpm eslint <file_path>`; do not target single files with `pnpm lint` or `pnpm lint:fix`.
    *   **b.** Immediately generate your **verified snapshot** by using an `awk` one-liner to print the exact line number and content of every reported error: `awk 'NR==<LINE_1> || NR==<LINE_2> {print NR " : " $0}' <FILE_PATH>`. This step is **mandatory** and ensures you are not acting on stale information.

2.  **Strategize Based on Verified Facts:**
    *   **a. Guiding Principle: Think, Don't Just Follow.** The linter is a tool, not the boss. It's good at spotting problems, but its suggestions are just that—suggestions. Your job is to find the *root cause* and the *best fix*, not just the fastest way to make the error go away. For example, if the linter flags an unused variable (`no-unused-vars`) and suggests renaming it with an underscore (e.g., `_error`), stop and think. Is that variable *truly* needed? If it's an ignored error in a `catch` block or the last argument in a function, the cleaner solution is often to remove it entirely. That's a real fix, not just silencing a warning. Always prioritize the fix that improves code clarity and structure.
    *   **b. Analyze the Verified Snapshot:** Base your strategy *only* on the output from the `awk` command, not your memory of the file.
    *   **c. Identify and Resolve the Root Cause:**
        *   **For standard errors:** Determine the precise resolution (Reformat, Refactor for Type Safety, Disable with justification).
        *   **CRITICAL: Watch for Cyclical Errors.** A cyclical error occurs when fixing one linting issue immediately causes a new, conflicting one. This is a strong signal that the underlying code structure is flawed. **Do not get stuck in a loop of swapping fixes.**
            *   **Example from this project:** The linter reported a `no-unused-vars` warning for a variable named `text`, suggesting it be renamed to `_text`. After renaming, the linter then reported a `naming-convention` error for `_text`.
            *   **Recognition:** The act of fixing one error directly created another.
            *   **The Fix:** The root cause was using destructuring (`const { text: _text, ...rest } = object`) solely to omit a property. The correct solution is to **refactor the code to avoid the conflict entirely.** Instead of destructuring, use a copy-and-delete pattern: `const rest = { ...object }; delete rest.text;`. This achieves the same goal with cleaner code that doesn't trigger either lint rule. Similarly, if an unused function argument is the *last* argument, or an error in a `catch` block is intentionally ignored, it can and should be deleted entirely, not renamed.
    *   **d. Handling Tool Conflicts:** When the linter (`eslint`) and the TypeScript compiler (`tsc`) disagree, the compiler is the final authority.
        *   **Build Over Linter:** A lint suggestion that breaks the build is invalid. The code **must** compile successfully.
        *   **Find a Compliant Solution:** Your primary goal is to find a refactoring that satisfies *both* tools.
        *   **Configuration as a Last Resort:** If a lint rule is fundamentally incompatible with the project's type requirements, propose a targeted change to the `eslint.config.mjs` file with a clear justification. Do not disable rules casually.

3.  **Execute with Precision:**
    *   **a.** Run `read_file` on the target file. This is a mandatory final check to ensure the context for your `replace` calls is perfectly current.
    *   **b.** Execute your strategy using **strictly atomic, sequential `replace` calls.**
        *   **One Logical Change Per Call:** Do not bundle reformatting with refactoring.
        *   **Provide Ample Context:** Ensure your `old_string` is unique.
    *   **c. Re-Read After Every Mutation:** After each successful `replace` call, you **must** re-run `read_file` before constructing the next `replace` call.

4.  **Verify and Iterate:**
    *   **a. Lint Check:** Run `pnpm eslint <FILE_PATH>` on the target file to confirm all lint errors are resolved.
    *   **b. Build Check:** Run `pnpm build` to ensure the changes are type-safe and the project compiles successfully.
    *   **c.** If the file is clean and the build passes, the protocol is complete for this file.
    *   **d.** If either the linter or the build fails, the process is incomplete. You must restart the entire protocol from Step 1 for this file.

### **TypeScript `any` Type Protocol**

**Prime Directive:** The `any` type is forbidden. It undermines the primary benefit of TypeScript—static type safety. All agents must adhere to the following alternatives.

#### 1. **For Known Shapes: `interface` or `type`**
-   **Rule:** If an object's structure is known or can be determined, define a specific `interface` or `type` for it.
-   **Rationale:** This is the most robust method. It provides full type-checking, autocompletion, and serves as clear documentation for the data structure.

#### 2. **For Variable, but Constrained Types: Generics (`<T>`)**
-   **Rule:** When creating functions, classes, or types that are designed to work with a variety of data types while maintaining the relationship between them, use generics.
-   **Rationale:** Generics preserve type information from input to output, preventing type loss and ensuring safety without restricting the function to a single type.

#### 3. **For Truly Unknown Values: `unknown`**
-   **Rule:** For values where the type is genuinely unknown at compile time (e.g., API responses, dynamic content), use the `unknown` type.
-   **Rationale:** `unknown` is the type-safe counterpart to `any`. It forces the agent to perform explicit type-checking (e.g., using `typeof`, `instanceof`, or type guards) before the value can be used, preventing runtime errors.

#### 4. **For Testing Private Members: Bracket Notation**
-   **Rule:** In a testing context, if it is necessary to access a `private` or `protected` class member, use bracket notation (e.g., `instance['privateMethod']()`).
-   **Rationale:** This is a targeted and widely accepted practice for unit testing. It avoids the need to cast the entire instance to `any`, which would compromise type safety for all other interactions with the instance within the test. This should be used *only* in test files.