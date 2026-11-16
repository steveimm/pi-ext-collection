# pi-better-ui

Sticky user prompts and response timing for Pi 1.5.1 or later.

## Usage

Load the local package from this repository:

```bash
pi -e ./packages/pi-better-ui
```

After publication, install it with:

```bash
pi install npm:@steveimm/pi-better-ui
```

## Sticky prompts

In fullscreen mode, the user prompt associated with the top visible response stays in a row at the top of the viewport.
Scrolling into an older response shows its prompt.
The row disappears when that prompt is visible in the transcript.
Long prompts are shortened to one line.

The pinned row is separate from transcript content, so it does not add messages or duplicate text in transcript searches.
The extension respects Pi's selected TUI mode and does not switch to fullscreen automatically.
Sticky prompts are unavailable in regular mode, where the terminal controls scrollback.

## Response timing

The native loading animation shows elapsed time beside its label:

```text
Working • 15s
```

When the run ends, a line follows the response:

```text
Worked for 15s • 9:15 PM
```

The duration covers the whole run, including model requests, tools, retries, and waiting time.
The timestamp uses the local clock.
Interrupted runs also receive a timing line.
These lines are saved as UI metadata in the session and remain visible after reload or resume.
They are excluded from model requests, compaction, and branch summaries and do not make extra model calls.
Timing messages saved by earlier builds are filtered from those paths while the extension is loaded.
Timing works in fullscreen and regular modes.

## Development

```bash
npm run check --workspace=packages/pi-better-ui
npm test --workspace=packages/pi-better-ui
npm run test:terminal --workspace=packages/pi-better-ui
```

Terminal tests require tmux and use a local fixture provider.
They check scrolling, narrow windows, mode changes, reloads, tool execution, interruption, and compatibility with `pi-background` and `pi-queue-message`.
The fullscreen adapter uses Pi's rendered component layout and is verified against Pi 1.5.1.
