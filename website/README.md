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

The section with `id="board"` contains a labelled screenshot placeholder. Replace the `board-placeholder` figure's contents when the redesigned Board is ready. The existing section describes the Board's current capabilities.

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
