# @steveimm/pi-chat-template-kwargs

A [pi](https://github.com/earendil-works/pi) extension to override the `chat_template_kwargs` request-body field on the fly, mid-session, without editing model config or restarting. 

Useful for self-hosted inference servers such as llama.cpp, vLLM, SGLang, to override chat-template variables like `reasoning_strength`, `enable_thinking`, etc.

> [!NOTE]
> Only applies to models using the `openai-completions` (includes `llama.cpp`) API. Other providers are left untouched.

## Install

After the package is published to npm:

```bash
pi install npm:@steveimm/pi-chat-template-kwargs
```

To try the local package from the repository root:

```bash
npm ci
pi --no-extensions -e ./packages/pi-chat-template-kwargs
```

## Usage

Run `/ctk` to open a selector listing your saved overrides along with three actions.

- `off`, to turn off the overrides
- `create a new one`, to add new overrides from TUI interactively
- `delete an existing one`, to remove saved overrides

## How it works

The extension intercepts `before_provider_request` hook, which fires right before each request is sent to the provider, and modifies the payload there. 

The active override is **applied last** and merged key by key into whatever `chat_template_kwargs` the payload already carries, so it updates matching keys and adds new ones rather than fully replacing the object.

Overrides are stored in `~/.pi/agent/chat-template-kwargs.json` as a JSON array of kwargs objects and can be edited directly.

```json
[
	{ "reasoning_strength": "low" },
	{ "enable_thinking": false }
]
```

## License

MIT
