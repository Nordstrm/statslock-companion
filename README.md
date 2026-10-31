# Statslock Companion (Tauri v2)

Tiny Windows tray app: F8 overlay with daily meta, counters and community build IDs for Deadlock.

- VAC-safe: no memory reading, injection or hooks. Only process-list polling (every 8s), Steam registry `ActiveUser`, and `GET https://statslock.io/api/public/companion/meta`.
- Offline cache in `%LOCALAPPDATA%/StatslockCompanion/meta.json`.
- Silent auto-update via GitHub Releases (`tauri-plugin-updater`).
- Optional start with Windows (`--hidden`), stays in tray until Deadlock starts.

## One-time setup
1. Move this folder into its own GitHub repo.
2. `cargo install tauri-cli` then `cargo tauri signer generate -w ~/.tauri/statslock.key`.
3. Put the public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) and replace `REPLACE_OWNER` in the endpoint.
4. Add repo secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
5. Add icons: `cargo tauri icon path/to/lock.png`.
6. Local run (Windows): `cd src-tauri && cargo tauri dev`. Release: push tag `v0.1.0`.

## Not yet included
- Writing builds into Deadlock's local build files (needs the file format verified on a real install).
- Uploading your own in-game builds to Statslock (needs app sign-in).
