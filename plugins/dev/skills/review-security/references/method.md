# Method: three phases, then confirm and score

Derived from the audit prompt in `anthropics/claude-code-security-review` (MIT — see `attribution.md`), run by one session in order.

## Phase 1 — Repository context research

Before judging the diff, learn what "secure" already looks like here:

```bash
# frameworks, validators, sanitizers, auth helpers the codebase relies on
grep -rlE 'zod|valibot|joi|yup|ajv|DOMPurify|sanitize|escape[A-Z]|parameteriz|prepared' --include='*.ts' --include='*.js' --include='*.py' --include='*.go' --include='*.rb' . 2>/dev/null | head -30
grep -rnE 'requireAuth|withAuth|authorize\(|assertTenant|tenantId|verifySignature|timingSafeEqual' --include='*.ts' --include='*.py' . 2>/dev/null | head -30
```

Read the README / AGENTS.md security notes if they exist, and the modules the changed files import from. The output of this phase is a short list: the established secure patterns (how input is validated, how queries are built, how auth is checked, how secrets are read) and the threat model (who is untrusted: a tenant, a webhook sender, a PR author, a file on disk).

## Phase 2 — Comparative analysis

Set the diff against those patterns:

- a new query, command, template or file path built by string concatenation where the codebase uses parameters or a builder;
- a handler that skips the auth or tenant check its siblings perform;
- a sanitizer or signature check removed, bypassed or made optional;
- a new attack surface: a new endpoint, a new file read/write, a new subprocess, a new deserializer, a new place where remote text reaches a template, a shell, or the DOM.

Each deviation is a candidate for Phase 3, not yet a finding.

## Phase 3 — Vulnerability assessment

For each changed file: trace data flow from every untrusted input (request params, headers, webhook bodies, file contents, environment the tenant controls, branch and path names, Linear ticket text) to every sensitive operation (a query, a subprocess, a file path, a redirect, an HTML sink, a crypto call, a log line). Look for privilege boundaries crossed unsafely, injection points, unsafe deserialization, and the categories in `categories.md`. Where the sink is in code the diff did not change, the finding still cites the changed line that feeds it.

## Confirm each candidate yourself

Open the file at the cited line and follow the path from input to sink in the real code: is the input really attacker-controlled, is there really no validation or encoding between it and the sink, and what exactly does an attacker get? Write that as the exploit scenario. A candidate whose path you cannot complete is dropped and named in the informational list.

## Confidence scale (0–100)

| Score | Meaning |
|---|---|
| 90–100 | Certain exploit path identified, traced end to end (tested where possible) |
| 80–89 | Clear vulnerability pattern with known exploitation methods |
| 70–79 | Suspicious pattern requiring specific conditions to exploit |
| below 70 | Too speculative — do not report |

**Confirmed** = severity HIGH or MEDIUM at ≥80. **Informational** = 70–79 at any severity, or LOW at any score. Only confirmed findings fail the step. Each confirmed finding must be something a security engineer would confidently raise in a PR review.

## False positives — never reported

- any exclusion in `categories.md` (denial of service, secrets on disk, rate limiting, resource exhaustion, unproven validation gaps);
- a weakness that already existed on the base commit (`git show <base>:<path>` before claiming otherwise);
- a pattern the codebase's own conventions make safe (a parameterized builder that looks like concatenation, a sanitizer applied one layer up) — Phase 1 exists to know these;
- a finding on a line the diff did not touch, or in a file outside the scope;
- style, hardening suggestions and general posture notes — informational at most.
