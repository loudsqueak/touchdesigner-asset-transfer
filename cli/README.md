# send: put files into an exhibition on Control

A terminal tool for sending artwork (and exhibition plugins) to the Control
machine. You pick files, a folder or a zip. You pick the exhibition. It sends
with croc and tells the Asset Transfer plugin on Control the code, so nobody
has to read a code phrase out. Control receives the files, unzips them if
needed, and puts each one in place. Nothing on Control is ever overwritten.

Needs [Bun](https://bun.sh) and croc (`brew install croc` on macOS). It has no
other dependencies.

To run it from anywhere as `transfer`, link it onto your PATH once:

```sh
ln -s "$PWD/cli/transfer" ~/.local/bin/transfer   # from the repo root
transfer               # the wizard  (= bun run cli)
transfer send ...      # scriptable  (= bun run send ...)
transfer setup         #             (= bun run setup)
```

## One-time setup

The Asset Transfer panel on Control shows a line like
`SEND CLI  http://10.20.90.231:8004   token abcd-efgh-jkmn-pqrs`.

```sh
cd cli
bun run setup      # asks for the addresses and tokens, checks each route, saves cli/settings.json
                   # (or use Settings inside the wizard, `bun run cli`)
```

There are two ways to reach Control. `send` uses the LAN one when Control
answers there, and otherwise falls back to the remote one:

| Route | Address | Also needs |
|---|---|---|
| LAN | the `http://…:8004` address on the panel | the plugin token |
| Remote (offsite) | `https://pa-touchdesigner-assettransfer.nodefoundation.com` | the plugin token **and** a Cloudflare Access service token (Client ID + Secret) |

A fleet admin creates the service token with the `access` tool:
`access token grant asset-transfer pa-pc-rtx4000-1 assettransfer`. The secret
is printed once.

Environment variables override the saved values: `ASSET_TRANSFER_URL`,
`ASSET_TRANSFER_REMOTE_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`
and `ASSET_TRANSFER_TOKEN`.

## The wizard

```sh
bun run cli
```

This opens a full-screen app, in the same style as touchdesigner-control's
`bun run cli`. The top line always shows how Control is reached: `● on the LAN`,
`● remote via Cloudflare`, or `○` with the reason it can't be reached.

| Screen | What you do |
|---|---|
| Home | Send files…, Send a folder…, Paste or drag paths, or open Settings. |
| Basket | Space switches a file between `artwork/` and `plugins/`. Also: `a` add files, `f` add a folder, `p` paste, `d` remove. |
| Exhibition | Type to filter, then press enter to choose. |
| Review | Shows everything that will happen. Press enter to send. |
| Sending | Shows the route, whether the files go directly over the LAN or through croc's relay, a progress bar, then ✓/✗ per item. |
| Settings | Edit the addresses and tokens in place. `t` tests both routes. On first run it opens here. |

↑/↓ move, enter goes forward, esc goes back, and ctrl-c quits.

## Sending from the command line

For scripts and quick one-off sends:

```sh
bun run send                          # pick files / a folder, or paste paths
bun run send ~/Desktop/piece clip.mp4 # or name them
bun run send pack.zip -e summer_sJJcK # and skip the exhibition question
```

1. **Where each item goes.** Every top-level item is listed. Space switches a
   file between `artwork/` and `plugins/`. A loose `.tox` is flagged so you
   decide: it can be an artwork or an exhibition plugin. A plugin's own files
   are loose siblings of its `.tox`, so mark those as plugin too.
   **Folders always go to `artwork/<folder>/`** with their layout kept, so a
   `.tox` and its assets in one folder keep working. A **zip** is unpacked on
   Control, and its top-level entries are listed and routed the same way.
2. **Which exhibition.** These are read from Control's depository.
3. **Send.** It first says how it reached Control: `on the LAN` or
   `remotely through Cloudflare`. croc then sends with a fresh one-time code,
   and once connected it says whether the files go `directly over the LAN` or
   `through croc's relay over the internet`. The progress line is tagged
   `[LAN]` or `[relay]`. Control receives the files
   and places them, and you get one line per item: ✓ with where it landed, or
   ✗ with why it was not placed. Anything not placed stays in Control's
   staging folder, where the plugin panel shows it for a manual Move.

After artwork lands, run the artwork scan in Control. Plugins in an
exhibition's `plugins/` load with that exhibition.

## When something goes wrong

| Message | Fix |
|---|---|
| `cannot reach the Asset Transfer plugin (tried …)` | The plugin is not loaded, an address is wrong, or the API is off (Api page on the plugin). Offsite, check the remote address and service token. |
| `Cloudflare Access refused this computer` | The service token Client ID or Secret is wrong or expired. Run `bun run setup` again. |
| `missing or wrong token` | Run `bun run setup` again with the token from the panel. |
| `… already exists in <exhibition>/artwork` | Rename the file, or remove the old one on Control first. |
| `croc stopped before sending` | croc's own error is shown under it. Check that croc is installed and that you are online. |

## Tests

```sh
bun test
```
