// Small terminal helpers: colour, a line prompt, a single-choice list and the
// computer's own file picker. Keys: ↑/↓ (or j/k) move, enter accepts, q/esc/ctrl-c quits.

const { stdin, stdout } = process;

export const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
  highlight: "\x1b[48;5;237m\x1b[97m",
};
export const paint = (text: string, code: string) => `${code}${text}${c.reset}`;

export class Quit extends Error {
  constructor() { super("quit"); }
}

// Splits raw input into keys: escape sequences (arrows are "\x1b[A") stay whole,
// everything else is one character per key.
export function splitKeys(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const seq = text[i] === "\x1b" ? /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(text.slice(i)) : null;
    if (seq) {
      out.push(seq[0]);
      i += seq[0].length - 1;
    } else {
      out.push(text[i]);
    }
  }
  return out;
}

// Reads keys in raw mode until `onKey` returns a value other than undefined.
export async function keys<T>(render: () => void, onKey: (key: string) => T | undefined): Promise<T> {
  if (!stdin.isTTY) throw new Error("this step needs an interactive terminal");
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?25l");
  render();
  try {
    return await new Promise<T>((resolve, reject) => {
      const handler = (buf: Buffer) => {
        // One read can hold several keys (fast typing, a paste), so handle each.
        for (const key of splitKeys(buf.toString())) {
          if (key === "\x03" || key === "q" || key === "\x1b") {
            stdin.off("data", handler);
            reject(new Quit());
            return;
          }
          const result = onKey(key);
          if (result !== undefined) {
            stdin.off("data", handler);
            resolve(result);
            return;
          }
        }
        render();
      };
      stdin.on("data", handler);
    });
  } finally {
    stdout.write("\x1b[?25h");
    stdin.setRawMode(false);
    stdin.pause();
  }
}

const UP = new Set(["\x1b[A", "k"]);
const DOWN = new Set(["\x1b[B", "j"]);

// Redraws a block of lines in place.
export function block() {
  let drawn = 0;
  return (lines: string[]) => {
    if (drawn) stdout.write(`\x1b[${drawn}A`);
    for (const line of lines) stdout.write(`\x1b[2K${line}\n`);
    drawn = lines.length;
  };
}

export async function choose(title: string, options: string[], start = 0): Promise<number> {
  let at = start;
  const draw = block();
  return keys(
    () => draw([paint(title, c.bold), ...options.map((o, i) =>
      i === at ? `${c.highlight} › ${o} ${c.reset}` : `   ${o}`), paint("↑/↓ move · enter choose · q quit", c.dim)]),
    (key) => {
      if (UP.has(key)) at = (at + options.length - 1) % options.length;
      else if (DOWN.has(key)) at = (at + 1) % options.length;
      else if (key === "\r" || key === "\n") return at;
      return undefined;
    },
  );
}

// A list of rows the user can toggle with space. `toggle(i)` changes row i and
// returns false when that row cannot change. Enter accepts.
export async function toggleList(title: string, rows: () => string[], toggle: (i: number) => boolean,
  footer: string): Promise<void> {
  let at = 0;
  const draw = block();
  await keys(
    () => {
      const list = rows();
      draw([paint(title, c.bold), ...list.map((r, i) => i === at ? `${c.highlight} › ${r} ${c.reset}` : `   ${r}`),
        paint(footer, c.dim)]);
    },
    (key) => {
      const n = rows().length;
      if (UP.has(key)) at = (at + n - 1) % n;
      else if (DOWN.has(key)) at = (at + 1) % n;
      else if (key === " ") toggle(at);
      else if (key === "\r" || key === "\n") return true;
      return undefined;
    },
  );
}

export async function ask(question: string, fallback = ""): Promise<string> {
  stdout.write(question + (fallback ? paint(` [${fallback}]`, c.dim) : "") + " ");
  for await (const line of console) {
    return line.trim() || fallback;
  }
  return fallback;
}

// Splits pasted or dragged paths: quotes, and backslash-escaped spaces as a Mac
// terminal writes them when you drag files in.
export function splitPaths(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "\\" && process.platform !== "win32" && i + 1 < text.length) {
      cur += text[++i];
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// The computer's own picker. kind "files" allows several files; "folder" one
// folder. Returns paths, [] when cancelled, or null when there is no picker.
export async function pick(kind: "files" | "folder"): Promise<string[] | null> {
  let command: string[];
  if (process.platform === "darwin") {
    const choose = kind === "files"
      ? 'set chosen to choose file with prompt "Send to Control" with multiple selections allowed'
      : 'set chosen to {choose folder with prompt "Send to Control"}';
    command = ["osascript",
      "-e", "set terminal to (path to frontmost application as text)",
      "-e", 'set out to ""',
      "-e", "try",
      "-e", 'tell application "System Events"',
      "-e", "activate",
      "-e", choose,
      "-e", "end tell",
      "-e", "repeat with f in chosen",
      "-e", "set out to out & POSIX path of f & linefeed",
      "-e", "end repeat",
      "-e", "end try",
      "-e", "tell application terminal to activate",
      "-e", "return out"];
  } else if (process.platform === "win32") {
    const script = kind === "files"
      ? "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; "
        + "$d.Multiselect = $true; $d.Title = 'Send to Control'; if ($d.ShowDialog() -eq 'OK') { $d.FileNames }"
      : "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; "
        + "$d.Description = 'Send to Control'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }";
    command = ["powershell", "-NoProfile", "-STA", "-Command", script];
  } else if (Bun.which("zenity")) {
    command = kind === "files"
      ? ["zenity", "--file-selection", "--multiple", "--separator=\n", "--title=Send to Control"]
      : ["zenity", "--file-selection", "--directory", "--title=Send to Control"];
  } else {
    return null;
  }
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const text = await new Response(child.stdout).text();
    await child.exited;
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}
