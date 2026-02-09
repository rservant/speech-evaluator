# AI Toastmasters Evaluator

An AI-powered speech evaluator for Toastmasters meetings. It listens to a live speech, transcribes it, computes delivery metrics, generates an evidence-based evaluation, and speaks it aloud — all from a browser-based control panel.

## How It Works

1. The operator opens the web UI and clicks **Start Speech** when the speaker begins
2. Audio streams from the browser mic to the server via WebSocket
3. Deepgram provides live captions during the speech
4. When the speaker finishes, the operator clicks **Stop Speech**
5. OpenAI produces a high-quality final transcript with word-level timestamps
6. Delivery metrics are computed (WPM, filler words, pauses, duration)
7. GPT-4o generates a structured evaluation with evidence quotes from the transcript
8. The operator clicks **Deliver Evaluation** and the evaluation is spoken aloud via TTS
9. Optionally, click **Save Outputs** to persist transcript, metrics, and evaluation to disk

A **Panic Mute** button is always available to immediately stop all audio and TTS.

## Prerequisites

- Node.js 20+
- A [Deepgram API key](https://console.deepgram.com/signup) (free tier includes $200 credit)
- An [OpenAI API key](https://platform.openai.com/api-keys) (requires billing setup)
- A microphone (USB or boundary mic recommended for meeting use)
- A separate speaker for TTS playback (to avoid echo feedback)

## Getting Started

```bash
# Install dependencies
npm install

# Copy environment config and add your API keys
cp .env.example .env

# Build
npm run build

# Start the server
npm start
```

Open `http://localhost:3000` in your browser. That's it.

## Configuration

Edit `.env`:

```
DEEPGRAM_API_KEY=your_deepgram_key
OPENAI_API_KEY=your_openai_key
PORT=3000
```

## Using It in a Meeting

1. Open the UI on a laptop connected to the room mic and speaker
2. Confirm speaker consent before recording
3. Click **Start Speech** — live captions appear as the speaker talks
4. Click **Stop Speech** when the speech ends — wait for processing
5. Click **Deliver Evaluation** — the AI evaluation plays through the speaker
6. If anything goes wrong, hit **Panic Mute** to kill all audio immediately
7. Click **Save Outputs** if you want to keep the transcript, metrics, and evaluation

The evaluation is evidence-grounded: every commendation and recommendation includes a direct quote from the speaker's actual words with a timestamp reference.

## Development

```bash
# Run tests (339 tests across 17 files)
npm test

# Watch mode for tests
npm run test:watch

# TypeScript watch mode
npm run dev
```

## Project Structure

```
src/
  types.ts                # Shared interfaces and types
  session-manager.ts      # Session state machine + pipeline orchestration
  transcription-engine.ts # Deepgram live + OpenAI post-speech transcription
  metrics-extractor.ts    # WPM, filler words, pauses, duration
  evaluation-generator.ts # GPT-4o evaluation + evidence validation
  evidence-validator.ts   # Evidence quote matching against transcript
  tts-engine.ts           # OpenAI TTS with duration enforcement
  file-persistence.ts     # Opt-in output saving
  server.ts               # Express + WebSocket server
  index.ts                # Entry point
public/
  index.html              # Operator control panel (vanilla HTML/CSS/JS)
  audio-worklet.js        # Browser audio capture + downsampling to 16kHz
docs/
  PRD-AI-Toastmasters-Evaluator.md  # Full product requirements
```

## Privacy

- Audio is never written to disk — in-memory only
- Session data auto-purges 10 minutes after evaluation delivery
- File persistence is opt-in (operator must click "Save Outputs")
- Speaker opt-out immediately and irrecoverably purges all session data
- Third-party names mentioned in the speech are redacted in TTS delivery
- See the [PRD](docs/PRD-AI-Toastmasters-Evaluator.md) for full privacy details

## Tech Stack

- Node.js + TypeScript (ESM)
- Express + WebSocket (`ws`)
- Deepgram SDK (live transcription)
- OpenAI API (transcription, evaluation, TTS)
- Vitest + fast-check (unit + property-based testing)

## License

[MIT](LICENSE)
