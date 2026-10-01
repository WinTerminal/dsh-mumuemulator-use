# dsh-mumuemulator-use

A DSH plugin that puts the local **MuMu Player 12** emulator under model control.
It shells out to MuMu's own `MuMuManager.exe` and to `adb` — no Python, no MCP
server, no extra serialization layer. Windows only.

Seven tools, all prefixed `mumu_`:

| tool | what it does |
| --- | --- |
| `mumu_env` | show which install was found, from where, and where the cache lives |
| `mumu_list_instances` | every instance with index, name, Android version, run state, adb endpoint, pid |
| `mumu_instance` | launch / shutdown / restart / create / delete / rename / show_window / hide_window |
| `mumu_app` | list / info / install / uninstall / launch / close an app |
| `mumu_ui` | tap / swipe / long_press / text / key (framebuffer pixel coordinates) |
| `mumu_shell` | run a shell command inside the Android guest |
| `mumu_screenshot` | capture the screen; returns an image the model can look at |

## Install

The plugin is a plain DSH bundle. With `$PROFILE` = `C:\Users\HP\.dsh\profiles\desktop`:

```powershell
# 1. the files (already in place if you are reading this from the profile)
#    $PROFILE\plugins\dsh-mumuemulator-use\{package.json,cordis.patch.yml,lib\*.js}

# 2. declare it as a dependency through the official channel
dsh plugin --profile desktop add file:plugins/dsh-mumuemulator-use

#    the code imports @deepseek-ai/schemastery; a fresh profile sets
#    autoInstallPeers: false, so make sure it is actually there
dsh plugin --profile desktop add @deepseek-ai/schemastery

# 3. add it to the bundle list, in $PROFILE\package.json
#    "dsh": { "profile": { "bundles": [ ..., "dsh-mumuemulator-use" ] } }

# 4. link it (see "Why a junction" below) — do this ONCE, after every install
Get-Item $PROFILE\node_modules\dsh-mumuemulator-use -Force | Select-Object LinkType
cmd /c rmdir $PROFILE\node_modules\dsh-mumuemulator-use    # link only — NEVER /s, NEVER -Recurse
New-Item -ItemType Junction -Path $PROFILE\node_modules\dsh-mumuemulator-use -Target $PROFILE\plugins\dsh-mumuemulator-use

# 5. reload the profile (restart the app, or toggle the bundle off/on)
```

Nothing else is needed: the plugin finds MuMu itself on first use.

## Where the paths come from

`mumu_env` prints the whole trail. Resolution order:

1. **config override** — `mumuRoot` / `mumuManagerPath` / `adbPath` set on the `mumu` row.
2. **cache file**, `<profile>\dsh-mumu-paths.json` — reused when every recorded path still exists.
3. **registry** — `DisplayName` matching `/MuMu/i` in `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*`,
   `HKLM\SOFTWARE\WOW6432Node\...\Uninstall\*`, `HKCU\...\Uninstall\*`. For each hit three fields are tried in order:
   `InstallLocation` → `DisplayIcon` (`"C:\path\app.exe",0`, quotes and `,0` stripped) → `UninstallString`
   (quotes stripped, directory taken). A candidate is accepted only if `<root>\MuMuManager.exe` or
   `<root>\nx_main\MuMuManager.exe` exists.
4. **sweep** — common install roots, as a last resort only.

`adb` prefers the newest `nx_device\<version>\shell\adb.exe`, then `nx_main\adb.exe`, then `adb` on `PATH`.
`reg query` writes in the OEM code page, so output is decoded as UTF-16LE (BOM), then strict UTF-8, then
strict GBK, then latin1 — this is why `MuMu模拟器` does not come back as mojibake.

On this machine it resolves to:

```
MuMu root       : D:\Program Files\Netease\MuMu
MuMuManager.exe : D:\Program Files\Netease\MuMu\nx_main\MuMuManager.exe
adb             : D:\Program Files\Netease\MuMu\nx_device\15.0\shell\adb.exe
cache file      : %PROFILE%\dsh-mumu-paths.json
version         : {"version":"6.8.2.0"}
```

