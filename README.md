# pi-ext-collection

Independently installable [Pi](https://github.com/earendil-works/pi) extensions maintained in one npm workspace repository.
Each directory under `packages/` has its own npm package, version, and dependencies.
The root npm package is private and is not published.

## Extensions

| Extension | npm package | Description |
| --- | --- | --- |
| [Chat template kwargs](packages/pi-chat-template-kwargs/README.md) | `@steveimm/pi-chat-template-kwargs` | Override `chat_template_kwargs` during a session with `/ctk`. |
| [Change directory](packages/pi-change-dir/README.md) | `@steveimm/pi-change-dir` | Change the working directory with `/cd` while continuing the current session. |
| [Background work](packages/pi-background/README.md) | `@steveimm/pi-background` | Run background commands, checks, and reminders. View and stop tasks with `/bg`. |

Install each package independently:

```bash
pi install npm:@steveimm/pi-chat-template-kwargs
```

## Structure

```text
packages/
  pi-background/
    package.json
    tsconfig.json
    index.ts
    manager.ts
    foreground.ts
    status.ts
    ui.ts
    test/
    README.md
    LICENSE
  pi-change-dir/
    package.json
    tsconfig.json
    index.ts
    README.md
    LICENSE
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
npm test
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

Use the **Publish npm package** workflow in [GitHub Actions](https://github.com/steveimm/pi-ext-collection/actions/workflows/publish.yml).
It publishes one extension from `main`, using the version already committed in its `package.json`.
Other packages keep their own versions and release schedules.

For an update, increment the selected package's version:

```bash
npm version patch --workspace=packages/pi-chat-template-kwargs --no-git-tag-version
```

Commit the package manifest and root lockfile, then push to `main`.
On GitHub, open **Actions → Publish npm package → Run workflow**:

1. Choose the `main` branch.
2. Enter the directory name, such as `pi-chat-template-kwargs` or `pi-change-dir`, without `packages/` or the npm scope.
3. Leave **Check the package without publishing** selected to inspect a preview run.
4. Clear that checkbox when ready to publish.

The workflow installs dependencies, runs type checks and tests, and lists the package contents before publishing.
Versions must be stable releases, such as `0.1.1`.
npm rejects versions that have already been published.
The **CI** workflow also runs checks on pull requests and pushes to `main`.

### Set up each npm package

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), so GitHub does not need an npm access token.
For each package, open its settings on npmjs.com and add a GitHub Actions trusted publisher:

| Field | Value |
| --- | --- |
| Organization or user | `steveimm` |
| Repository | `pi-ext-collection` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty |
| Allowed action | Allow direct publishing with `npm publish` |

Create the connection when a release is ready.
npm requires its first successful CI publication within two days of setup.

The package must exist on npm before its trusted publisher can be configured.
For a new extension, log in locally and publish its first release:

```bash
npm login
npm run check
npm test
npm pack --workspace=packages/pi-change-dir --dry-run
npm publish --workspace=packages/pi-change-dir --access public
```

Then configure its trusted publisher and use GitHub Actions for later releases.
Adding another directory under `packages/` does not require editing the workflows.
See [npm's setup requirements](https://docs.npmjs.com/cli/commands/npm-trust/) and [GitHub's manual workflow guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

npm scans new releases before making them available to install, so a successful publish can take several minutes to appear in the registry.
See [npm's publication processing notice](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).

## License

MIT
