# @steveimm/pi-background

Run commands and polling checks in the background while continuing to chat with Pi.
When a command finishes or a watcher reports a result, the extension starts a follow-up turn so the agent can act on it.

## Install

After publication:

```bash
pi install npm:@steveimm/pi-background
```

For local development, run from the repository root:

```bash
npm ci
pi -e ./packages/pi-background
```

Use Pi 1.5.1 or newer.
Install globally or use `-e` so the extension stays loaded when you change directories.

## Background processes

The agent uses `background_process` with these actions:

| Action | Purpose |
| --- | --- |
| `start` | Start a command and return its ID immediately. |
| `list` | Show running and finished processes. |
| `read` | Read a process's status and recent output. |
| `stop` | Stop a process and its children. |

For example, ask Pi:

> Download the file in the background. When it finishes, verify its checksum and tell me the result.

The agent supplies a `command` and can include `cwd`, `label`, `instruction`, and `timeout_seconds`.
The instruction is included in the completion notification so the agent knows what to do next.
Commands run without terminal input and have no time limit unless one is supplied.
Do not add `&` to the command: the extension manages the background process.

## Background a running Bash command

Press **Ctrl+B** while the agent's Bash command is running to move it to the background.
With tmux's default prefix, press Ctrl+B twice to send the key to Pi.
The shortcut selects the most recently started foreground Bash command.
When no command is running, Pi handles the key normally.

This also works for Bash calls made through codemode.
The call returns a background process ID and the command continues running.
If the script is also waiting for other foreground commands, those calls still need to finish or be moved to the background.
An explicitly supplied timeout continues to apply after the command is moved.

The shortcut wraps Pi's local Bash tool.
Other extensions that also replace `bash` may override this behavior, depending on their load order.

## Watchers

The agent uses `background_watch` to create, list, or delete polling checks.
Each watcher runs a shell command in its original working directory.

| Mode | Behavior |
| --- | --- |
| `until_success` | Notify when the check exits with code 0, then remove the watcher. Other exit codes keep it waiting. |
| `on_change` | Record the first result, then notify when output or exit code changes. Continue until deleted. |

Examples:

> Check every 30 seconds whether the download is complete. When it is, inspect the archive.

> Watch the server log for changes every 10 seconds and report new errors. Delete the watcher when we are done.

The default mode is `until_success`, with 30 seconds between checks and a 10-second timeout for each check.
The agent can set `interval_seconds`, `timeout_seconds`, and a follow-up `instruction`.
Checks never overlap: the interval starts after the previous check finishes.
Timeouts and commands that cannot run generate an error notification, with repeated identical errors suppressed.
Ordinary polling does not call the model.

## Codemode

Both tools return structured values to codemode scripts.
Await each start call to obtain its ID, then let the script return:

```js
const results = await Promise.allSettled([
  tools.background_process({
    action: "start",
    command: "npm test",
    instruction: "Inspect any failures when the tests finish."
  }),
  tools.bash({ command: "git status --short" })
]);
results.forEach(text);
```

Once the start call returns, Pi owns the process independently of the codemode script.
The process continues if that script later returns or fails.
Its notification goes to the Pi conversation after the current turn finishes.
Commands that share files or ports still need to be ordered by the agent.
If the user backgrounds a Bash call, that call returns `background: true`, `id`, and `exit_code: null`.
Scripts should check `background` before treating the result as a completed command.
See [Pi's codemode documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md).

## Notifications and lifetime

Completion and failure notifications include the task ID, command, working directory, exit code, recent output, log path, and saved instruction.
If the agent is busy, delivery waits until its turn finishes.
If the agent is idle, delivery starts a new turn without another user message.
Watcher updates that arrive while the agent is busy are combined into the latest result for each watcher.
Stopping a process or deleting a watcher cancels its pending notification.

Jobs and watchers survive `/reload` and `/cd` within the same conversation.
Their commands keep the working directory selected when they were created.
Starting or switching to a different conversation, forking, or quitting Pi stops them.
They do not resume after restarting Pi.
Keep Pi running in interactive or RPC mode to receive notifications.

Logs are saved under `~/.pi/agent/background/`, or under the configured Pi agent directory.
Each log keeps up to 10 MiB, and the read tool also retains the most recent 16 KiB of output in memory.
The status reports when a log has been truncated.

The extension uses [Pi's shell execution and message APIs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Development

From the repository root:

```bash
npm run check
npm test --workspace=packages/pi-background
```

The default tests use a local test provider and do not make model requests.
The optional terminal test requires tmux:

```bash
npm run test:terminal --workspace=packages/pi-background
```

The optional GPT test uses the current Pi authentication and makes model requests:

```bash
npm run test:live --workspace=packages/pi-background
```

It defaults to `openai-codex/gpt-6.1-sol`.
Set `PI_BACKGROUND_TEST_PROVIDER` and `PI_BACKGROUND_TEST_MODEL` to select another configured GPT provider and model.

## License

MIT