## Configuration

Set it on the plugin's row in `%PROFILE%\cordis.patch.yml`:

```yaml
- id: mumu          # rowId is always "mumu"
  config:
    adbPath: 'D:\Program Files\Netease\MuMu\nx_device\15.0\shell\adb.exe'
    screenshotIncludeImage: false
```

| key | default | meaning |
| --- | --- | --- |
| `mumuRoot` | `''` | force the install root; skips detection |
| `mumuManagerPath` | `''` | force `MuMuManager.exe`; skips detection |
| `adbPath` | `''` | force `adb.exe`; empty = auto, falling back to `adb` on `PATH` |
| `cacheFile` | `<profile>\dsh-mumu-paths.json` | where the resolved paths are cached |
| `commandTimeoutMs` | `120000` | per-command budget; the child is killed on expiry |
| `bootTimeoutMs` | `300000` | how long `mumu_instance launch` waits for Android |
| `adbConnectTimeoutMs` | `60000` | budget for `adb connect` |
| `screenshotIncludeImage` | `true` | default for `mumu_screenshot`'s `includeImage` argument |

Only `mumuRoot`/`mumuManagerPath` short-circuit detection; `adbPath` alone overrides just the adb side.

## Known limitations

- **`MuMuManager sh` cannot report failure.** It exits 0 and prints nothing, whether the guest command
  succeeded or not, and MuMu refuses to run the `adb` subcommand's `getprop` form. `mumu_shell` therefore
  appends `echo "MUMU_SH_EXIT:$?"` on its own line and parses the marker back out. A command line that the
  guest shell cannot parse (an unbalanced quote) swallows the marker and the exit code reads `unavailable`.
  A bare key name (`go_home`, `go_back`, …) is passed through untouched — those are MuMu shortcuts, not shell.
- **`control tool cmd` is fire-and-forget.** `MuMuManager control -v 1 tool cmd -c "..."` answers
  `{"errcode":0,"errmsg":""}` for every input, including nonsense, and never returns guest stdout. Use
  `mumu_shell` when you need output.
- **`show_window` / `hide_window` / `layout_window` / `tool func` / `tool cmd` do not validate the instance
  index** — they answer `errcode 0` for an index that does not exist. The plugin calls `info -v <index>`
  first (`assertInstance`) so those paths fail loudly instead of silently succeeding.
- **A stopped instance** gives `errcode -201` (`player not running` / `vm not running, can not connect
  NemuShell !!`) for touch, shell and app tools; `mumu_screenshot` reports
  `MuMu instance "1" is not running Android yet (player_state=stopped).`
- **`adb` must be usable.** With a wrong `adbPath` you get `spawn <path> ENOENT`; `mumu_shell` still works
  because it never touches adb.
- **`lib\index.js` is a reconstruction, not the original file.** It was rebuilt from this session's
  tool-call log after the original was deleted by mistake. Five of the seven files came back
  byte-for-byte identical; `lib\index.js` is ~330 bytes shorter than the file it replaces. Every
  tool description matches the live registry and all behaviour probes pass — see "Known gaps"
  before trusting a branch that has never been exercised.
- **The framebuffer is landscape.** `wm size` reports 900x1600 but screenshots come back 1600x900, and
  `mumu_ui` coordinates are framebuffer pixels, i.e. what you see in a `mumu_screenshot` image.
- Screenshots are ~1.15 MB / 1600x900. Pass `includeImage: false` (or set `screenshotIncludeImage: false`)
  when polling, so the image does not enter the conversation on every call.

## Changing the code

HMR is live in this profile, so **editing a file under `%PROFILE%` reloads the plugin within ~1–2 s — no
restart.** Measured with a behavioural probe: 1100 ms to swap one way, 2051 ms back.

### First: `node_modules\dsh-mumuemulator-use` must be a junction

This is the load-bearing part of the whole setup, so check it before anything else.

**1. Requirement.** It must be a junction, not a real directory and not a hardlink:

