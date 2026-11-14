# @steveimm/pi-background

Run shell commands, condition checks, and reminders in the background while continuing to chat with Pi.
Completion and watcher notifications start a follow-up turn so the agent can act on them.

## Install

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

## View and stop tasks

Active task counts appear between token usage and the model name in Pi's bottom status row:

```text
1 background process, 2 watchers
```

The indicator disappears when no tasks remain.
It uses Pi's standard editor and footer.

Open the task list with `/bg`, or press Down when it no longer moves the cursor or advances message history.
Down highlights the indicator, and Enter opens the same dialog.
Up or esc returns from the indicator to your draft.
History navigation, multiline input, and autocomplete keep their normal behavior.

In the task dialog:

| Key | Action |
| --- | --- |
| **Up / Down** | Select a task in the list, or scroll its details. |
| **Enter** | Open the selected task's details. |
| **Page Up / Page Down** | Scroll a page in the detail view. |
| **x** | Stop the selected process and its children, or delete the selected watcher. |
| **esc** | Return from details to the list. From the list, close the dialog. |

The list updates as tasks finish or are removed.
Details show the task's status, command or reminder instruction, working directory, recent output, and log path.
Watcher details also show the mode and interval.
An open detail view stays available when its task finishes or is removed.
Hints show the keys in bold, such as **x** kill selected task and **esc** close.

## Background a running Bash command

Press **Ctrl+B** while the agent's Bash command is running to move it to the background.
The eligible command shows **ctrl+b** send to background beside its elapsed time, or below it on narrow terminals.
For commands inside codemode, the hint appears beside the script's elapsed time.
With parallel commands, the hint follows the most recently started foreground command and disappears when none remain.
With tmux's default prefix, press Ctrl+B twice to send the key to Pi.
The shortcut selects the most recently started foreground Bash command.
The result tells the agent that the user moved the command to the background.

This also works for Bash calls made through codemode.
The call returns a background process ID and the command continues running.
If the script is waiting for other foreground commands, those calls still need to finish or be moved to the background.
An explicitly supplied timeout continues to apply.

The shortcut wraps Pi's local Bash tool.
Other extensions that replace `bash` may override it, depending on their load order.

## Agent tools

### `bg_process`

| Action | Required fields | Result |
| --- | --- | --- |
| `start` | `command` | Start a command and return its ID immediately. |
| `list` | None | Show running and finished background processes. |
| `read` | `id` | Return status and recent output. |
| `stop` | `id` | Stop the process and its children, cancelling any pending completion notification. |

For `start`, optional fields are `cwd`, `label`, `instruction`, and `timeout_seconds`.
The saved instruction tells the agent what to do when the command finishes.
Commands run without terminal input and have no time limit unless one is supplied.
The extension manages background execution, so commands do not need `&`.

For example, ask Pi:

> Download the file in the background. When it finishes, verify its checksum and tell me the result.

### `bg_watch`

`create` requires an explicit `mode` and the fields listed below.
`list` takes no other fields.
`delete` requires only the watcher's `id`.

| Mode | Required fields for creation | Behavior |
| --- | --- | --- |
| `until_success` | `command` | Check immediately, then repeat until the command exits with code 0. Notify once and remove the watcher. |
| `on_change` | `command` | Record the first result, then notify when output or exit code changes. Continue until deleted. |
| `interval` | `interval_seconds`, `instruction` | Send recurring reminders, starting after one interval. Continue until deleted. |

Shell checks accept optional `cwd`, `label`, `instruction`, `interval_seconds`, and `timeout_seconds`.
They default to 30 seconds between checks and a 10-second timeout per check.
The interval starts after each check finishes, so checks do not overlap.
Timeouts and commands that cannot run generate an error notification, with repeated identical errors suppressed.

Interval reminders accept an optional `label` and do not run a shell command.
They do not accept `command`, `cwd`, or `timeout_seconds`.
For example, a 15-minute reminder uses `interval_seconds=900` and an instruction describing what to do.

Example requests:

> Start the development server in the background. Check its health endpoint every five seconds, then begin browser testing once it is ready.

> Watch the download's progress file every 30 seconds and report changes. Delete the watcher when the download is complete.

> Remind me every 15 minutes to check the deployment. Stop reminding me once the deployment is finished.

A process already sends a completion notification.
Use `until_success` for a separate condition, such as server readiness while the server process continues running.

## Codemode

Both tools return structured values to codemode scripts.
Await the start or create call to obtain its ID, then let the script return:

```js
const results = await Promise.allSettled([
  tools.bg_process({
    action: "start",
    command: "npm test",
    instruction: "Inspect any failures when the tests finish."
  }),
  tools.bash({ command: "git status --short" })
]);
results.forEach(text);
```

Once the start call returns, the process continues independently of the script, including if the script later fails.
Commands that share files or ports still need to be ordered by the agent.
A Bash call moved to the background by the user returns `background: true`, `backgrounded_by: "user"`, `id`, and `exit_code: null`.
Scripts should check `background` before treating the result as a completed command.

## Notifications

Notifications are Pi custom messages with type `pi-background`.
They include the task ID, working directory, saved instruction, recent output, and log path.
Process and check notifications also include the command, exit code, and any error.
Delivery waits for a busy turn to finish, then starts a follow-up turn without another user message.
Watcher updates that arrive while the agent is busy are combined into the latest result for each watcher.

Watcher events include `mode` and `active`.
Their notifications tell the agent to delete active watchers whose goal or task is finished.
A successful `until_success` event has `active: false` because the watcher has already been removed.
Stopping a process or deleting a watcher cancels its pending notification.

## Session files and lifetime

Logs sit beside the session transcript, in a directory named after its JSONL file:

```text
~/.pi/agent/sessions/<encoded-project>/
  <timestamp>_<session-id>.jsonl
  <timestamp>_<session-id>.jsonl.bg/
    process-<id>.log
    watch-<id>.log
```

Each session has its own log directory, including when several sessions share a project.
A custom `--session-dir` also contains that session's logs.
With `--no-session`, logs use a temporary directory that is removed on shutdown.

Each log retains the first 10 MiB of output.
`bg_process` with `action="read"` returns the most recent 16 KiB from memory.
`log_truncated` indicates that the file omitted output beyond its limit, while `output_truncated` indicates that the returned output is only a tail.

Jobs and watchers survive `/reload` and `/cd` within the same conversation.
`/cd` moves the logs with the transcript, while running commands keep their original working directory.
Switching to another conversation, forking, or quitting stops the tasks.
Tasks do not resume after restarting Pi.

## Development

From the repository root:

```bash
npm run check
npm test --workspace=packages/pi-background
```

The default tests run local shell commands and use a local provider without model requests.
They cover process cancellation, watcher modes, codemode arguments and execution, notifications, session log storage, and task dialog navigation.

The terminal suite requires tmux and checks both regular and fullscreen modes:

```bash
npm run test:terminal --workspace=packages/pi-background
```

It covers Ctrl+B, the centered indicator, history and draft preservation, autocomplete, reload, task details, and the `x` and esc controls.

The optional GPT test uses your Pi authentication and makes model requests:

```bash
npm run test:live --workspace=packages/pi-background
```

It defaults to `openai-codex/gpt-6.1-sol`.
Set `PI_BACKGROUND_TEST_PROVIDER` and `PI_BACKGROUND_TEST_MODEL` to select another configured provider and model.

## License

MIT
