# Design Pilot

Design Pilot is an experimental, agentic Figma plugin that lets you chat with your canvas. It can inspect the current page, create and modify nodes through dedicated tools, and execute generated Figma Plugin API code after showing it to you for approval.

The project is currently distributed as source code for local development. It is not an official Figma product and is not currently published as a Figma Community plugin.

## Features

- Agent loop powered by the Vercel AI SDK
- Anthropic and OpenAI-compatible model providers
- Multiple saved API connections, each with its own provider, model, base URL, and API key
- Quick connection switching from the chat header
- Canvas inspection and restricted node-editing tools
- Approval dialog before generated plugin code runs
- Persistent connections, settings, and chat history through `figma.clientStorage`
- Multiple saved conversations with resume and delete controls
- Single-file Figma UI build powered by React and Vite

## Agent tools

| Tool | Purpose |
| --- | --- |
| `get_current_page_selection` | Read the nodes currently selected on the active page |
| `get_current_page_children` | Read the active page's top-level child nodes |
| `show_notification` | Display a notification in Figma |
| `create_rectangle` | Create a rectangle with optional position, size, name, and fill |
| `create_text` | Create an Inter Regular text node |
| `set_fill` | Set a node's solid fill color |
| `rename_node` | Rename a node |
| `execute_plugin_code` | Execute generated JavaScript with access to the Figma Plugin API after user approval |

## Requirements

- Figma desktop app
- Node.js `^20.19.0` or `>=22.12.0`
- An Anthropic API key or an API key for an OpenAI-compatible endpoint

## Local installation

1. Install dependencies:

   ```bash
   npm install
   ```

2. Build the plugin:

   ```bash
   npm run build
   ```

3. In the Figma desktop app, open **Plugins → Development → Import plugin from manifest**.

4. Select this repository's `manifest.json` file.

5. Run **Design Pilot** from Figma's development plugins menu.

The build produces `dist/code.js` and `dist/ui.html`, which are intentionally excluded from Git.

## Development

Run type checking:

```bash
npm run typecheck
```

Watch both the plugin sandbox and UI builds:

```bash
npm run watch
```

Create a production-style local build:

```bash
npm run build
```

## Project structure

```text
src/
├── plugin/   Figma plugin sandbox, tool registry, and serialization
├── shared/   Messages shared between the sandbox and UI
└── ui/       React interface, agent loop, providers, and persistence
```

The plugin has two execution environments:

- `src/plugin/main.ts` runs in the Figma plugin sandbox and has access to the `figma` global.
- `src/ui/main.tsx` runs in the plugin iframe and handles the interface and model requests.

Messages are passed between these environments with `postMessage`.

## Configuration and data handling

Design Pilot sends model requests directly from the plugin UI to the configured API endpoint. There is no project-owned proxy or backend.

- API keys are stored locally using `figma.clientStorage`, one key per saved connection and separate from other plugin data.
- Connections, chat history, and settings are also stored using `figma.clientStorage`.
- The active connection's API key and conversation content are sent to the provider endpoint selected in Settings.
- If you configure a third-party base URL, that service receives the API key and conversation content. Only use endpoints you trust.

Do not commit API keys or other credentials to this repository.

## Code execution safety

For simple edits, the agent is instructed to prefer restricted tools such as `create_rectangle`, `create_text`, `set_fill`, and `rename_node`. These tools execute directly.

For more complex operations, the agent can request `execute_plugin_code`. Design Pilot displays the generated JavaScript and waits for explicit approval before executing it.

Approved code runs with access to the Figma Plugin API and may modify the current document. Review it carefully and use Figma's undo or version history when appropriate. The execution timeout stops waiting for long-running asynchronous code, but it cannot interrupt JavaScript blocked in a synchronous infinite loop.

## Current status

Design Pilot is experimental software. APIs, stored data formats, tool names, and behavior may change without backward compatibility. Test it on non-critical files before using it in production design work.

## License

This project is licensed under the [MIT License](LICENSE).

