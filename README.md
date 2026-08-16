# media-mvp

A self-hosted image transformation service — the first step toward an
open-source Cloudinary alternative. Already tested and working: resizes,
converts format, and caches the result so the same request is never
processed twice.

Source images and the result cache are read/written from S3-compatible
storage (AWS S3, Cloudflare R2, MinIO...), configured via environment
variables.

## Environment variables

| Variable | Description | Example (local MinIO) |
| --- | --- | --- |
| `S3_ENDPOINT` | S3 endpoint URL. Leave empty for real AWS S3. | `http://localhost:9000` |
| `S3_REGION` | Region. | `us-east-1` |
| `S3_BUCKET` | Bucket where source images and the cache (`cache/...`) live. | `media-mvp` |
| `S3_ACCESS_KEY_ID` | Access key. | `minioadmin` |
| `S3_SECRET_ACCESS_KEY` | Secret key. | `minioadmin` |
| `S3_FORCE_PATH_STYLE` | `true` for MinIO/backends without virtual-hosted style. `false` on real AWS S3. | `true` |
| `API_KEY` | Key required for authentication (see the Authentication section below). | `dev-secret-key` |

There's a `.env.example` with these values (the same ones used by `docker-compose.yml`).

## Authentication

The `Authorization: Bearer <API_KEY>` header (with the key set in the
`API_KEY` environment variable) is only required for **managing** files.
Image **delivery** is public. There's no user database in this version:
it's a single shared key.

| Route | Authentication |
| --- | --- |
| `GET /health` | Public |
| `GET /t/...` (image delivery/transformation) | **Public** |
| `DELETE /files/...`, `PUT /files/...` (delete/rename) | Requires `Authorization` |

**Why `/t/...` is public:** these images are meant to be used in
`<img src="...">` on real web pages, and browsers **cannot** send
`Authorization` headers on an `<img>` tag — there's no way to do that from
plain HTML. This is the same model used by any real image CDN (Cloudinary
included): delivery is public (protected at most by the unpredictability
of the URL/hash), and only operations that modify files require
authentication. If delivery ever needs to be restricted too, the usual
approach isn't a header but a signed token in the URL itself — not needed
in this MVP yet.

No header on `/files/...`, or a key that doesn't match → `401` with an
error message explaining why.

## Try it locally with Docker Compose (recommended)

Spin up the app together with a local MinIO (no external account needed):

```bash
docker compose up --build
```

This starts:

- `minio` — S3-compatible storage, with a web console at http://localhost:9001 (user/password: `minioadmin` / `minioadmin`)
- `createbuckets` — automatically creates the `media-mvp` bucket on startup
- `rembg` — internal background-removal service (not exposed to the host)
- `app` — the transformation service at http://localhost:3000, already configured to talk to MinIO and Rembg

### Upload a test image and check the transformation

1. Open the MinIO console at http://localhost:9001 and log in with `minioadmin` / `minioadmin`.
2. Go into the `media-mvp` bucket and upload any image ("Upload" → "Upload File" button), e.g. `your-image.jpg`.
3. With the app running (`docker compose up`), visit in your browser:

   ```
   http://localhost:3000/t/w_400,h_300,f_webp/your-image.jpg
   ```

   `/t/...` is public (see the Authentication section), so no special header is needed — you can paste that URL straight into your browser, or:

   ```bash
   curl "http://localhost:3000/t/w_400,h_300,f_webp/your-image.jpg" -o result.webp
   ```

   You should get the image resized to 400x300 and converted to WebP. If you repeat the same request, the second response comes from the cache (also stored in the bucket, under `cache/`).

Alternative without using the web console: if you have the `mc` client installed, you can upload the file from the command line:

```bash
mc alias set local http://localhost:9000 minioadmin minioadmin
mc cp your-image.jpg local/media-mvp/your-image.jpg
```

## Try it locally without Docker

```bash
npm install
```

You need accessible S3-compatible storage (for example, the MinIO from
`docker-compose.yml`, started with `docker compose up minio createbuckets`).
Copy `.env.example` to `.env`, adjust values if needed, and export the
variables before starting the server:

```bash
cp .env.example .env
export $(cat .env | grep -v '^#' | xargs)   # bash/macOS/Linux
npm run dev
```

On PowerShell:

```powershell
Copy-Item .env.example .env
Get-Content .env | Where-Object { $_ -notmatch '^#' -and $_ } | ForEach-Object {
  $name, $value = $_.Split('=', 2)
  Set-Item "Env:$name" $value
}
npm run dev
```

Then request, for example (`/t/...` is public, no header needed):

```bash
curl "http://localhost:3000/t/w_400,h_300,f_webp/your-image.jpg" -o result.webp
```

URL transformation syntax (same idea as Cloudinary/Openinary):

- `w_400` — width in pixels
- `h_300` — height in pixels
- `f_webp` — output format (`webp`, `avif`, `jpeg`, `png`)
- `q_80` — quality (0-100)

They can be combined, separated by commas: `w_800,h_600,f_avif,q_75`.

### Crop mode (`c_`)

