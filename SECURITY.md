# Security Policy

## Supported Versions

We actively maintain security patches for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take security vulnerabilities seriously and appreciate your efforts to responsibly disclose your findings.

**Please do NOT report security vulnerabilities through public GitHub issues.**

### How to Report

Send an email to **[team@mnemosy.ai](mailto:team@mnemosy.ai)** with the subject line:

```
[SECURITY] <brief description>
```

Include the following in your report:

- **Type of issue** (e.g., remote code execution, SQL injection, information disclosure, etc.)
- **Affected component** (e.g., vector store backend, Redis broadcast, FalkorDB integration)
- **Location** — full path(s) of the source file(s) related to the issue
- **Step-by-step reproduction instructions**
- **Proof of concept or exploit code** (if available)
- **Impact assessment** — what could an attacker achieve?

### Response Timeline

| Stage                        | Target SLA |
| ---------------------------- | ---------- |
| Acknowledgement of receipt   | 48 hours   |
| Confirmation of the issue    | 5 business days |
| Patch release (critical)     | 14 days    |
| Patch release (high/medium)  | 30 days    |
| Public disclosure            | After patch ships |

### Responsible Disclosure

We follow a coordinated disclosure model:

1. Reporter sends details privately to **team@mnemosy.ai**.
2. We confirm receipt and begin investigation.
3. We develop and test a fix.
4. We release a patched version and publish a security advisory.
5. Reporter is credited in the advisory (unless anonymity is requested).

### Scope

The following are **in scope**:

- The `mnemosyne` npm package and its TypeScript source
- All supported backend integrations (Qdrant, FalkorDB, Redis, MongoDB)
- The embedding pipeline (Ollama/OpenAI adapters)
- Docker images published under `28naem-del/mnemosyne`

The following are **out of scope**:

- Vulnerabilities in third-party dependencies that are already publicly disclosed upstream
- Issues in end-user infrastructure (self-hosted Qdrant, Redis, etc.)
- Social engineering attacks

### Thank You

We are grateful to everyone who takes the time to responsibly report security issues. Your efforts make Mnemosyne safer for everyone.
