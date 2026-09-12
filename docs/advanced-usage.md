# Advanced usage

## Concurrent sessions

Most MCP clients start one Chrome DevTools MCP server per conversation. If your
client shares a single server instance across concurrent agents or subagents,
start the server with `--experimentalPageIdRouting`. This exposes `pageId` on
page-scoped tools so each agent can route tool calls to the tab it is working
with.

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--experimentalPageIdRouting"
      ]
    }
  }
}
```

If you run multiple independent MCP client sessions and want each session to
launch its own temporary Chrome profile, also pass `--isolated`. This avoids
sharing the default Chrome DevTools MCP user data directory between those
server instances.

## One server, many clients (HTTP mode)

By default the server speaks MCP over stdio: one client, one server process,
one browser. With `--http-port` a single server process instead serves MCP
over the streamable HTTP transport, and any number of MCP clients can connect
concurrently while sharing one browser:

```bash
npx chrome-devtools-mcp@latest --http-port 8000
```

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "type": "http",
      "url": "http://127.0.0.1:8000/mcp"
    }
  }
}
```

Each MCP client gets its own session (own selected page, console and network
history, and roots) identified by the `mcp-session-id` header, while all
sessions drive the same Chrome instance. Sessions survive client reconnects
until the client terminates them (HTTP `DELETE`), they are evicted as idle
(see below), or the server exits. All connect options work as usual: pass
`--browser-url`, `--ws-endpoint`, or `--auto-connect` to share a running
Chrome instance instead of launching one.

The server binds to `127.0.0.1` and validates `Host` headers against a
localhost allowlist (DNS rebinding protection). There is no authentication:
any local process can drive the shared browser, so only use HTTP mode on
machines where that is acceptable.

### Health endpoint

`GET /health` reports server status for scripts and process managers:

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok","version":"1.9.0","uptimeSeconds":42,"mcpSessions":2,"apiSessions":1,"browserConnected":true}
```

### REST tool calls

For plain HTTP callers (shell scripts, fetch/axios, or agent-native CLI
wrappers) the server also exposes tool calls as REST endpoints, with no MCP
handshake, session header, or SSE parsing:

```bash
# List tools and their input schemas
curl http://127.0.0.1:8000/api/tools

# Call a tool; the body is the tool's arguments as a JSON object
curl -X POST http://127.0.0.1:8000/api/tools/new_page \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com"}'

curl -X POST http://127.0.0.1:8000/api/tools/take_snapshot
```

REST calls run through a named server-side MCP session (`?session=<name>`,
default `default`) that keeps tool state between invocations, so consecutive
CLI or script calls behave like one continuous MCP session. Use different
session names to keep independent tool states over the same browser:

```bash
curl -X POST 'http://127.0.0.1:8000/api/tools/list_pages?session=agent-2'
```

Responses are MCP `CallToolResult` JSON: tool execution errors return HTTP
200 with `"isError": true`, unknown tools return 404, and invalid arguments
or session names return 400.

### Idle session eviction

Long-running servers can evict sessions whose clients disappeared without
terminating them:

```bash
npx chrome-devtools-mcp@latest --http-port 8000 --http-session-timeout 1800
```

A session (MCP or REST) idle for longer than the configured number of seconds
is closed. The shared browser stays up; an evicted MCP client re-initializes
on its next request, and an evicted REST session is recreated on demand.

## User data directory

By default, `chrome-devtools-mcp` starts a Chrome's stable channel instance using the following user
data directory:

- Linux / macOS: `$HOME/.cache/chrome-devtools-mcp/chrome-profile`
- Windows: `%USERPROFILE%\.cache\chrome-devtools-mcp\chrome-profile`

For non-stable channels, the channel name is appended to the directory name, for example
`chrome-profile-canary`.

The user data directory is not cleared between runs and is reused for subsequent
runs with the same channel. Only one browser can use it at a time. Set the `isolated`
option to `true` to use a temporary user data directory instead which will be cleared
automatically after the browser is closed.

## Connecting to a running Chrome instance

By default, the Chrome DevTools MCP server will start a new Chrome instance with a dedicated profile. This might not be ideal in all situations:

- If you would like to maintain the same application state when alternating between manual site testing and agent-driven testing.
- When the MCP needs to sign into a website. Some accounts may prevent sign-in when the browser is controlled via WebDriver (the default launch mechanism for the Chrome DevTools MCP server).
- If you're running your LLM inside a sandboxed environment, but you would like to connect to a Chrome instance that runs outside the sandbox.

In these cases, start Chrome first and let the Chrome DevTools MCP server connect to it. There are two ways to do so:

- **Automatic connection (available in Chrome 144)**: best for sharing state between manual and agent-driven testing.
- **Manual connection via remote debugging port**: best when running inside a sandboxed environment.

### Automatically connecting to a running Chrome instance

**Step 1:** Set up remote debugging in Chrome

In Chrome (\>= M144), do the following to set up remote debugging:

1.  Navigate to `chrome://inspect/#remote-debugging` to enable remote debugging.
2.  Follow the dialog UI to allow or disallow incoming debugging connections.

