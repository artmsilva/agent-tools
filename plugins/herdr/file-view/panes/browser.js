#!/usr/bin/env node
// Pane entrypoint: non-interactive preview of an agent-browser session.
// Connects to the agent-browser WebSocket stream, decodes the base64-JPEG
// `frame` messages, and blits them to the terminal graphics protocol.
//
// Render backends, in order of preference:
//   1. `chafa` — image -> truecolor Unicode blocks (plain SGR text). Works in
//      any pane, including Herdr's multiplexer grid, which does NOT pass the
//      Kitty graphics protocol through. This is the default that actually
//      renders inside Herdr.
//   2. `kitten icat` / `icat` — true graphics; only if the terminal (not a
//      swallowing multiplexer) supports the Kitty graphics protocol.
//   3. native Kitty graphics protocol via macOS `sips` — same graphics caveat.
//
// Watch-only: this pane never sends input back to the browser.
// Skips cleanly (exit 0) when it can't run: no stream port, no render backend,
// or the stream server isn't reachable.

"use strict";

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD_CYAN = "\x1b[1;36m";

function note(msg) {
  process.stdout.write(`${BOLD_CYAN}▎ Agent Browser${RESET}\n\n${msg}\n`);
}

function have(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

// Debug trail (opt-in): HERDR_FILE_VIEW_DEBUG=1 appends lifecycle events to a
// log file so pane behaviour can be inspected from outside the pane.
// Fixed, known path so the log can be read from outside the pane.
const DEBUG_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"),
  "herdr-file-view"
);
const DEBUG_LOG = path.join(DEBUG_DIR, "browser.log");
function dbg(msg) {
  if (!process.env.HERDR_FILE_VIEW_DEBUG) return;
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `${msg}\n`);
  } catch {}
}

// --- Preconditions ----------------------------------------------------------

// The running stream picks an OS-assigned port unless overridden, so the live
// `stream status` is the source of truth — an AGENT_BROWSER_STREAM_PORT env var
// can be stale. Prefer status; fall back to the env var. Re-resolved on every
// (re)connect so the pane follows the stream if it restarts on a new port.
function resolveWsUrl() {
  if (have("agent-browser")) {
    const r = spawnSync("agent-browser", ["stream", "status"], { encoding: "utf8" });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    const m = out.match(/ws:\/\/[\w.-]+:(\d+)/) || out.match(/:(\d{2,5})\b/);
    if (/enabled/i.test(out) && m) return `ws://127.0.0.1:${m[1]}`;
  }
  if (process.env.AGENT_BROWSER_STREAM_PORT) {
    return `ws://127.0.0.1:${process.env.AGENT_BROWSER_STREAM_PORT}`;
  }
  return null;
}

// Only truly skip (exit 0) when there's no way to ever get a stream.
if (!have("agent-browser") && !process.env.AGENT_BROWSER_STREAM_PORT) {
  note(
    "agent-browser not found and no AGENT_BROWSER_STREAM_PORT set — nothing to\n" +
      "preview. Install agent-browser and run `agent-browser stream enable`,\n" +
      "then reopen this pane."
  );
  process.exit(0);
}

if (typeof WebSocket === "undefined") {
  note(
    "This Node build has no global WebSocket (needs Node >= 21).\n" +
      "Upgrade Node to use this pane."
  );
  process.exit(0);
}

// Is Herdr configured to pass the Kitty graphics protocol through? By default
// Herdr's grid drops it (blank pane); the experimental flag enables it, which
// lets true-graphics backends render crisp instead of chafa's text blocks.
function herdrKittyGraphics() {
  try {
    const cfg =
      process.env.HERDR_CONFIG_PATH ||
      path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "herdr", "config.toml");
    return /^\s*kitty_graphics\s*=\s*true/m.test(fs.readFileSync(cfg, "utf8"));
  } catch {
    return false;
  }
}

// Pick a render backend. Auto: true graphics (crisp) when Herdr passes the
// Kitty protocol through, else chafa (text blocks, works in any grid).
// HERDR_FILE_VIEW_RENDER forces one of: chafa | kitten | native.
function detectBackend() {
  const kitten = () => (have("kitten") ? { kind: "kitten", cmd: "kitten", pre: ["icat"] } : have("icat") ? { kind: "kitten", cmd: "icat", pre: [] } : null);
  const native = () => (have("sips") ? { kind: "native" } : null);
  const chafa = () => (have("chafa") ? { kind: "chafa" } : null);

  const force = process.env.HERDR_FILE_VIEW_RENDER;
  if (force === "chafa") return chafa();
  if (force === "kitten") return kitten();
  if (force === "native") return native();

  const graphics = kitten() || native();
  if (herdrKittyGraphics() && graphics) return graphics;
  return chafa() || graphics;
}

const backend = detectBackend();
dbg(`--- start pid=${process.pid} term=${process.env.TERM || ""} tp=${process.env.TERM_PROGRAM || ""} cols=${process.stdout.columns} rows=${process.stdout.rows} kittygfx=${herdrKittyGraphics()} backend=${backend ? backend.kind : "none"}`);
if (!backend) {
  note(
    "No image renderer found.\n\n" +
      "Install `chafa` for in-pane preview:  brew install chafa\n" +
      "(chafa renders frames as text, so it works inside Herdr.)\n" +
      "The active-file pane works without any renderer."
  );
  process.exit(0);
}

note(`${DIM}connecting to agent-browser stream …${RESET}`);

// --- Frame rendering --------------------------------------------------------

let busy = false; // drop frames while a blit is in flight (avoids backlog)

