# touchdesigner-asset-transfer

A TouchDesigner plugin that receives files from teammates with
[croc](https://github.com/schollz/croc) and moves each one into the artwork
folder of the exhibition you pick. Senders don't need Dropbox or any other
shared account. They run one command and read you a code phrase.

It's built for [node-pa-td](../node-pa-td) as a **global plugin**: copy
`dist/assetTransfer.tox` into `node-pa-td/plugins/` on the Control machine.
That folder is gitignored, so install it by hand. It does not run the artwork
scan; run the scan in Control once the files are in place.

## How it works

1. A teammate runs `croc --no-compress send <file>` and gives you the code
   phrase. See [docs/sending.md](docs/sending.md).
2. Enter the code in the plugin and press **Receive**. croc downloads into
   `<staging>/<transfer-id>/` (default `~/Downloads/asset-transfer/`).
3. For each received file, pick an exhibition and press **Move**. The file
   goes to `depository/exhibitions/<id>/artwork/<name>`.
4. In Control, run the artwork scan.

### Rules it enforces

- **The code phrase is never on the command line.** It goes to croc in the
  `CROC_SECRET` environment variable, the parameter is cleared once the receive
  starts, and the code and relay password are scrubbed from every logged line.
- **It never overwrites anything.** If a file with the same name is already
  in the artwork folder, the move is refused and the reason is shown.
- **The scan never sees half-written files.** Files are staged outside
  `artwork/`, and that scan is recursive. A same-drive move is a single
  rename. A cross-drive move copies to a hidden `.<name>.partial` file and
  renames it into place when the copy is done.
- **`.tox` files are flagged.** A `.tox` runs code on every render, so the
  plugin warns before you move one. Files the scan won't pick up are flagged
  too.
- **Every refused action shows its reason.** Nothing fails silently.

## Layout

| Path | What |
|---|---|
| `AssetTransfer/transfer.py` | All croc, staging and move logic. **No TouchDesigner import**, so it runs and is tested in plain Python. |
| `AssetTransfer/AssetTransferExt.py` | The extension on the `AssetTransfer` COMP. Workers post to a queue that `Tick()` drains on the main thread. |
| `AssetTransfer/exec_frame.py` | Execute DAT that calls `Tick()` every frame. |
| `AssetTransfer/parexec_assettransfer.py` | Passes pulse parameters to the extension. |
| `tests/` | `python3 -m unittest discover -s tests` (stdlib only, uses `fake_croc.py`). |
| `dist/assetTransfer.tox` | The built plugin to copy into `node-pa-td/plugins/`. |

### COMP parameters (page "Transfer")

| Parameter | Type | Meaning |
|---|---|---|
| `Code` | str | Code phrase from the sender (cleared once the receive starts) |
| `Receive`, `Cancel`, `Refresh`, `Openstaging` | pulse | Actions |
| `Crocpath` | file | Path to `croc.exe`. If blank, it looks on PATH, then in the Scoop and Chocolatey install folders. |
| `Relay`, `Relaypass` | str | Optional self-hosted relay (`host:9009`). Leave blank for croc's public relay. |
| `Stagingfolder` | folder | If blank, uses `~/Downloads/asset-transfer`. Put it on the same drive as the depository so moves are instant. |
| `Depositoryfolder` | folder | If blank, it searches upward from the project folder for `depository/exhibitions`. |

## croc

Pinned to **v11.5.5** (released 2026-10-19), installed by hand on Control.
Download `croc_v11.5.5_Windows-64bit.zip` from the release page, check its
SHA-256 against that release's `croc_v11.5.5_checksums.txt`, and unpack
`croc.exe` somewhere stable. Point `Crocpath` at it, or put it on PATH.

Checked 2026-11-06 on macOS with Homebrew **croc 11.6.4** (newer than the
pin), with a loopback receive through a local `croc relay` and the plugin's
`Relay` parameter:

- [x] receive accepts `--yes --overwrite --out <dir>`
- [ ] `CROC_SECRET` is honoured on **Windows**. It works on macOS: the
      receive used it and the code was not on the command line. Still to try
      on Control.
- [x] the progress bar is printed when output is a pipe. The plugin parsed
      it up to 100%.
- [x] `--pass` is the client flag for a password-protected relay (`croc --help`:
      `--pass value  password for the relay [$CROC_PASS]`). Not yet tried
      against a relay that has a password.

Re-check the first three against v11.5.5 on Control before relying on them.

`--no-compress` is a **global** flag. It goes before `send`
(`croc --no-compress send <file>`). `croc send --no-compress` fails with
`flag provided but not defined`.
