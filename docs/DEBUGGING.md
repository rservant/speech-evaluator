# Debugging Guide

## Running the App

There are two steps to running the app — build and start are separate:

```bash
# Build TypeScript to JavaScript
npm run build

# Start the server
npm start
```

Then open http://localhost:3000 in your browser.

**Common mistake:** `npm run dev` only runs `tsc --watch` (TypeScript compiler in watch mode). It does NOT start the server. You still need `npm start` in a separate terminal after building.

## Dev Workflow (Auto-Restart)

For a smoother dev experience that watches for changes and restarts automatically:

```bash
npx tsx --watch src/index.ts
```

This compiles and runs in one step, restarting on file changes. No separate build needed.

Alternatively, use two terminals:

```bash
# Terminal 1: watch and recompile TypeScript
npm run dev

# Terminal 2: run the server (restart manually after changes)
npm start
```

## Server Logging

The server logs all significant events to the console by default:

```
AI Toastmasters Evaluator v0.1.0 running at http://localhost:3000
[INFO] New WebSocket connection, session abc-123
[INFO] Audio format validated for session abc-123
[INFO] Recording started for session abc-123
[WARN] Chunk jitter 150ms exceeds 100ms threshold (session abc-123, interval 200ms)
[INFO] Recording stopped for session abc-123
[ERROR] Evaluation generation failed for session abc-123: ...
```

Log levels:
- `[INFO]` — Normal operations (connections, state transitions, saves)
- `[WARN]` — Non-fatal issues (audio jitter, quality warnings, max duration reached)
- `[ERROR]` — Failures (WebSocket errors, evaluation/TTS failures, save errors)

## Environment Variables

All configuration is in `.env` (copy from `.env.example`):

```
DEEPGRAM_API_KEY=your_key    # Required for live transcription
OPENAI_API_KEY=your_key      # Required for transcription, evaluation, TTS
PORT=3000                    # Server port (default: 3000)
```

## Browser DevTools

Open the browser console (Cmd+Option+J on macOS) to see client-side logs:

- WebSocket connection status and message traffic
- Audio capture errors (mic permission, device not found)
- TTS playback errors
- AudioWorklet loading issues

### Useful things to check in DevTools:

- **Network tab → WS**: Inspect WebSocket frames (JSON messages and binary audio chunks)
- **Console**: Client-side errors from audio capture, WebSocket, or TTS playback
- **Application tab → Service Workers**: Ensure no stale service worker is caching old files

## Common Issues

### "Website doesn't load" / blank page

1. Make sure you ran `npm run build` before `npm start`
2. Check that the server is actually running (you should see the "running at" message)
3. Check the correct port — default is 3000 unless you changed it in `.env`
4. Try a hard refresh (Cmd+Shift+R) to clear cached assets
5. Check the browser console for JavaScript errors

### Server starts but exits immediately

The entry point (`src/index.ts`) must call `server.listen()`. If you see the process exit with no output, the server factory was likely imported but never started. Run `npm start` (which runs `node dist/index.js`), not `node dist/server.js`.

### "No microphone detected"

- Ensure a mic is connected before opening the page
- Check browser permissions (click the lock icon in the address bar)
- Some browsers require HTTPS for mic access — localhost is an exception

### WebSocket won't connect

- The WebSocket connects to the same host/port as the page
- If you're behind a reverse proxy, ensure it supports WebSocket upgrades
- Check the browser console for connection errors

### Audio format errors

The system expects mono, 16-bit LINEAR16, 16kHz audio. The AudioWorklet handles conversion from the browser's native format. If you see `audio_format_error` messages:
- The handshake message may not have been sent (check WebSocket frames)
- A browser extension may be interfering with audio capture

### TTS playback fails / no sound

- Check that your system audio output is working
- The browser may need a user gesture before playing audio (click any button first)
- Check the console for `decodeAudioData` errors — the TTS response format may not be supported
- The written evaluation is displayed as a fallback when TTS fails

## Running Tests

```bash
# Run all tests (339 tests across 17 files)
npm test

# Run a specific test file
npx vitest run src/metrics-extractor.test.ts

# Run tests in watch mode
npm run test:watch

# Run only property-based tests
npx vitest run --reporter=verbose '*.property.test.ts'
```

## Type Checking

```bash
# Full type check (same as npm run build but doesn't emit files)
npx tsc --noEmit
```

## Project Architecture Quick Reference

```
Browser (public/index.html)
  ├── AudioWorklet (audio-worklet.js) → captures mic, downsamples to 16kHz Int16
  ├── WebSocket client → sends audio chunks + control messages
  └── Web Audio API → plays TTS audio
        │
        ▼ WebSocket
Server (src/server.ts)
  ├── SessionManager → state machine (IDLE → RECORDING → PROCESSING → DELIVERING → IDLE)
  ├── TranscriptionEngine → Deepgram live + OpenAI post-speech
  ├── MetricsExtractor → WPM, fillers, pauses, duration
  ├── EvaluationGenerator → GPT-4o structured evaluation + evidence validation
  ├── TTSEngine → OpenAI TTS with duration enforcement
  └── FilePersistence → opt-in save to disk
```
