# Confirm, score, filter

## Confirm each candidate yourself

The official prompt validates every candidate in a separate pass; here you are that pass. For each candidate, open the file at the cited line with enough surrounding context to judge it, and ask the one question that decides it: **is the stated problem actually true of this code, as written, on this branch?** Examples:

- "variable is not defined" — search the file and its imports; is it defined after all?
- "rule X is violated" — is the rule file actually scoped to this file, and is the line really outside what the rule allows?
- "reverts commit Y's fix" — read commit Y's diff; does this change really undo it, or does it move the guard elsewhere in the same diff?

A candidate that does not survive this read is dropped, and named in the report's dropped list in one line so a reader can see it was considered.

## Confidence scale (0–100)

| Score | Meaning |
|---|---|
| 0 | Not a real issue, or a false positive from the list below |
| 25 | Possibly real; could not be verified from the code |
| 50 | Real but minor — a nit a senior engineer would let through |
| 75 | Likely real and verified in the diff; a reviewer would raise it |
| 90 | Certain: verified against the surrounding code and the intent; the code will misbehave or the quoted rule is unambiguously broken |
| 100 | The code cannot work as written (will not compile, parse, or resolve) |

**Report only findings scoring 80 or above.** A 75 is not rounded up. When you are torn between two scores, the lower one is the honest one.

## Severity

- **HIGH** — will not compile/parse, definitely wrong results, or an exploitable weakness.
- **MEDIUM** — wrong under conditions the code itself makes realistic, or a quoted guideline broken.
- **LOW** — a nit. A LOW never reaches 80, by construction; it belongs on the dropped list at most.

## False positives — never reported, whatever the score

From the official prompt:

- pre-existing issues — the defect was already there on the base commit (check with `git show <base>:<path>` before claiming otherwise);
- something that looks like a bug but is actually correct;
- pedantic nitpicks a senior engineer would not raise;
- issues a linter or type checker will catch — and do not run the linter to verify;
- general code-quality concerns (lack of test coverage, general security posture, naming, structure) unless a scoped CLAUDE.md/AGENTS.md rule explicitly requires them — then it is a `guideline` finding with the rule quoted;
- issues mentioned in CLAUDE.md but explicitly silenced in the code on that line (a lint-ignore comment or an inline note);
- potential issues that depend on specific inputs, timing or state;
- subjective suggestions and improvements;
- anything in a file outside the scope, or on a line the diff did not touch.
