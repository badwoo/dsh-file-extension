# Publishing dsh-file-extension

The repository is committed and tagged `v0.1.0` locally. Only the GitHub push
remains, and it needs your account.

## 1. Log in (once)

```powershell
gh auth login
```

Choose **GitHub.com → HTTPS → login with a web browser**, then paste the code.
Verify with:

```powershell
gh auth status
```

## 2. Create the repository, push, and tag the topic

```powershell
cd D:\AI\dsh-file-extension

# Create the public repository and push the initial commit plus the tag.
gh repo create badwoo/dsh-file-extension --public --source=. --remote=origin --push

# Push the tag.
git push origin v0.1.0

# Add the discovery topic so `dsh plugin` users can find it.
gh repo edit badwoo/dsh-file-extension --add-topic dsh-plugin --add-topic deepseek-harness `
  --add-topic dsh --add-topic file-manager --add-topic context-menu

# Describe the repository.
gh repo edit badwoo/dsh-file-extension `
  --description "Trae-style file context menu for the DeepSeek Harness right Sidebar: reveal, add to chat, open in tab, save as, copy path, rename, and recycle-bin delete."
```

## 3. Cut the GitHub release

```powershell
gh release create v0.1.0 --title "v0.1.0" --notes-file RELEASE_NOTES.md
```

`RELEASE_NOTES.md` is in this directory.

## 4. Verify the one-command install reproduces

Install into a throwaway profile so the working profile stays untouched:

```powershell
# A fresh profile name means a fresh install from GitHub, not a local link.
dsh plugin --profile web-verify add github:badwoo/dsh-file-extension
dsh --profile web-verify --dump-config | Select-String -Context 1,3 "dsh-file-extension"
```

Expect a `- id: dsh-file-extension` / `name: dsh-file-extension` row.

Then run it and confirm the plugin's routes answer:

```powershell
dsh --profile web-verify --port 55001 --no-open
```

```powershell
# In a second terminal: the route must answer 401 unauthenticated (proving it is
# registered and protected), not 404.
curl.exe -i http://127.0.0.1:55001/api/dsh-file-extension/capabilities
```

Finally open the printed URL, expand the right Sidebar, open **Workspace files**,
and right-click a file.

Clean up the throwaway profile when done:

```powershell
dsh plugin --profile web-verify remove dsh-file-extension
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\web-verify"
```

## Notes

- `lib/` is committed, so `github:` installs need no build step and no `prepare`
  script. If you change `src/`, run `node build.mjs` and commit `lib/` too.
- The desktop profile is owned by the Electron app; `dsh plugin --profile desktop`
  refuses to modify it. Desktop users install from the app's plugin settings.
