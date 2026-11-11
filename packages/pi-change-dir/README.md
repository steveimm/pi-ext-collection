# @steveimm/pi-change-dir

A [Pi](https://github.com/earendil-works/pi) extension that changes the working directory with `/cd` while continuing the current conversation.

## Install

After publication:

```bash
pi install npm:@steveimm/pi-change-dir
```

For local development, run from the repository root:

```bash
npm ci
pi -e ./packages/pi-change-dir
```

Install globally or load with `-e` so `/cd` remains available after leaving the original project.
An installation saved only in the original project's settings will not load in other projects.

## Usage

```text
/cd ../another-project
/cd ~/Git/my-project
/cd "/path/with spaces"
/cd ~
/cd
```

`/cd` without an argument shows the current directory.
Relative paths resolve from the active session's directory.
Paths containing spaces can be quoted or entered directly.
Shell variables, wildcards, and shell commands are not expanded.

## Behavior

The extension preserves the session ID, conversation tree, active branch, name, and creation timestamp.
It writes the transcript into Pi's default session folder for the destination project, switches through Pi's session API, then removes the old transcript after a successful switch.
This also applies when the original transcript was opened from a custom session directory.

Pi reloads project settings, instructions, extensions, skills, prompts, and themes for the new directory.
Tools use the new directory, and Pi reconnects project MCP servers on versions that support MCP.
Project trust follows Pi's existing rules and command-line options.
See [Pi's session switching documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#ctxswitchsessionsessionpath-options).

Missing paths, regular files, and inaccessible directories are rejected before switching.
An existing destination transcript is never overwritten.
The agent must be idle with no queued messages.
Sessions started with `--no-session` cannot use `/cd`, because Pi can only switch to a saved session.

If another extension cancels the switch, the temporary destination transcript is removed and the original session continues.
If Pi cannot finish switching, both transcripts are kept for recovery.
If another extension writes to the old transcript during shutdown, that file is kept with a warning so its additional entries are preserved.

## Development

Run the checks from the repository root:

```bash
npm run check
npm test --workspace=packages/pi-change-dir
```

The tests launch Pi with temporary projects and configuration, without model requests.
Set `PI_CHANGE_DIR_TEST_CLI` to another Pi installation's `dist/cli.js` to test that version.
The MCP test runs only when that version includes MCP support.

## License

MIT
