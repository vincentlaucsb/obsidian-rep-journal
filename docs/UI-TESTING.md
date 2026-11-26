# Obsidian UI tests

Run the Playwright smoke test on Windows with Node 22.18+ and [Obsidian 1.15.0](https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.15.0).

```powershell
npm ci
npm run test:ui
```

The default executable is `%LOCALAPPDATA%\Obsidian\Obsidian.exe`. Set
`OBSIDIAN_EXECUTABLE` to the full path of a separate 1.15.0 installation if needed.

The command builds the plugin and copies it into a temporary vault with a fictional
exercise and a separate Obsidian profile. Playwright connects to that process over
loopback. The test logs a set through the workout log, checks the saved vault file,
and reopens the set after reloading Obsidian. Failures write diagnostics to
`test-results/`. GitHub Actions runs the same command on Windows for pull requests
and pushes to `master`.

## Persistent development vault

Open the local `dev-vault/` Git repository as a vault in Obsidian, or run `npm run standalone -- --vault dev-vault`. It contains synthetic workouts for manual testing. The vault tracks its own test data and plans. Its generated plugin files are ignored by Git.

Run `npm run dev` during active development. Successful rebuilds update `main.js`, `manifest.json`, and `styles.css` in `dev-vault/.obsidian/plugins/rep-journal/`. Stylesheet and manifest edits also trigger a rebuild. For a one-off update, run `npm run build`. Reload Rep Journal in Obsidian to activate updated JavaScript.

The copy runs when the test vault's plugin directory exists. If setting up another checkout, place a copy of the test vault at `dev-vault/`, create that plugin directory, and build once.
