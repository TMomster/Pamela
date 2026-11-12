# Pamela

Author: Momster ([github.com/TMomster](https://github.com/TMomster)).

中文版本请查阅： [`Readme中文.md`](Readme中文.md).

A visual-novel engine and authoring environment. Rust + Tauri 2 provide the host and the
file system; the front end is plain ES modules, with no bundler and no runtime dependency,
embedded into the executable by Tauri.

- **Script language**: `.pe` / `.mpe` scripts. Lexer, parser and interpreter all live in
  `ui/pamela.js`; the shorthand form is handled by `ui/mpe.js`.
- **Authoring**: code editor (highlighting, find/replace, inline errors, whole-line
  shortcuts), dialogue designer, image and audio editors, `.pmap` node canvas (flowmap),
  keyframe editor, resource tree and multi-tab editing.
- **Staging objects**: `Character`, `Background`, `Text`, `Audio`, `Video`, `Effect`
  (particles), `Light` (2.5D lighting with ambient brightness and exclusion), plus the
  3D-space and filter calls they share.
- **Run and preview**: stage playback, save/load, auto / skip / backlog, fullscreen,
  and an editor ⇄ player mode switch for the finished product.
- **Export to video**: the script is performed frame by frame offscreen; frames are
  encoded to H.264 through WebCodecs, sound is mixed offline to 48 kHz stereo AAC with
  `OfflineAudioContext`, and a hand-written MP4 muxer writes the result into `exports/`.
  The sound and picture of `Video` assets, particles, filters and colour grading all make
  it into the exported file. Optional entry script, frame rate and choice strategy are
  remembered across launches.
- **Finishing touches**: an optional `stage.pamela()` opening animation, and auto save at
  off / 30 s / 1 min / 3 min / 5 min, remembered across launches.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | Rust back end: project model (`project.rs`), file and path safety (`files.rs`), Tauri commands (`commands/`), MP4 multi-track muxing (`mp4.rs`, video + audio `mdat`) and streaming writes (`export.rs`) |
| `ui/` | Front-end modules; `main.js` is the only composition root, the rest are pure logic modules and widget factories (the export chain is `ui/export-*.js`, including the offline mixdown in `export-audio.js`) |
| `ui/tests/` | `node:test` unit tests over pure functions and a hand-written fake DOM |
| `docs/` | Local working notes, not tracked: design decisions and per-stage records |
| `tools/` | Icon generation, real-browser smoke runs (`smoke-*.mjs`) and the offline export micro-benchmark (`bench-export.mjs`) |
| `scripts/` | Build helpers (Windows SDK path and similar) |
| `capabilities/` | Tauri permissions: only window dragging, maximize toggling and folder selection |

## Status

Version `1.0.0`. Export produces a finished file with both picture and sound. The
automated baseline passes: JavaScript syntax, front-end unit tests, Rust tests,
`cargo fmt --check`, `clippy -D warnings` and the `tsc` type check. Checks that need a real
window — fullscreen, sound, save/load, export playback — are run locally and are not part
of the repository.

User-facing documentation ships inside the application (Help → export MP4 and the rest of
the manual). Design notes and per-stage verification records live in a local `docs/`
folder that is not part of the repository.

## Build and check

```bat
cargo run --offline                :: debug build, launches the editor
cargo build --release --offline    :: release build, target\release\pamela.exe

node --test "ui/tests/*.test.js"   :: front-end unit tests
cargo test --offline               :: back-end tests
cargo fmt --check
cargo clippy --offline --all-targets -- -D warnings
npx tsc -p tsconfig.json           :: static types
```

A Windows build needs `rc.exe` from the Windows SDK on `PATH`: tauri-build uses it to
embed the resource file. The scripts that set that up for this machine, and the local
manual checklist, stay on the author's machine and are deliberately not in the repository.

`tsc` needs one `npm install` first; TypeScript is a development-only dependency and never
enters the product.

## Conventions

- **Zero dependencies, no bundler**: files under `ui/` are loaded the way a browser would,
  with `frontendDist: ./ui`.
- **Single composition root**: only `ui/main.js` wires modules together; new features
  should be injectable-dependency factories so they can be tested against a fake DOM.
- **Documented stages**: every stage ends with a `docs/YYYY-MM-DD-<topic>.md` record, whose
  conclusions are folded back into `docs/progress.md` and the index.
- **No test count is pinned**: suites are described as passing rather than recorded as a
  fixed number, so adding a case never turns a green run into a false failure.

## In-app help

The toolbar entries **Help** and **About** open a built-in read-only reader, available on
first launch before any project exists:

- **Help**: basics, the script language overview, and dedicated articles for `Character`,
  `Background`, `Text`, `Audio`, `Video`, `Effect`, `Light`, the 3D space, `mpe`
  shorthand, Chinese spelling, API cross-reference, flowmap, keyframes, template editing
  and export MP4 (including what matches the stage, what is drawn, and current limits).
- **About**: notice (author, ownership of works, disclaimer and content responsibility),
  license, about this software, terms of use and privacy policy.

## License and ownership

Pamela is released as open source under MIT or Apache-2.0, at your option. Copyright is
held by the author, [Momster](https://github.com/TMomster).

- English originals: [`LICENSE-MIT`](LICENSE-MIT) and [`LICENSE-APACHE`](LICENSE-APACHE)
- Chinese reference translation: [`LICENSE-ZH.md`](LICENSE-ZH.md) (the English original
  prevails on any discrepancy)

Scripts, images, audio, templates and project files edited with Pamela are owned
entirely by the person who made them, including copyright. Pamela and its author claim no
ownership of, and no rights over, the creator's assets or their content.

## Related files

- Chinese documentation: [`Readme中文.md`](Readme中文.md) (same content as this file)
- Chinese license translation: [`LICENSE-ZH.md`](LICENSE-ZH.md)
