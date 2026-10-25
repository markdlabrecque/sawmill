# Sawmill website

The Sawmill marketing page and brand assets. GitHub Pages publishes the root of this `gh-pages` branch. The software remains on `main` and `develop`.

## Update the page

Edit `src/index.html`, then rebuild the standalone page:

```sh
python3 scripts/build.py
```

Preview locally:

```sh
python3 -m http.server 4587 --bind 127.0.0.1
```

Commit the source and rebuilt `index.html`, then push `gh-pages` to publish. The build uses Python's standard library and needs no network access. The generated page embeds its fonts, images, and JavaScript.

## Board preview

The section with `id="board"` contains a labelled screenshot placeholder. Replace the `board-placeholder` figure's contents when the redesigned Board is ready. The existing section describes the Board's current capabilities.

## Brand assets

`assets/sawmill-logo-kit.zip` contains six SVG marks and outlined wordmarks. Individual SVGs and the timber mascot are also in `assets/`. The page's footer opens the logo preview and downloads the mark.

Font licences for Barlow Condensed and DM Sans are included beside the font files. The page and its illustrations have no external runtime dependencies.

## Verified behavior

The page was checked in Chrome at desktop, 390px phone, and 360px reduced-motion sizes. Verification covered the clean, repair and bounded-logjam demo scenarios; pause and resume; exact-frame animation pause; the ten-second timber loop; keyboard navigation; logo download; and the JavaScript-disabled fallback.