**Step 2:** Configure Chrome DevTools MCP server to automatically connect to a running Chrome Instance

To connect the `chrome-devtools-mcp` server to the running Chrome instance, use
`--autoConnect` command line argument for the MCP server.

The following code snippet is an example configuration for gemini-cli:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest", "--autoConnect"]
    }
  }
}
```

**Step 3:** Test your setup

Make sure your browser is running. Open gemini-cli and run the following prompt:

```none
Check the performance of https://developers.chrome.com
```

> [!NOTE]
> The <code>autoConnect</code> option requires the user to start Chrome. If the user has multiple active profiles, the MCP server will connect to the default profile (as determined by Chrome). The MCP server has access to all open windows for the selected profile.

The Chrome DevTools MCP server will try to connect to your running Chrome
instance. It shows a dialog asking for user permission.

Clicking **Allow** results in the Chrome DevTools MCP server opening
[developers.chrome.com](http://developers.chrome.com) and taking a performance
trace.

### Manual connection using port forwarding

You can connect to a running Chrome instance by using the `--browser-url` option. This is useful if you are running the MCP server in a sandboxed environment that does not allow starting a new Chrome instance.

Here is a step-by-step guide on how to connect to a running Chrome instance:

**Step 1: Configure the MCP client**

Add the `--browser-url` option to your MCP client configuration. The value of this option should be the URL of the running Chrome instance. `http://127.0.0.1:9222` is a common default.

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "chrome-devtools-mcp@latest",
        "--browser-url=http://127.0.0.1:9222"
      ]
    }
  }
}
```

**Step 2: Start the Chrome browser**

> [!WARNING]
> Enabling the remote debugging port opens up a debugging port on the running browser instance. Any application on your machine can connect to this port and control the browser. Make sure that you are not browsing any sensitive websites while the debugging port is open.

Start the Chrome browser with the remote debugging port enabled. Make sure to close any running Chrome instances before starting a new one with the debugging port enabled. The port number you choose must be the same as the one you specified in the `--browser-url` option in your MCP client configuration.

For security reasons, [Chrome requires you to use a non-default user data directory](https://developer.chrome.com/blog/remote-debugging-port) when enabling the remote debugging port. You can specify a custom directory using the `--user-data-dir` flag. This ensures that your regular browsing profile and data are not exposed to the debugging session.

**macOS**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile-stable
```

**Linux**

```bash
/usr/bin/google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile-stable
```

**Windows**

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\chrome-profile-stable"
```

**Step 3: Test your setup**

After configuring the MCP client and starting the Chrome browser, you can test your setup by running a simple prompt in your MCP client:

```
Check the performance of https://developers.chrome.com
```

Your MCP client should connect to the running Chrome instance and receive a performance report.

If you hit VM-to-host port forwarding issues, see the “Remote debugging between virtual machine (VM) and host fails” section in [`troubleshooting.md`](./troubleshooting.md#remote-debugging-between-virtual-machine-vm-and-host-fails).

For more details on remote debugging, see the [Chrome DevTools documentation](https://developer.chrome.com/docs/devtools/remote-debugging/).

## Debugging Chrome on Android

Please consult [these instructions](./debugging-android.md).
