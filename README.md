# Bitbucket DC Pull Requests

VS Code / Cursor extension for **Bitbucket Data Center / Server** pull request review inside the IDE.

When the checked-out branch has an open pull request, the extension lets you:

- see the PR (title, description, author, reviewers, changed files) in a sidebar and in the status bar,
- open each changed file as a **PR diff** (target commit vs. source commit, fetched from the server),
- read, create, reply to, edit and delete **inline comments and tasks** – in the PR diff and on the **local files** of the checked-out branch,
- read, create, reply to, edit and delete **general (overview) comments and tasks**,
- **resolve / reopen tasks** (Bitbucket BLOCKER comments, which block the merge); open tasks are counted in the status bar, the view badge and per file.

Authentication uses a Bitbucket **HTTP access token** (`Authorization: Bearer`). With a read-only token the extension works in read-only mode (comments are shown, editing is disabled).

Tested against Bitbucket Data Center 8.19 (`git.tipsport.it`).

## Install locally

```bash
npm install
npm run package              # runs unit tests and produces bitbucket-dc-pr-<version>.vsix
code --install-extension bitbucket-dc-pr-*.vsix
cursor --install-extension bitbucket-dc-pr-*.vsix
```

Reload the window afterwards.

## Sign in

1. In Bitbucket: *Manage account → HTTP access tokens → Create token* (project/repository **read** for read-only mode, **write** to comment).
2. In the IDE: `Bitbucket PR: Sign In…`, paste the token. It is stored in the IDE secret storage (never in settings or logs), one token per server host.

`Bitbucket PR: Sign Out` forgets the token.

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
| `bitbucketPr.serverUrl` | `https://git.tipsport.it` | Server used when the remote host cannot be parsed. |
| `bitbucketPr.refreshIntervalSeconds` | `60` | Polling interval; `0` disables polling. |
| `bitbucketPr.readOnly` | `false` | Force read-only mode. |
| `bitbucketPr.showOnLocalFiles` | `true` | Show threads on local files. |
| `bitbucketPr.contextLines` | `10` | Context lines requested around diff hunks. |

## Development

```bash
npm install
npm run watch     # esbuild in watch mode
# F5 in VS Code → Extension Development Host
npm test          # typecheck + unit tests (anchor mapping, remote parsing, REST client)
```

Source layout: `src/bitbucket` (REST client + types), `src/core` (pure logic: remote parsing, anchor mapping), `src/auth`, `src/git`, `src/pr`, `src/comments`, `src/diff`, `src/views`.
