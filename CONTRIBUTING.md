# Contributing

Thanks for your interest in contributing to Speech Evaluator.

## Getting Started

1. Fork the repo
2. Clone your fork
3. Create a branch: `git checkout -b feature/your-feature`
4. Install dependencies: `npm install`
5. Make your changes
6. Run tests: `npm test`
7. Push and open a PR

## Development Guidelines

- TypeScript strict mode is enforced
- All new functions need unit tests (Vitest)
- Core logic should have property-based tests (fast-check)
- Follow the existing code style
- Keep PRs focused — one feature or fix per PR

## Commit Messages

Use conventional commits:

```
feat: add pause detection threshold config
fix: handle empty transcript edge case
docs: update PRD with Phase 2 exit criteria
test: add property test for WPM computation
```

## Architecture

See the [design document](.kiro/specs/ai-toastmasters-evaluator/design.md) for component interfaces and data flow. The [PRD](docs/PRD-AI-Toastmasters-Evaluator.md) covers the full product roadmap.

## Questions?

Open an issue or start a discussion.
