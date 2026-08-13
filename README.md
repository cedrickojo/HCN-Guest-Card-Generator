# HCN Card Studio

Two browser-based editors sharing one canvas renderer and one background-removal
pipeline:

| Route | Tool |
| --- | --- |
| `/` | **Guest cards** — HCN guest announcement cards |
| `/thumbnail` | **Thumbnails** — 16:9 YouTube thumbnails |

Routing is a ~40-line hand-rolled router (`src/router.jsx`) on real paths, so
`vercel.json` rewrites anything that isn't a file on disk back to `index.html`.

## Guest cards

Same renderer as the `hcn-guest-card` skill — same texture, glow, grade, scrim
and type metrics — but with direct manipulation instead of `--nudge 1 0 -120`.

## What it does

- **Headshots** — drop in any number, backgrounds come off automatically, the
  PSD grade (desaturate 24%, levels 36/1.26/207) is applied on import.
- **Direct manipulation** — drag anything on the card. Scroll to scale a selected
  headshot; arrow keys nudge (shift for coarse).
- **Layers** — reorder headshots front to back; the group gets one shared coral
  glow and a soft separation shadow under each overlap, as in the original.
- **Accent colour** — the gradient, glow and border recolour together; the scrim
  and type stay put.
- **Three text fields** — independent size, alignment, position, show/hide. Use
  `||` in any field to force a line break.
- **Optional company plate** — white rounded plate that sizes to the logo's
  aspect. Logos are auto-trimmed to their ink, so press-kit PNGs with acres of
  white padding work as-is.
- **Aspect ratios** — 3:4, 4:5, 1:1, 9:16, 16:9. Positions are stored normalised,
  so switching ratio moves things proportionally rather than resetting them.
- **Presets** — save and reload everything except the images as JSON.

Export renders at full reference resolution (2160x2880 for 3:4) through the exact
same `drawCard()` used for the preview. What you drag is what you download.

## Thumbnails

Locked to 16:9, reference space 1280x720. Layers bottom to top: background fill,
background image, vignette, cutouts, text.

- **Headshots** — any number, backgrounds come off on import and *nothing else is
  applied* (no PSD grade — these are thumbnails, not cards). Drag to position,
  scroll to scale, reorder front to back. Each one has an optional coral halo
  using the same square-root falloff as the guest cards, with its own colour,
  size and strength.
- **Background** — any image, cover-fitted, with zoom and pan plus brightness,
  contrast and saturation. Falls back to a flat fill colour.
- **Vignette** — independent strength per side, or all four at once, with a
  shared softness and colour. Smoothstep falloff, because a linear ramp leaves a
  visible band where it meets the untouched middle. Sits under the cutouts by
  default so faces stay lit; tick *Over headshots* to frame the whole composition.
- **Text** — any number of blocks, each with its own font, size, colour,
  alignment, line spacing and uppercase toggle. Newlines or `||` break lines.
  Any block can carry a highlight: a rounded plate behind each line, sized off
  the glyph bounding box so it hugs the cap height rather than the font's full
  line box. Keep a highlighted line as its own block, as in the DOAC reference.
- **Export** — 1280x720 or 1920x1080, PNG or JPEG. The last export's file size is
  shown, with a warning past YouTube's 2MB ceiling.

Fonts are the two bundled brand faces plus Arial Black, Impact and the system
sans. The latter three resolve on the designer's machine, so a thumbnail built
on a Mac may set differently on a Windows box.

As with the cards, `drawThumb()` renders both the preview and the export, and
its scale is strictly proportional to output width — text geometry is identical
at 1024, 1280 and 1920 to within rounding.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/
```

## Deploy to Vercel

```bash
npm i -g vercel
vercel            # first deploy, accept the detected Vite settings
vercel --prod
```

`vercel.json` sets the framework, output directory, long-lived cache headers on
brand assets, and `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`.
Those two enable `SharedArrayBuffer`, which lets the ONNX runtime use multiple
threads — without them cutouts still work, just slower. `credentialless` is used
rather than `require-corp` so the cross-origin model fetch isn't blocked.

No serverless functions, no environment variables, no API keys.

## Why background removal runs in the browser

Vercel's Python functions cap at 250MB unzipped. `onnxruntime` plus the
`isnet-general-use` model the skill uses is roughly 180MB of model alone before
numpy, OpenCV and Pillow — it does not fit, and every cold start would re-download
it. Running the model in WASM on the client removes the size limit, the cold
start, the per-image cost and the privacy question: images never leave the
machine. The trade is a one-time ~40MB model download, cached by the browser
afterwards, and a few seconds per cutout on a mid-range laptop.

## Licence warning — read this before making the app public

`@imgly/background-removal` is **AGPL-3.0**. Section 13 means that if you let
other people use this over a network, you must offer them the source. That is
fine for an internal HCN tool, and fine if you just make the repo public. It is
not fine for a closed commercial product. IMG.LY sells commercial licences.

To swap it out, replace the body of `src/removeBg.js` — nothing else in the app
touches it. The contract is `(File, onProgress) => Promise<Blob>`. Options:

| Option | Licence | Trade-off |
| --- | --- | --- |
| `@imgly/background-removal` (current) | AGPL-3.0 | Best UX, ~40MB model |
| `onnxruntime-web` + `u2net_human_seg.onnx` | Apache-2.0 | Permissive, but ~176MB download and you write the pre/post-processing |
| Your own endpoint running the skill's Python pipeline | yours | Identical output to the CLI; needs a host that isn't Vercel |
| remove.bg / Replicate | commercial | Per-image cost, needs a key proxy |

**Fonts are the other licence question.** `F37 Analog` and `RL Okima` are served
from `public/assets/` as raw OTFs, which means anyone can download them from the
deployed site. A desktop licence does not usually cover web embedding. Check the
EULAs before this goes on a public URL; a private deployment or Vercel password
protection sidesteps it.

## Known limits

- Full-resolution export takes a few seconds — the coral glow needs a real blur
  plus a per-pixel square-root curve over 6.2M pixels. Status shows while it runs.
- No automatic head-size matching. The CLI uses OpenCV face detection to
  normalise head heights across guests; here you scale by eye, which is faster
  once you've done it twice.
- Headshots under ~1000px on the short side will look soft at export size. The
  app flags anything under 500px on import.
