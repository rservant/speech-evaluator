# Speech Evaluator

An AI-powered Toastmasters speech evaluator that listens to live speeches, generates evidence-based evaluations, and delivers them aloud.

## What It Does

- Captures speech audio via microphone during a Toastmasters meeting
- Transcribes in real time with live captions
- Computes delivery metrics (WPM, filler words, pauses, duration)
- Generates a structured, evidence-grounded evaluation using an LLM
- Speaks the evaluation aloud via text-to-speech
- Saves transcript, metrics, and evaluation to files (opt-in)

The system is operated via a web-based UI with manual controls: Start Speech → Stop Speech → Deliver Evaluation.

## Project Status

**Phase 1 (MVP)** — in development. See the [full PRD](docs/PRD-AI-Toastmasters-Evaluator.md) for the 9-phase roadmap.

## Tech Stack

- Node.js + TypeScript
- Express.js + WebSocket (`ws`)
- Deepgram API (live captions)
- OpenAI gpt-4o-transcribe (final transcript)
- OpenAI GPT-4o (evaluation generation)
- OpenAI TTS API (spoken delivery)
- Vitest + fast-check (testing)

## Prerequisites

- Node.js 20+
- A Deepgram API key
- An OpenAI API key
- A USB or boundary microphone
- A separate speaker (for echo prevention)

## Getting Started

```bash
# Clone the repo
git clone https://github.com/rservant/speech-evaluator.git
cd speech-evaluator

# Install dependencies
npm install

# Copy environment config
cp .env.example .env
# Edit .env with your API keys

# Build
npm run build

# Start the server
npm start
```

Then open `http://localhost:3000` in your browser.

## Configuration

Copy `.env.example` to `.env` and fill in:

```
DEEPGRAM_API_KEY=your_deepgram_key
OPENAI_API_KEY=your_openai_key
PORT=3000
```

## Development

```bash
# Run in development mode
npm run dev

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

## Project Structure

```
src/                    # Server-side TypeScript source
  types.ts              # Shared interfaces and types
  session-manager.ts    # Session state machine
  metrics-extractor.ts  # Delivery metrics computation
  evaluation-generator.ts # LLM evaluation + evidence validation
  evidence-validator.ts # Evidence quote validation
  tts-engine.ts         # Text-to-speech with time enforcement
  transcription-engine.ts # Deepgram + OpenAI transcription
  file-persistence.ts   # Opt-in output saving
  server.ts             # Express + WebSocket server
public/                 # Browser client (vanilla HTML/CSS/JS)
  index.html            # Operator control panel
  audio-worklet.js      # Audio capture + downsampling
docs/                   # Project documentation
  PRD-AI-Toastmasters-Evaluator.md
output/                 # Saved session outputs (git-ignored)
```

## Privacy

- Audio is never written to disk
- Session data is held in memory only and auto-purged after 10 minutes
- File persistence is opt-in (operator must explicitly click "Save Outputs")
- Speaker consent is confirmed before every recording
- See the [PRD](docs/PRD-AI-Toastmasters-Evaluator.md) for full privacy details

## License

[MIT](LICENSE)
