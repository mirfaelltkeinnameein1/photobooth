# Ericsson 150 Gallery

Electron gallery app for live-events with:
- Operator panel
- Gallery 1 window
- Gallery 2 window

It watches an incoming selfie folder, generates background replacements with Nano Banana (pro or standard), lets operators review/accept, and exports final MP4 composites.

## Stack
- Electron + Express (localhost only)
- Plain JS + Tailwind CSS output
- Filesystem persistence (no DB)
- ffmpeg/ffprobe for media work
- Windows Credential Manager via `keytar` for API key storage

## Project Layout
- `src/main`: Electron main process, server, queue/state, Gemini/media integrations
- `src/renderer/js`: Operator + gallery renderer code
- `public`: HTML + CSS entry files
- `assets`: bundled defaults and overlay assets (`assets/defaults/slots/slot01..slot12` is canonical)
- `config`: shipped baseline config templates
- `runtime`: generated at runtime (jobs, logs, outputs, current slot media)

## Quick Start (Dev)
1. Install dependencies:
```bash
npm install
```
2. Make sure `ffmpeg` and `ffprobe` are available on PATH.
3. Run:
```bash
npm run dev
```

If PowerShell blocks `npm.ps1`, run commands through `cmd`:
```bat
cmd /c npm run dev
```

## Build CSS
```bash
npm run build:css
```
Tailwind output is generated to:
- `public/styles.tailwind.generated.css` (readable, non-minified)

## Packaging (Unsigned Windows Portable)
```bash
npm run dist:win
```

This:
1. Copies ffmpeg/ffprobe into `build/bin`
2. Builds CSS
3. Produces a portable unsigned package in `dist/`

## Runtime Data Location
- Dev: under repo root (`runtime/`, `config/`, etc.)
- Packaged: under `gallery-composer-data` next to the executable

## API Key Handling
- UI input is write-only
- Stored in Windows Credential Manager when `keytar` is available
- Not returned in snapshots/SSE payloads

## Logging
- File log: `runtime/logs/app.log` (with single-file rotation to `app.log.1`)
- Live logs stream to Operator panel via SSE