- `c_fill` (default if `c_` isn't set, same as before): crops the image to fill exactly `w` x `h`.
- `c_fit`: keeps the whole image without cropping, fitting it within `w` x `h` (may end up smaller on one axis).

```bash
curl "http://localhost:3000/t/w_300,h_300,c_fit,f_webp/your-image.jpg" -o result-fit.webp
```

### Background removal (`bg_remove`)

Add the `bg_remove` parameter to the transform list to remove the image's
background (leaves the subject cut out on a transparent background) using
[Rembg](https://github.com/danielgatis/rembg), run as an internal service
in `docker-compose.yml` (not exposed to the host, only `app` talks to it
over the internal Docker network).

```
/t/bg_remove/photo.jpg
/t/w_400,bg_remove,f_webp/photo.jpg
```

`bg_remove` internally resizes the image to a maximum of 1600px on the
longer side before sending it to Rembg (see below for why), and then the
rest of the transforms (resize, format, quality) are applied to the
already background-free result. Use an output format with an alpha
channel (`png` or `webp`) if you want to keep the transparency; with
`jpeg` it will be flattened onto a black background, since JPEG doesn't
support transparency.

The first request with `bg_remove` can take several seconds (Rembg
processes the image at full resolution); subsequent identical requests
are served from cache like any other transform.

**Model used:** by default Rembg uses the `u2net` model, which in real
testing cropped thin structures poorly (for example, it cut off a leg in
a photo of a standing character). The service is configured to use
`isnet-general-use` with alpha matting enabled instead, which in the same
test kept both legs and the tail feathers with much more detail.
`birefnet-general` (more accurate in theory) was also tried, but its
model (~1GB) crashed the container from lack of memory (`OOMKilled`), so
it was ruled out.

**Resolution limit:** alpha matting scales poorly in memory — in real
testing, a 4000x3000 (12MP) photo crashed the container with `OOMKilled`,
while a ~700px image worked fine. That's why `bg_remove` resizes the
image to a maximum of 1600px on the longer side before sending it to
Rembg (see [src/rembg.ts](src/rembg.ts)); it doesn't noticeably affect
cutout quality, but it avoids the crash.

**Known limitation:** `bg_remove` isolates *one* main subject against
everything else — it doesn't decide which other objects in the photo are
"important" enough to keep. If the subject is holding or standing next
to another object (a surfboard, a tool, etc.), that object gets removed
along with the rest of the background. Automatically detecting "what
matters in each photo" beyond the main subject isn't something a
background-removal model can solve on its own; it would require a
different approach (object detection plus a relevance criterion,
typically with a vision/language model) that's out of scope for this
phase.

### Watermark (`wm_<file>`)

Add `wm_<name-of-the-watermark-file-in-the-bucket>` to overlay that image
(top-left corner by default), at ~60% opacity and scaled to ~20% of the
result's width. The watermark file must already exist in the bucket
(upload it just like any other image).

```bash
# logo.png already uploaded to the bucket
curl "http://localhost:3000/t/w_600,wm_logo.png,f_webp/your-image.jpg" -o with-watermark.webp
```

If the watermark image doesn't exist in the bucket, it returns `400` with
a clear message.

**Position (`wg_`):** by default the watermark goes in the top-left
corner (`northwest`). To change it, add `wg_<position>` with one of these
values: `north`, `northeast`, `east`, `southeast`, `south`, `southwest`,
`west`, `northwest`, `center` (these are the same names Sharp uses
internally).

```bash
curl "http://localhost:3000/t/w_600,wm_logo.png,wg_center,f_webp/your-image.jpg" -o with-watermark-centered.webp
```

**Size (`ws_`) and opacity (`wo_`):** by default the watermark is scaled
to 20% of the result's width at 60% opacity. Override either with a
percentage from 1 to 100:

```bash
curl "http://localhost:3000/t/w_600,wm_logo.png,ws_35,wo_90,f_webp/your-image.jpg" -o with-watermark-custom.webp
```

### Passthrough for unsupported formats

If Sharp can't process the requested file as an image (PDF, audio, a
corrupted file...) or it's an **animated/multi-frame** format (animated
GIF, animated WebP) — which Sharp would decode without error but lose the
animation — it's served as-is instead of failing, with the appropriate
`Content-Type` based on its extension.

```bash
curl "http://localhost:3000/t/w_100,h_100/document.pdf" -o document.pdf
```

**Real note from testing:** with the Sharp build this project uses, SVG
and *static* GIF (single frame) **are processed normally** (resized/
converted like any other image) — they don't trigger the passthrough,
contrary to what their extension might suggest. Only formats Sharp truly
can't decode (PDF, audio...) and animated/multi-frame formats are served
as-is, to avoid losing the animation.

### File management

Delete a file (and all its derived cache entries):

```bash
curl -X DELETE -H "Authorization: Bearer dev-secret-key" \
  "http://localhost:3000/files/your-image.jpg"
```

Rename/move a file (and clear its old cache):

```bash
curl -X PUT -H "Authorization: Bearer dev-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"newFilename":"new-name.jpg"}' \
  "http://localhost:3000/files/your-image.jpg"
```

Both return `404` if the file doesn't exist, and `PUT` returns `400` if
`newFilename` is missing from the body.

**How cache invalidation works:** a file's cache is stored under
`cache/<filename>/<hash-of-the-transforms>` instead of a flat hash, so
deleting or renaming a file can wipe all of its derived cache in one go
(everything under that prefix is listed and deleted).

## Project status (phases)

- [x] Phase 0: local image transformation (resize, convert format, cache) — tested and working
- [x] Phase 1: S3-compatible storage (AWS S3 / Cloudflare R2 / MinIO) — tested with MinIO via Docker Compose
- [x] Phase 2: API key authentication — `Authorization: Bearer <API_KEY>` header on `/files/...` (management); `/health` and `/t/...` (delivery) are public
- [x] Phase 3: AI background removal (Rembg) — `bg_remove` URL parameter, internal service via Docker Compose
- [x] Phase 4: crop mode (`c_fill`/`c_fit`), file management (delete/rename with cache invalidation), watermark (`wm_`), passthrough for unsupported/animated formats

## License

AGPL-3.0 — see the [`LICENSE`](./LICENSE) file. If someone modifies this
project and offers it as a network service, they're required to publish
the source code of their modifications.
