**The update test quits through `quitAndInstall` with `autoRunAppAfterInstall` off, and runs from any folder.** On macOS, electron-updater reports a download as soon as it has the zip, before Squirrel.Mac has fetched it from electron-updater's local server. Quitting at that point installs nothing. `quitAndInstall` waits for Squirrel, and with `autoRunAppAfterInstall` off it ends in a plain `app.quit()`, so Squirrel installs the update as the app exits and nothing relaunches into a full Kernel. If the quit hasn't happened 90 seconds after `ready`, the test exits 1.

The test passes no `outside` to the updater, so a copy outside Applications still updates. Squirrel replaces the app where it runs, and the end-to-end test runs a copy from a temp folder. The normal launch still refuses to update outside Applications (KERNEL-443).

Signature checks and `allowDowngrade = false` stay on, so the flag can only install a newer build signed by the same team. KERNEL-713