// Backend: chafa renders the JPEG (on stdin) as truecolor Unicode blocks sized
// to the pane. Plain SGR text — survives Herdr's grid.
function blitChafa(jpeg) {
  const cols = process.stdout.columns || 80;
  const rows = (process.stdout.rows || 24) - 1; // leave the top header row
  process.stdout.write("\x1b[H");
  const args = ["--format", "symbols", "--colors", "full", "--size", `${cols}x${rows}`, "--animate", "off", "--clear", "-"];
  const child = spawn("chafa", args, { stdio: ["pipe", "inherit", "ignore"] });
  child.on("error", (e) => {
    dbg(`chafa error: ${e}`);
    busy = false;
  });
  child.on("close", (code) => {
    dbg(`blit chafa: jpeg=${jpeg.length} size=${cols}x${rows} exit=${code}`);
    busy = false;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(jpeg);
}

// Backend: kitten icat reads JPEG on stdin and draws it (true graphics).
function blitKitten(jpeg) {
  process.stdout.write("\x1b[H");
  const args = [...backend.pre, "--stdin", "yes", "--align", "left", "--clear"];
  const child = spawn(backend.cmd, args, { stdio: ["pipe", "inherit", "ignore"] });
  child.on("error", () => (busy = false));
  child.on("close", () => (busy = false));
  child.stdin.on("error", () => {}); // ignore EPIPE if icat exits early
  child.stdin.end(jpeg);
}

// Backend 2: convert JPEG->PNG with sips, emit the Kitty graphics protocol.
const TMP_JPG = path.join(os.tmpdir(), "herdr-fv-frame.jpg");
const TMP_PNG = path.join(os.tmpdir(), "herdr-fv-frame.png");

function emitKittyProtocol(png) {
  const b64 = png.toString("base64");
  const cols = process.stdout.columns || 80;
  const CHUNK = 4096;
  // Clear prior image, home the cursor, transmit+display, fit to width.
  let out = "\x1b[H\x1b_Ga=d\x1b\\";
  const first = b64.slice(0, CHUNK);
  const more = b64.length > CHUNK ? 1 : 0;
  out += `\x1b_Gf=100,a=T,c=${cols},m=${more};${first}\x1b\\`;
  for (let i = CHUNK; i < b64.length; i += CHUNK) {
    const chunk = b64.slice(i, i + CHUNK);
    const m = i + CHUNK < b64.length ? 1 : 0;
    out += `\x1b_Gm=${m};${chunk}\x1b\\`;
  }
  process.stdout.write(out);
}

function blitNative(jpeg) {
  fs.writeFile(TMP_JPG, jpeg, (werr) => {
    if (werr) return void (busy = false);
    const child = spawn("sips", ["-s", "format", "png", TMP_JPG, "--out", TMP_PNG], {
      stdio: "ignore",
    });
    child.on("error", () => (busy = false));
    child.on("close", (code) => {
      if (code === 0) {
        try {
          const png = fs.readFileSync(TMP_PNG);
          emitKittyProtocol(png);
          dbg(`blit native: jpeg=${jpeg.length} png=${png.length} cols=${process.stdout.columns}`);
        } catch (e) {
          dbg(`blit native emit error: ${e}`);
        }
      } else {
        dbg(`sips exit ${code}`);
      }
      busy = false;
    });
  });
}

function blit(jpeg) {
  if (busy) return;
  busy = true;
  if (backend.kind === "chafa") blitChafa(jpeg);
  else if (backend.kind === "kitten") blitKitten(jpeg);
  else blitNative(jpeg);
}

// --- Connection loop --------------------------------------------------------
// The pane stays alive: if streaming isn't up yet (or drops), it shows a hint
// and keeps polling, connecting automatically once the stream is available.
// It never exits on a transient failure — a preview pane that vanishes reads
// as a crash.

function waiting(msg) {
  process.stdout.write("\x1b[2J");
  note(`${DIM}${msg}${RESET}`);
}

function tick() {
  const url = resolveWsUrl();
  if (!url) {
    waiting(
      "streaming not enabled — run `agent-browser stream enable`, then this\n" +
        "pane will connect automatically…"
    );
    setTimeout(tick, 2000);
    return;
  }
  connect(url);
}

function connect(url) {
  dbg(`connect ${url}`);
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let opened = false;
  let frames = 0;

  ws.addEventListener("open", () => {
    opened = true;
    dbg("ws open");
    process.stdout.write("\x1b[2J\x1b[H"); // clear the "connecting" note
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg =
        typeof ev.data === "string"
          ? JSON.parse(ev.data)
          : JSON.parse(Buffer.from(ev.data).toString("utf8"));
    } catch {
      return;
    }
    if (msg.type === "frame" && typeof msg.data === "string") {
      frames += 1;
      if (frames === 1 || frames % 30 === 0) dbg(`frame #${frames} b64=${msg.data.length}`);
      blit(Buffer.from(msg.data, "base64"));
    } else if (msg.type === "status") {
      dbg(`status connected=${msg.connected} screencasting=${msg.screencasting}`);
    }
    // Other types (tabs, ...) are ignored for display.
  });

  ws.addEventListener("error", (e) => {
    dbg(`ws error ${e && e.message ? e.message : ""}`);
    try {
      ws.close();
    } catch {}
  });

  ws.addEventListener("close", () => {
    dbg(`ws close (opened=${opened}, frames=${frames})`);
    if (!opened) waiting(`waiting for stream at ${url} …`);
    setTimeout(tick, 1000);
  });
}

tick();
