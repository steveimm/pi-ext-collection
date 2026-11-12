# @steveimm/pi-queue-message

Move the newest pending message to Pi's follow-up queue with **Tab**.
It waits until the agent finishes its current work and final response.

## Usage

1. Send a message while Pi is working. Pi lists it as a steering message.
2. With the editor empty, press **Tab** to queue that message after the current response.
3. If several messages are pending, each press moves the newest remaining one.

The message appears in Pi's existing follow-up list.
Tab keeps its usual behavior when there is no pending message, while editing a draft, or in an autocomplete menu.
Pi's existing follow-up shortcut also continues to work.

Steering messages are delivered after the current assistant response's tool calls finish, before the next model request.
Follow-ups wait until there are no more tool calls or steering messages to process.

## Development

From the repository root:

```bash
npm run check --workspace=packages/pi-queue-message
pi -e ./packages/pi-queue-message
```

This extension uses a small adapter for Pi's internal queues because the extension API has no operation for moving an already-pending message.
It preserves the original message object, including image attachments.
The adapter targets Pi 1.5.1 and reports an error if the queue structure is unsupported.
Verified in regular and fullscreen modes, including both load orders with `pi-background`.

## License

MIT
