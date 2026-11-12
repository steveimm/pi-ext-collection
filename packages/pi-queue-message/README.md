# @steveimm/pi-queue-message

Send messages with Enter and use Tab to switch all unsent messages between steering and follow-up.

## Usage

| Key | Behavior |
| --- | --- |
| **Enter** | Submit the draft. While Pi is working, it joins the current queue mode. An empty queue defaults to steering. |
| **Tab**, with empty input | Switch all unsent user messages between steering and follow-up, keeping their order. |
| **Alt+Up** | Use Pi's native edit-all action to return unsent text to the input, preserving the current draft. |

New messages inherit the queue's mode until it empties.
Once the queued messages are delivered or restored to the input, the mode resets to steering.
Tab keeps normal autocomplete behavior while editing text or using an autocomplete menu.

Steering messages are delivered after the current assistant response's tool calls finish, before the next model request.
Follow-ups wait until the agent has no more tool calls or steering messages to process.
Toggling preserves message objects and image attachments, and leaves background notifications in their existing queues.
Messages already being delivered are not moved.

The hints appear inside Pi's pending-message block:

- **tab** follow-up all, when the queue is steering.
- **tab** steer all, when the queue is follow-up.
- **alt+up** edit all unsent messages.

The edit-all hint uses your configured Pi shortcut, with `alt` wording on every platform.
Pi defaults to Alt+Up on macOS/Linux and Alt+Q on Windows.
This extension keeps Pi's native edit-all behavior and does not register an `/unqueue` command.

## Development

From the repository root:

```bash
npm run check --workspace=packages/pi-queue-message
pi -e ./packages/pi-queue-message
```

The extension adapts Pi's internal queue methods and pending-message renderer because the extension API does not expose these operations.
It targets Pi 1.5.1 and disables its changes if the required structure is unsupported.
Verified in regular and fullscreen modes, including both load orders with `pi-background`.

## License

MIT
