# pi-ext-collection

Independently installable [Pi](https://github.com/earendil-works/pi) extensions maintained in one npm workspace repository.
Each directory under `packages/` has its own npm package, version, and dependencies.
The repository root is private and is not published.

## Extensions

| Extension | npm package | Description |
| --- | --- | --- |
| [Chat template kwargs](packages/pi-chat-template-kwargs/README.md) | `@steveimm/pi-chat-template-kwargs` | Override `chat_template_kwargs` during a session with `/ctk`. |

After publishing the package, install it independently:

```bash
pi install npm:@steveimm/pi-chat-template-kwargs
```

## Structure

```text
packages/
  pi-chat-template-kwargs/
    package.json
    tsconfig.json
    index.ts
    README.md
    LICENSE
package.json
package-lock.json
tsconfig.base.json
```

Shared development tools and compiler settings live at the root.
Each extension declares its Pi entry points, runtime dependencies, host-provided peer dependencies, and published files in its own `package.json`.
Pi loads the TypeScript entry points directly, so no build step is needed.

## Development

Install dependencies and check all extensions from the repository root:

```bash
npm ci
npm run check
```

Check or try one extension:

```bash
npm run check --workspace=packages/pi-chat-template-kwargs
pi --no-extensions -e ./packages/pi-chat-template-kwargs
```

The Pi command loads the local package for that invocation without saving an installation.
Keep one root lockfile and use npm to update it when dependencies change.

## Add an extension

1. Create a package with `npm init -y --workspace=packages/<extension-name>`.
2. Give it a name under the `@steveimm` npm scope, such as `@steveimm/pi-<extension-name>`, its own version, `"type": "module"`, and `"license": "MIT"`.
3. Add `index.ts`, a usage README, and a copy of the root `LICENSE`.
4. Add `"pi": { "extensions": ["./index.ts"] }`, `"keywords": ["pi-package"]`, `"publishConfig": { "access": "public" }`, and a `files` allowlist covering its source and runtime assets.
5. Add a `tsconfig.json` extending `../../tsconfig.base.json` with `"include": ["**/*.ts"]`, and a `check` script running `tsc --noEmit`.
6. Declare imported Pi packages as `peerDependencies` with `"*"` and as `devDependencies` for local type checking, following the existing extension.
7. Add third-party runtime dependencies to that workspace with `npm install <dependency> --workspace=packages/<extension-name>`.
8. Set the repository URL and `repository.directory`, add the extension to the table above, and run `npm install` and `npm run check` from the root.

Keep extensions self-contained, without relative imports into sibling packages.
If an extension gains more source files or assets, update its `files` allowlist.
See the [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) for manifests and host-provided dependencies.

## Publish an extension

Packages use the `@steveimm` npm scope.
Publish with the npm account that owns this scope or has publishing access to the package.
Authenticate with npm using `npm login`.
For later releases, increment only the changed package's version:

```bash
npm version patch --workspace=packages/pi-chat-template-kwargs --no-git-tag-version
```

Check the repository, inspect the selected package's contents, then publish it:

```bash
npm ci
npm run check
npm pack --workspace=packages/pi-chat-template-kwargs --dry-run
npm publish --workspace=packages/pi-chat-template-kwargs --access public
```

Publish only the workspace being released.
Other extensions retain their own versions and release schedules.
See [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces/) and [npm publish](https://docs.npmjs.com/cli/commands/npm-publish/) for workspace commands.

## License

MIT
