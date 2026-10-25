# Sawmill website

The [Sawmill marketing page](https://markdlabrecque.github.io/sawmill/) and brand assets. This directory keeps the website source and built page alongside the software so changes can be reviewed together. GitHub Pages publishes the root of the separate `gh-pages` branch.

## Update the page

From this directory, edit `src/index.html`, then rebuild the standalone page:

```sh
python3 scripts/build.py
```

Preview locally:

```sh
python3 -m http.server 4587 --bind 127.0.0.1
```

Commit the source and rebuilt `index.html` in the software branch. After review, copy this directory's contents to the root of the `gh-pages` worktree and push that branch to publish. Merging into `develop` does not publish the site automatically. The build uses Python's standard library and needs no network access. The generated page embeds its fonts, images, and JavaScript.

## Board preview

The section with `id="board"` uses desktop and phone screenshots of the real Board. Pinecone Pantry, Moonbeam Maps, their paths, and every ticket are fictional. The example shows working and queued tickets plus a logjam with its answer controls open. The build embeds both images so the page stays self-contained.

To refresh the screenshots, run from the repository root with Chrome or Chromium installed:

```sh
npm run build
node website/scripts/capture-board.mjs
python3 website/scripts/build.py
```

Set `SAWMILL_TEST_CHROMIUM` if the browser executable is not in a standard Linux location. The capture script uses a fixed time, checks the sample totals and layout, and writes `assets/board-desktop.png` and `assets/board-mobile.png`. It uses a local fixture, never reads a run store, and refuses command requests. Use `node website/scripts/capture-board.mjs --serve` to inspect the fixture at `http://127.0.0.1:4591/`.

## Brand assets

`assets/sawmill-logo-kit.zip` contains six SVG variants and nine transparent PNGs, plus usage notes and the wordmark font license. Marks are 1024px square with additional primary-mark exports at 256, 512, and 2048px. Wordmarks are 2048px wide, with the lettering outlined in SVG.

The approved logo lives in `src/sawmill-mark.svg`. `src/sawmill-lettering.svg` holds the existing outlined wordmark lettering. The page, favicon, downloads, and kit share these sources. The footer offers the full kit, plus a preview with individual SVG and PNG downloads. The page itself remains self-contained; PNG and ZIP downloads use the adjacent `assets/` folder.

After changing either logo source, regenerate the PNGs, ZIP, and page with:

```sh
python3 scripts/build.py --logo-kit
```

PNG export requires `rsvg-convert` from librsvg. Ordinary page builds still use only Python's standard library.

Font licences for Barlow Condensed and DM Sans are included beside the font files. The page and its illustrations have no external runtime dependencies.

## Verified behavior

The page was checked in Chrome at desktop, 390px phone, and 360px reduced-motion sizes. Verification covered the clean, repair and bounded-logjam demo scenarios; pause and resume; exact-frame animation pause; the ten-second timber loop; keyboard navigation; logo download; and the JavaScript-disabled fallback.
