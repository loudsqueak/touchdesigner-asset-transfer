# Sending a file to the Control machine

You need croc installed. Nothing else, and no accounts.

| OS | Install |
|---|---|
| macOS | `brew install croc` |
| Windows | `scoop install croc`, or download the zip from the [releases page](https://github.com/schollz/croc/releases) |
| Linux | your package manager, or the releases page |

Then:

```sh
croc --no-compress send path/to/artwork.mp4
```

- croc prints a **code phrase** like `7-alpha-bravo-charlie`. Read it to
  whoever is at Control, who enters it in the Asset Transfer plugin.
- **Keep your computer awake and online until croc says it's done.** The file
  comes straight from your machine. Nothing is uploaded ahead of time.
- `--no-compress` is faster for video and images, which are already
  compressed.
- You can send several files, or a folder, at once:
  `croc --no-compress send a.mp4 b.mov`.
- If you're on the venue network, the transfer goes directly over the LAN
  and runs at full speed. From elsewhere it goes through croc's relay, so
  your upload speed sets the pace.
- If the transfer is interrupted, run the same command again. croc resumes
  where it stopped.