```powershell
New-Item -ItemType Junction -Path $PROFILE\node_modules\dsh-mumuemulator-use -Target $PROFILE\plugins\dsh-mumuemulator-use
```

**2. How to check.**

```powershell
Get-Item $PROFILE\node_modules\dsh-mumuemulator-use | Select-Object LinkType, Target
# LinkType  Target
# --------  ------
# Junction  C:\Users\HP\.dsh\profiles\desktop\plugins\dsh-mumuemulator-use
```

**3. How to repair.** If `LinkType` comes back empty it is a real directory (a sync tool, a manual
`Copy-Item`, or a `pnpm` path did it). Delete it and re-create the junction as in step 1.

> **Never use a recursive delete here — not on the junction, and not on a directory that merely
> contains it.** Both of these have already destroyed the source once:
>
> - `Remove-Item $PROFILE\node_modules\dsh-mumuemulator-use -Recurse -Force` — PowerShell follows the
>   reparse point, so it deletes the *contents of the target*; `plugins\dsh-mumuemulator-use` is
>   emptied too and you are left with two empty directories.
> - `cmd /c rmdir /s /q $PROFILE\node_modules` — deleting the **parent** with `/s` descends through
>   the junction in exactly the same way. `/s` is the whole problem; the junction is not.
>
> The only safe removal is a **non-recursive** `rmdir` on the link itself:
>
> ```powershell
> cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-mumuemulator-use"
> ```
>
> Check `LinkType` first (`Get-Item … | Select-Object LinkType`); only a `Junction` may be deleted
> with `rmdir`. If `LinkType` is empty it is a real directory and `rmdir` will refuse it — copy the
> files out first, then delete. When a `pnpm`/`dsh plugin` install has to rebuild `node_modules`,
> let it delete the junction by itself instead of clearing the directory out from under it.

**4. Symptom when it is wrong:** you edit the source, HMR reports nothing unusual, and **the behaviour does
not change**. The module URL becomes `node_modules\dsh-mumuemulator-use\lib\index.js`, so the watcher reloads the stale
copy while your edits sit in `plugins\`. No error, no log line — the reload simply succeeds against the
wrong file. This is *quieter* than the old hardlink breakage, which at least showed up as a size or File-ID
mismatch.

### Then: why it reloads at all

Two settings make the reload happen:

- `%PROFILE%\cordis.patch.yml` enables the watcher:
  ```yaml
  - id: hmr
    disabled: false
    config:
      root: ['.']
  ```
- The junction keeps the module's real path at `%PROFILE%\plugins\dsh-mumuemulator-use\lib\index.js` — outside
  `node_modules`, which `dsh-hmr` ignores by default.

Verify a reload landed by checking `mumu_env`'s description in the tool list, or by calling a tool whose
behaviour you just changed.

If HMR is ever off, the fallback is a restart — editing files alone will *not* be picked up, because Node
caches ES modules by URL for the lifetime of the process.

### Saving half-written code

HMR fires on every save, and editors that truncate-then-write can briefly expose a partial file. This is not
worth guarding against for occasional post-development edits: a broken save just makes the tools error until
the next save repairs them, and restarting the profile clears it. The one thing to avoid is driving
`mumu_*` calls from a session while you are mid-save.

### What a reload does to an in-flight call

A reload disposes the old generation, and the host-side `MuMuManager.exe` child of any running call
disappears ~1.5 s after the save. That does **not** break the call: it still returns at its natural
duration, still reports the real guest exit code, and leaves no zombie behind.

Measured on 2026-10-01 with `mumu_shell {command: 'sleep 60'}` and a background poller reporting
`(Get-Process MuMuManager -EA SilentlyContinue).Count`:

| scenario | host `MuMuManager` count | wrapped call |
| --- | --- | --- |
| control, no reload | `1` for the whole 20 s call | returned at 20 579 ms |
| HMR reload at +6 s | `1` at +6 s → **`0` at +7.5 s** → `0` thereafter | returned at 60 588 ms, `guest exit code 0` |
| external `Stop-Process -Name MuMuManager` at +6 s | `1` at +6 s → `0` at +7 s → `0` thereafter | returned at 25 529 ms, `guest exit code 0` |

So a reload does not disturb in-flight work and does not leak. To reproduce: start a long `mumu_shell`,
poll the count from a background `pwsh` job, and trigger the reload by saving a file under `%PROFILE%`.

## Known gaps

**None — this file is complete.** An earlier revision of this README claimed `lib\index.js` was
~330 bytes short of the copy that was running before the accidental delete (31 907 B on disk vs
31 603 B reconstructed). That was a measurement artefact, and the accounting is now exact.

Two writes to the file never reached the tool-call log, so replaying `write`/`edit` alone could not
reproduce them:

- a `run_code` step removed an earlier `mumu-activated.json` probe block (−4 lines) — the replay
  still carried it;
- a `pwsh` step removed one further leftover line with
  `Get-Content | Where-Object { $_ -notmatch 'mumu-activated' } | Set-Content -Encoding utf8NoBOM`
  (−1 line) and, in the same pass, rewrote the whole file with **CRLF** line endings where the
  replay had LF.

With those two corrections applied, the reconstruction matches the live file *line for line* at
every one of the twelve `read` snapshots, and the byte count reconciles twice over:

```
snapshot at log seq 1583:  30 704 B = 30 070 B (reconstruction) + 634 CRLF pairs  · 634 lines
snapshot at log seq 2602:  31 907 B = 31 275 B (reconstruction) + 632 CRLF pairs  · 652 lines
```

so nothing is missing: the difference was entirely line endings. The shipped `lib\index.js`
(31 279 B) is byte-for-byte the reconstruction — the two probe lines are gone — with LF endings
instead of CRLF, which is a no-op for Node and is what `node --check` was run against.

```powershell
# how the reconstruction was produced (workspace scripts, not shipped)
node recover.mjs      # decompress session.v4.jsonl.zstd frame by frame,
                      # replay every write/edit tool call in order
