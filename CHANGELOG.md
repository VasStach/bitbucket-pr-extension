# Changelog

All notable changes to the **Bitbucket Data Center PR Comments** extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [0.3.2] – 2026-11-19

### Changed

- Display name is now **Bitbucket Data Center PR Comments**.

## [0.3.1] – 2026-11-18

### Changed

- Display name is now **Bitbucket Data Center Comments**. The previous name was rejected by the Visual Studio Marketplace because it was too similar to an existing extension.

## [0.3.0] – 2026-11-18

First public release on GitHub, Visual Studio Marketplace and Open VSX.

### Added

- Marketplace icon and gallery banner.
- Changelog.

### Changed

- README now describes installation from the marketplaces; building a `.vsix` locally is documented under *Development*.

## [0.2.5] – 2026-11-11

### Security

- Virtual PR documents (`bbpr:` file contents, `bbpr-overview:` overview) are served only for the pull request currently resolved for the workspace; URIs are validated against the active PR, its changed files and their source/target commits before any request is made.
- Virtual document URIs no longer carry the server base URL; the Bitbucket client of the active repository is always used, so a crafted URI cannot direct requests to another host.
- Removed the `BITBUCKET_TOKEN` environment-variable fallback; tokens come exclusively from the IDE secret storage.
- `bitbucketPr.serverUrl` no longer has a default server; it is only used when the remote URL cannot be derived (e.g. context paths).
- Declared as unsupported in untrusted and virtual workspaces.

### Changed

- Publisher identifier changed to `vaclav-stach` (extension ID `vaclav-stach.bitbucket-dc-pr`); repository, bugs and homepage metadata added.

## [0.2.4] – 2026-11-10

### Added

- `bitbucketPr.enableInlineCommenting` setting with a toggle button in the view toolbar; when off, the `+` gutter markers are hidden while existing threads remain visible.

### Changed

- README documents editor settings for comment appearance (`comments.maxHeight`, gutter range colour).

## [0.2.3] – 2026-11-10

### Changed

- Existing threads are always labelled (`Comment`, `Task`, `Task · resolved`, …) instead of VS Code's default "Start discussion".
- Reply box placeholder simplified; the "posted immediately" prompt was removed.

### Fixed

- Commenting ranges (`+` gutter) are re-evaluated whenever their inputs change (PR loaded, token or read-only state, HEAD or working tree, settings), so the gutter no longer appears or disappears unpredictably.

## [0.2.2] – 2026-11-03

### Fixed

- Comment widgets were rebuilt on every refresh, which stole keyboard focus from other panels (e.g. the chat). Threads are now only updated when their content actually changed, and never while one of their comments is being edited.
- The PR overview document re-renders only when its text changed.

## [0.2.1] – 2026-11-03

### Added

- `Bitbucket PR: Select Repository…` to pin the repository in multi-repository workspaces.

### Fixed

- Repository selection in multi-root / multi-repository workspaces: the extension now follows the repository selected in the Git status bar, then the active editor's repository (only if it belongs to the workspace), then the workspace folders — instead of the first repository the Git extension happened to register.
- The view description shows the repository and branch the PR belongs to.

## [0.2.0] – 2026-11-02

### Added

- Tasks: **Create Task** / **Create Comment** and **Reply as Task** / **Reply** actions, `Add General Task…` command, task markers (`☐ Task — open`, `☑ Task — resolved`) and task counts in the status bar, view badge and file tree.
- **Resolve Task** / **Reopen Task** on task comments (root or reply).

### Removed

- Thread-level resolve/reopen for plain comments; Bitbucket thread resolution is display-only.

## [0.1.2] – 2026-11-02

### Fixed

- Resolving a task did not update the IDE: the resolved state is now derived from the task `state` as well as `threadResolved`.

## [0.1.1] – 2026-11-02

### Fixed

- Git state listener was not attached when the remote became known after the repository opened; HEAD and working-tree changes were therefore ignored and threads on local files stayed labelled *outdated* after pulling.
- The *outdated* label now states the reason (HEAD mismatch or uncommitted changes).

## [0.1.0] – 2026-11-02

Initial version.

- Detects the open pull request for the checked-out branch on a Bitbucket Data Center / Server (tested with 8.19).
- Sidebar view with PR header, changed files and general comments; status bar item.
- PR diff view (target vs. source commit) with inline comment threads; threads also shown on local files when the checkout matches the PR source commit.
- Create, reply, edit, delete comments; PR overview document hosting general comments.
- Authentication with an HTTP access token stored in the IDE secret storage; automatic read-only mode when the token lacks write permission.
