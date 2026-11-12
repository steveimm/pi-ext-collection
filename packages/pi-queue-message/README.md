# @steveimm/pi-queue-message

Send messages with Enter and use Tab to switch all unsent messages between steering and follow-up.

## Install

```bash
pi install npm:@steveimm/pi-queue-message
```

## Usage

| Key | Behavior |
| --- | --- |
| **Enter** | Submit the draft. While Pi is working, it joins the current queue mode. An empty queue defaults to steering. |
| **Tab**, with empty input | Switch all unsent user messages between steering and follow-up, keeping their order. |
| **Alt+Up** | Use Pi's native edit-all action to return unsent text to the input, preserving the current draft. |
| **esc** | Stop the current run and restore unsent steering and follow-up text to the input. |

New messages inherit the queue's mode until it empties.
Once the queued messages are delivered or restored to the input, the mode resets to steering.
Tab keeps normal autocomplete behavior while editing text or using an autocomplete menu.
When autocomplete is open, the first esc closes it.
Restored messages are not submitted automatically.

Steering messages are delivered after the current assistant response's tool calls finish, before the next model request.
Follow-ups wait until the agent has no more tool calls or steering messages to process.
Toggling preserves message objects and image attachments, and leaves background notifications in their existing queues.
Messages already being delivered are not moved.

The extension shows a separate hint above the input/working row:

**tab** toggle steering or follow up

The hint appears when there are unsent messages and the empty editor can accept the toggle.
Pi's own pending-message text and edit-all hint remain unchanged.
Pi defaults to Alt+Up on macOS/Linux and Alt+Q on Windows.
This extension keeps Pi's native edit-all behavior and does not register an `/unqueue` command.

## Development

From the repository root:

```bash
npm run check --workspace=packages/pi-queue-message
npm test --workspace=packages/pi-queue-message
pi -e ./packages/pi-queue-message
```

The default tests use Pi's session and queue implementations without model requests.
They cover queue-wide toggling, inherited delivery mode, ordering, attachments, notifications, mode reset, and compatibility checks.

The terminal tests require tmux:

```bash
npm run test:terminal --workspace=packages/pi-queue-message
```

They use a local test provider in regular and fullscreen modes, including both load orders with `pi-background`.
They check the hint's wording, bold key, placement, normal autocomplete, native edit-all, and Escape restoring messages without sending them.

The extension adapts Pi's internal queue methods and observes its pending-message updates because the extension API does not expose these operations.
It targets Pi 1.5.1 and disables its changes if the required structure is unsupported.

## License

MIT
