# Bitbucket Data Center Comments

VS Code / Cursor extension for **Bitbucket Data Center / Server** pull request review inside the IDE.

When the checked-out branch has an open pull request, the extension lets you:

- see the PR (title, description, author, reviewers, changed files) in a sidebar and in the status bar,
- open each changed file as a **PR diff** (target commit vs. source commit, fetched from the server),
- read, create, reply to, edit and delete **inline comments and tasks** – in the PR diff and on the **local files** of the checked-out branch,
- read, create, reply to, edit and delete **general (overview) comments and tasks**,
- **resolve / reopen tasks** (Bitbucket BLOCKER comments, which block the merge); open tasks are counted in the status bar, the view badge and per file.

Authentication uses a Bitbucket **HTTP access token** (`Authorization: Bearer`). With a read-only token the extension works in read-only mode (comments are shown, editing is disabled).

Tested against Bitbucket Data Center 8.19.

## Install

Open the Extensions view (`Cmd/Ctrl+Shift+X`), search for **Bitbucket Data Center Comments** and click *Install*.

- VS Code installs from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=vaclav-stach.bitbucket-dc-pr).
- Cursor, VSCodium, Windsurf and other Open VSX based editors install from [Open VSX](https://open-vsx.org/extension/vaclav-stach/bitbucket-dc-pr).

Manual install from a `.vsix` file (e.g. a [GitHub release](https://github.com/VasStach/bitbucket-pr-extension/releases)): *Extensions view → `…` → Install from VSIX…*, or `code --install-extension bitbucket-dc-pr-<version>.vsix`.

Requires VS Code 1.85 or newer (or a compatible editor) with the built-in Git extension enabled.

## Sign in

1. In Bitbucket: *Manage account → HTTP access tokens → Create token* (project/repository **read** for read-only mode, **write** to comment).
2. In the IDE: `Bitbucket PR: Sign In…`, paste the token. It is stored in the IDE secret storage (never in settings or logs), one token per server host.

`Bitbucket PR: Sign Out` forgets the token.

## Privacy and security

- The extension has no telemetry or analytics and does not send data to its publisher.
- Network requests go only to the Bitbucket server identified by the repository remote or explicitly configured by the user.
- Access tokens are stored per server in the IDE secret storage and are sent only as authorization for Bitbucket API requests.
- The extension is disabled in untrusted and virtual workspaces.

## Usage

- Open a folder whose git remote points to the Bitbucket server (`https://<host>/scm/<project>/<repo>.git` or `ssh://git@<host>/<project>/<repo>.git`).
- In a workspace with several repositories the extension follows the repository selected in the git status bar (the one whose branch is shown there), then the active editor's repository. `Bitbucket PR: Select Repository…` pins a repository explicitly.
- Check out a branch that has an open PR. The status bar shows `#<id> · <n> unresolved`; the **Bitbucket PR** activity bar view lists changed files and general comments.
- Click a changed file to open the PR diff. Hover a line gutter and click `+`, write the text and choose **Create Task** or **Create Comment**; existing threads render on their lines. Replies offer **Reply as Task** / **Reply**. Tasks are marked `☐ Task — open` / `☑ Task — resolved` and have Resolve / Reopen actions; plain comments have none (thread "resolution" is intentionally not exposed).
- With `bitbucketPr.showOnLocalFiles` enabled (default), threads also show on local files when the local `HEAD` equals the PR source commit and the file is unmodified. Otherwise threads are labelled *outdated* and new comments must be made in the PR diff.
- `Bitbucket PR: Open Pull Request Overview` opens the description document; general comments and tasks are attached there. `Bitbucket PR: Add General Task…` / `Add General Comment…` add new ones.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `bitbucketPr.serverUrl` | empty | Optional server URL used when the full URL cannot be derived from the remote, for example when the server has a context path. |
| `bitbucketPr.refreshIntervalSeconds` | `60` | Polling interval; `0` disables polling. |
| `bitbucketPr.readOnly` | `false` | Force read-only mode. |
| `bitbucketPr.showOnLocalFiles` | `true` | Show threads on local files. |
| `bitbucketPr.enableInlineCommenting` | `true` | Offer the `+` gutter for new inline comments/tasks (toggle button in the view toolbar). Off hides the gutter range markers; existing threads stay visible. |
| `bitbucketPr.contextLines` | `10` | Context lines requested around diff hunks. |

## Editor-side appearance

The comment widgets are rendered by the editor, not by the extension. Useful editor settings:

- `comments.maxHeight: false` – show long comments in full instead of an inner scrollbar.
- `workbench.colorCustomizations` → `"editorGutter.commentRangeForeground": "#00000000"` – hide the permanent commenting-range bar in the gutter while keeping the hover `+`.

## Development

```bash
npm install
npm run watch     # esbuild in watch mode
# F5 in VS Code → Extension Development Host
npm test          # typecheck + unit tests (anchor mapping, remote parsing, REST client)
npm run package   # tests + bitbucket-dc-pr-<version>.vsix for local installation
```

Source layout: `src/bitbucket` (REST client + types), `src/core` (pure logic: remote parsing, anchor mapping), `src/auth`, `src/git`, `src/pr`, `src/comments`, `src/diff`, `src/views`.
