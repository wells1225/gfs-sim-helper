# M8 relay: Lila's mod requests

When Lila clicks **Send to Tyler** in the app, it writes `requests/r-<id>.json` into the shared Google Drive folder
`Sims Helper Mods`. This relay runs on `tyler-M8` every 5 minutes, emails Tyler about each new request (subject
"Lila asked for a mod"), and can also POST it to a T3 webhook. When Tyler has built the mod, `deliver.mjs` puts it
in `from-tyler/<id>/` with a `ready.json`, and her app offers **Install**.

- `m8-relay.mjs`: one run. Lists `requests/`, checks each new file (format 1, sizes, no control characters), emails,
  posts to the webhook if one is set, then records the id in `~/.local/state/sims-helper-relay/seen.json`. A failed
  email leaves the request unseen, so the next run tries again. A request that fails the checks is logged by id and
  reason (never its text) and not tried again. A lock file stops two runs overlapping.
- `deliver.mjs`: uploads a finished mod and writes `ready.json` last.
- Plain Node 22, no npm packages. It uses `rclone` and `msmtp` and nothing else.

Nothing secret is in this folder. The Gmail app password lives only in `~/.msmtprc`, which the scripts never read.
The scripts print `<hidden>` in place of any config value.

## Setup on tyler-M8 (once)

Everything below runs as your own user, not root, except the two `sudo` lines.

1. **Node 22 or newer, rclone, msmtp.**

   ```sh
   sudo apt install rclone msmtp     # or your distro's packages; rclone 1.60+ is fine
   node --version                    # must be v22 or newer
   ```

2. **The repo.** The unit file expects it at `~/gfs-sim-helper`.

   ```sh
   git clone git@github.com:wells1225/gfs-sim-helper.git ~/gfs-sim-helper
   ```

3. **rclone remote `simsdrive`, rooted at the shared folder.** In Google Drive (web), open `Sims Helper Mods` and copy
   the folder id from the address bar (the part after `/folders/`). Then:

   ```sh
   rclone config
   ```

   - `n` (new remote), name `simsdrive`, storage `drive`.
   - Leave `client_id` and `client_secret` empty (or use your own Google Cloud client, which rclone recommends).
   - Scope: `drive` (full access). The narrower `drive.file` cannot see the files her PC writes, so it won't work.
     Google does not offer a scope limited to one folder; `root_folder_id` below is what keeps rclone inside it.
   - `root_folder_id`: paste the folder id.
   - Advanced config: `n`. Auto config: on a machine with no browser say `n`, and rclone prints an
     `rclone authorize "drive" ...` command. Run that on your Mac, sign in in the browser yourself, and paste the
     result back. Shared drive: `n`.

   Check it: `rclone lsjson simsdrive:` should list `requests` (once she has sent something) and nothing from the
   rest of your Drive. rclone keeps its token in `~/.config/rclone/rclone.conf`; keep that file at mode 600.

4. **msmtp with a Gmail app password.** Create an app password at Google Account > Security > App passwords
   (2-Step Verification must be on). Then write `~/.msmtprc`:

   ```
   defaults
   auth           on
   tls            on
   tls_trust_file /etc/ssl/certs/ca-certificates.crt

   account        gmail
   host           smtp.gmail.com
   port           587
   from           YOUR_ADDRESS@gmail.com
   user           YOUR_ADDRESS@gmail.com
   password       YOUR_APP_PASSWORD

   account default : gmail
   ```

   ```sh
   chmod 600 ~/.msmtprc
   printf 'To: YOUR_ADDRESS@gmail.com\nSubject: msmtp test\n\nIt works.\n' | msmtp -t
   ```

5. **The relay config.** The scripts refuse to run if any other user can read it.

   ```sh
   mkdir -p ~/.config/sims-helper-relay && chmod 700 ~/.config/sims-helper-relay
   nano ~/.config/sims-helper-relay/config.json
   chmod 600 ~/.config/sims-helper-relay/config.json
   ```

   ```json
   {
     "to": "YOUR_ADDRESS@gmail.com",
     "rcloneRemote": "simsdrive",
     "webhookUrl": "https://YOUR-T3-WEBHOOK-URL"
   }
   ```

   `webhookUrl` is optional: leave that line out (and the comma before it) for email only. It must be `https://`. The relay POSTs the request JSON to it after the email is sent. If the POST fails
   it is logged and not retried (the email already went out).

6. **Try one run by hand**, then turn on the timer.

   ```sh
   node ~/gfs-sim-helper/relay/m8-relay.mjs      # "No new requests." or "No requests folder yet"

   mkdir -p ~/.config/systemd/user
   cp ~/gfs-sim-helper/relay/systemd/sims-helper-relay.{service,timer} ~/.config/systemd/user/
   command -v node      # if this is not /usr/bin/node, edit ExecStart in the .service file to match
   systemctl --user daemon-reload
   systemctl --user enable --now sims-helper-relay.timer
   sudo loginctl enable-linger "$USER"           # keeps the timer running when you are logged out
   ```

   Check it: `systemctl --user list-timers sims-helper-relay.timer` and
   `journalctl --user -u sims-helper-relay -n 50`.

To update later: `git -C ~/gfs-sim-helper pull`. The timer picks up the new script on its next run.

## Delivering a mod

Put the finished files in one folder: only `.package` and `.ts4script`, no subfolders, no links, each 200 MB at
most, with plain Windows-safe names. Then:

```sh
node ~/gfs-sim-helper/relay/deliver.mjs r-20261126-143000-ab12 ~/mods/outfit-reactions \
  --title "Outfit Reactions" \
  --note "Sims now react to new outfits. Turn on script mods in Game Options." \
  --has-script
```

- The request id is in the email.
- `--title`: 80 characters at most. Her app shows "Tyler made you a mod: <title>" and installs into
  `Mods/From Tyler/<title>/`.
- `--note`: your plain words for her, 1,000 characters at most. Name any mod she must also have (for example
  XML Injector).
- `--has-script`: the mod has a script part. It is turned on by itself when a `.ts4script` file is in the folder.

It checks every file first and uploads nothing if one is wrong. It copies the files to a private temp folder, hashes
the copies (sha256), uploads them to `from-tyler/<id>/files/`, and writes `from-tyler/<id>/ready.json` last. A request
that already has a `ready.json` is refused: a delivery is written once. To redo one, delete
`from-tyler/<id>/` in Drive first (she will not have installed it yet, or Undo it in her History).

## Files on tyler-M8

| Path | What |
|---|---|
| `~/.config/sims-helper-relay/config.json` | to address, rclone remote name, optional webhook URL (mode 600) |
| `~/.msmtprc` | Gmail login with the app password (mode 600, yours only) |
| `~/.config/rclone/rclone.conf` | rclone's Drive token (mode 600) |
| `~/.local/state/sims-helper-relay/seen.json` | ids already emailed (`seen`) or skipped as invalid (`skipped`) |
| `~/.local/state/sims-helper-relay/run.lock` | present only while a run is going |

To send a request's email again, remove its id from `seen.json`.

## Tests

```sh
node --test relay/test/*.test.mjs
```

They use fake `rclone` and `msmtp` scripts (`relay/test/fakes/`) put first on `PATH`, a temp `HOME`, and a temp
folder standing in for Drive. Nothing reaches Google or sends mail.