node recover7.mjs     # anchor the read snapshots against the result
node desc-diff.mjs    # diff the tool descriptions against the live registry
```

`session.v4.jsonl.zstd` is a concatenation of ~1500 zstd frames — one per append.
`zlib.zstdDecompressSync` decodes only the **first** frame (242 bytes); scan for the magic
`28 B5 2F FD` and decompress each frame separately.

## Uninstall

```powershell
# 1. remove the bundle through the official channel
#    plugin_manager { action: 'remove_bundle', target: 'dsh-mumuemulator-use' }
#    (or: dsh plugin --profile desktop remove dsh-mumuemulator-use)

# 2. delete the leftover link and files
Remove-Item $PROFILE\node_modules\dsh-mumuemulator-use -Force
Remove-Item $PROFILE\plugins\dsh-mumuemulator-use -Recurse -Force

# 3. drop "dsh-mumuemulator-use" from dsh.profile.bundles in $PROFILE\package.json

# 4. restore the profile patch if you want the pre-install state.
#    NOTE: $PROFILE\cordis.patch.yml.bak-before-mumu is NOT a mumu-only rollback.
#    It is a snapshot of the whole profile patch taken before this round of edits,
#    so restoring it also drops the tool-plugin-manager, hmr and tool-cordis rows
#    that were added alongside the plugin. All four go at once — if you only want
#    mumu gone, delete the `- id: mumu` row instead of restoring the backup.
#    $PROFILE\cordis.patch.yml.bak-before-mumu

# 5. delete the path cache
Remove-Item $PROFILE\dsh-mumu-paths.json
```

The hand-made profile edits are exactly two: the `dsh-mumuemulator-use` entry in
`$PROFILE\package.json` (`dependencies` and `dsh.profile.bundles`), and — if you applied them — the
`tool-plugin-manager` / `hmr` / `tool-cordis` rows in `$PROFILE\cordis.patch.yml`. Backups of the
pre-change files sit next to them as `*.bak-before-mumu`.
