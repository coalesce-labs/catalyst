# Security categories, exclusions and severity

Derived from the audit prompt in `anthropics/claude-code-security-review` (MIT — see `attribution.md`). The objective is HIGH-CONFIDENCE vulnerabilities with real exploitation potential that the diff newly introduces; the review does not comment on security concerns that already existed on the base commit.

## Categories to examine

**Input validation**
- SQL injection via unsanitized user input
- Command injection in system calls or subprocesses
- XXE injection in XML parsing
- Template injection in templating engines
- NoSQL injection in database queries
- Path traversal in file operations

**Authentication and authorization**
- Authentication bypass logic
- Privilege escalation paths
- Session management flaws
- JWT token vulnerabilities
- Authorization logic bypasses

**Crypto and secrets management**
- Hardcoded API keys, passwords or tokens
- Weak cryptographic algorithms or implementations
- Improper key storage or management
- Cryptographic randomness issues
- Certificate validation bypasses

**Injection and code execution**
- Remote code execution via deserialization
- Pickle injection in Python
- YAML deserialization vulnerabilities
- Eval injection in dynamic code execution
- XSS in web applications (reflected, stored, DOM-based)

**Data exposure**
- Sensitive data logging or storage
- PII handling violations
- API endpoint data leakage
- Debug information exposure

Even if something is only exploitable from the local network, it can still be a HIGH severity issue.

**Catalyst-specific surfaces** worth the same scrutiny when the diff touches them: a tenant boundary (a query, cache key or Durable Object lookup that could read another tenant's rows), a credential checkout or envelope-encryption path, a webhook handler's signature check, a prompt block that interpolates tenant-controlled text into runner-authored instructions, a shell command built from a path or branch name, and a GitHub Actions workflow that runs on `pull_request_target` or interpolates an event field into `run:`.

## Exclusions — do not report

- Denial of service vulnerabilities, even if they allow service disruption
- Secrets or sensitive data stored on disk (handled by other processes)
- Rate limiting or resource exhaustion; services do not need to implement rate limiting
- Memory consumption or CPU exhaustion
- Lack of input validation on non-security-critical fields — without a proven problem from the missing validation, do not report it
- Theoretical issues, style concerns, low-impact findings
- Anything that already existed on the base commit

## Severity

- **HIGH** — directly exploitable: RCE, data breach, authentication bypass, cross-tenant read or write.
- **MEDIUM** — requires specific conditions to exploit but has significant impact.
- **LOW** — defense-in-depth or lower-impact. Recorded as informational only; never fails the step.
