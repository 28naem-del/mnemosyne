# Contributing to Mnemosyne

Thank you for your interest in contributing to Mnemosyne! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 18+
- npm 9+
- Docker (for running infrastructure locally)
- TypeScript knowledge

### Infrastructure

Mnemosyne requires the following services for development:

```bash
# Start all services with Docker Compose
docker compose up -d

# Services started:
# - Qdrant (vector DB) on :6333
# - Redis (cache + pub/sub) on :6379
# - FalkorDB (knowledge graph) on :6380
```

### Install & Build

```bash
git clone https://github.com/mnemosyne-ai/mnemosyne.git
cd mnemosyne
npm install
npm run build
```

### Running Tests

```bash
# Unit tests
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage
```

## Project Structure

```
src/
├── index.ts              # Public API entry point
├── core/                 # Core memory engine
├── pipeline/             # 12-step zero-LLM ingestion pipeline
├── layers/
│   ├── infrastructure/   # L1: Qdrant, Redis, FalkorDB clients
│   ├── pipeline/         # L2: Ingestion pipeline steps
│   ├── graph/            # L3: Knowledge graph operations
│   ├── cognitive/        # L4: Decay, confidence, priority, diversity
│   └── improvement/      # L5: Reinforcement, consolidation, reasoning
├── tools/                # 9 tool implementations
├── types/                # TypeScript type definitions
└── utils/                # Shared utilities
```

## Architecture

Mnemosyne uses a 5-layer cognitive architecture. Before contributing, please read the [Architecture Document](./MNEMOSYNE-PUBLIC-ARCHITECTURE.md) to understand which layer your change affects.

| Layer | Purpose | Key Concern |
|-------|---------|-------------|
| L1 | Infrastructure | Connection management, retries, timeouts |
| L2 | Pipeline | Zero-LLM processing, deterministic behavior |
| L3 | Knowledge Graph | Entity extraction, relationship modeling |
| L4 | Cognitive | Decay math, scoring algorithms |
| L5 | Self-Improvement | Feedback loops, consolidation safety |

## Making Changes

### Branch Naming

- `feat/description` for features
- `fix/description` for bug fixes
- `perf/description` for performance improvements
- `docs/description` for documentation
- `refactor/description` for refactoring

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(pipeline): add security filter for credential detection
fix(decay): correct activation calculation for core memories
perf(recall): add LRU cache for embedding generation
docs(readme): add multi-agent configuration example
```

### Code Style

- TypeScript strict mode — no `any` types without justification
- All public functions need JSDoc comments
- Error handling on all external calls (network, DB)
- Timeouts on all network operations
- Run `npm run lint` and `npm run format` before committing

### Testing Requirements

- All new features need unit tests
- Bug fixes need a regression test
- Performance-sensitive code needs benchmark tests
- Integration tests for cross-layer interactions

### Pull Request Process

1. Fork the repository
2. Create your feature branch from `main`
3. Make your changes with tests
4. Run the full test suite: `npm test`
5. Run lint and type checks: `npm run lint && npm run typecheck`
6. Open a PR against `main`
7. Fill in the PR template completely
8. Wait for CI to pass and a maintainer review

## Key Design Principles

1. **Zero-LLM Pipeline**: The ingestion pipeline must never call an LLM. Classification, extraction, and scoring must be algorithmic.
2. **Deterministic Behavior**: Same input must produce same output. No randomness in the pipeline.
3. **Graceful Degradation**: If Redis is down, use in-memory cache. If FalkorDB is unavailable, skip graph enrichment. Never fail hard.
4. **Sub-50ms Store**: The full 12-step pipeline must complete in under 50ms.
5. **Backward Compatibility**: Changes to the memory schema must include migration logic.

## Reporting Issues

- Use the [Bug Report](https://github.com/mnemosyne-ai/mnemosyne/issues/new?template=bug_report.md) template
- Use the [Feature Request](https://github.com/mnemosyne-ai/mnemosyne/issues/new?template=feature_request.md) template
- Search existing issues before creating new ones

## Getting Help

- Open a [Discussion](https://github.com/mnemosyne-ai/mnemosyne/discussions) for questions
- Tag issues with `good first issue` for newcomer-friendly tasks
- Read the architecture doc before diving into code

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
