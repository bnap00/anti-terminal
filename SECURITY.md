# Security Policy

## Supported versions

anti terminal is alpha software. Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub: go to the
[Security tab](https://github.com/bnap00/anti-terminal/security) and click
**Report a vulnerability** (private vulnerability reporting).

Include what you can of:

- affected version / commit
- steps to reproduce or a proof of concept
- the impact you believe it has

This is a solo-maintained project, so responses are best effort: the aim is to acknowledge reports
within 7 days and to ship a fix or mitigation for confirmed high-severity issues as
quickly as practical. You'll be credited in the advisory unless you prefer otherwise.

## Scope notes

anti terminal runs shell commands proposed by an AI model, gated by an approval step.
Issues that bypass the approval gate, escape the intended command boundaries, or leak
provider API keys are especially in scope.
