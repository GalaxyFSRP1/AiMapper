# Getting this onto GitHub (from any machine with git)

Everything is already committed in the ZIP. Since the workspace has no GitHub credentials,
run these four commands once, from the unzipped folder. Nothing needs to be installed to *use*
the app — this is only for pushing the source.

```bash
cd aimapper
git init -b main
git add .
git commit -m "AiMapper v2.0.0 — Model Studio: automated 5M-parameter model generation + GitHub publishing"
git remote add origin https://github.com/GalaxyFSRP1/AiMapper.git
git push -u origin main
```

If the remote already has history (`Add files via upload` commits), merge instead of forcing:

```bash
git pull --rebase origin main
git push origin main
```

## Proving the publish path against the real GitHub

The only thing this workspace could not verify is a real push, because it has no token.

1. Create a token at <https://github.com/settings/tokens> with **repo** + **workflow** scopes.
2. In the Studio, open **GitHub → Or paste a personal access token**, paste it, press **Connect**.
3. Press **Verify target repo** — it answers with branch, visibility and push permission.
4. Toggle **Publish to GitHub** on and press **Generate AI Model**.
   The result card then links the commit, the `models/<slug>/` tree and the Actions run.

From a terminal the same path is:

```bash
GITHUB_TOKEN=ghp_… node tests/github.test.js --live GalaxyFSRP1/AiMapper
```

That test creates a scratch repository, pushes a full 5M-parameter model through the
blob → tree → commit → ref API, dispatches the workflows and deletes the scratch repo.

## Enabling OAuth instead of pasting a token

<https://github.com/settings/developers> → **New OAuth App**

- Homepage URL: `https://<your-deployment>`
- Authorization callback URL: `https://<your-deployment>/auth/github/callback`

Then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` on the server. With OAuth the token never
exists in the browser at all — it is sealed with AES-256-GCM on the server, bound to the session.
