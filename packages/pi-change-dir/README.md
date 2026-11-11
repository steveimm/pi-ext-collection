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
A project-only installation follows Pi's project extension loading rules.

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

Pi rebuilds its runtime for the destination: tools use the new directory, project settings and instructions reload, and project extensions, skills, prompts, themes, and MCP servers follow the normal session-switch lifecycle.
Project trust follows Pi's existing rules and command-line overrides.
There are no separate Claude-style directory permission rules or `/add-dir` features.
See [Pi's session replacement documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#session-replacement-lifecycle-and-footguns).

Missing paths, regular files, inaccessible directories, and destination session collisions are rejected before switching.
The agent must be idle with no queued messages.
In-memory sessions started with `--no-session` cannot be moved through Pi's file-based session-switch API.

If another extension cancels the switch, the temporary destination transcript is removed and the original session continues.
If runtime creation fails, both transcripts are retained for recovery.
If another extension writes to the outgoing transcript during shutdown, that file is retained with a warning instead of deleting its additional entries.

## License

MIT
