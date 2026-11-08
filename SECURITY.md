# Security scanning and exceptions

## Automated checks

The GitHub Actions Security workflow audits the committed root and frontend npm lockfiles for high and critical advisories, scans the full Git history for likely secrets with Gitleaks, and uploads CycloneDX dependency SBOMs as workflow artifacts. These checks supplement, and do not replace, code review or incident response.

A dependency audit is expected to fail on high or critical advisories. Do not lower the audit threshold to obtain a green build. Upgrade or replace the affected dependency and commit the regenerated lockfile.

## False positives and exceptions

Do not commit credentials to suppress a secret scanner. For a suspected Gitleaks false positive:

1. Verify that the finding is not a live or previously exposed credential. If uncertain, revoke or rotate it first.
2. Add a narrow, documented allowlist entry only for a verified false positive, preferably matching the specific path and rule fingerprint. Avoid broad global allowlists and generic entropy exclusions.
3. Record the scanner, rule/fingerprint, justification, reviewer, and review date in the pull request.
4. Re-run the scanner and confirm the exception suppresses only the intended finding.

Security exceptions must be reviewed periodically and removed when no longer needed. Do not use an exception to waive an actual secret or a high/critical dependency vulnerability.

## Release gate

The CI workflow calls this Security workflow as a reusable prerequisite. Its single `required` aggregate fails unless core tests, frontend/browser checks, real-gateway E2E, and every Security job (dependency audits, Gitleaks, SBOM generation, and CodeQL) all succeed. Configure `required` as the protected-branch status check; do not rely on the standalone Security workflow's green result alone.

The required job checks out the exact PR merge ref and sets up Node.js 22 before executing `scripts/require-successful-jobs.mjs`. The Node regression suite executes that gate with all-success inputs and fault-injected `failure`/`skipped` Security results, proving that a broken or skipped Security workflow blocks release. Malformed, missing, duplicate and unexpected dependency results also fail closed.

## Lockfiles

Both the repository root and `frontend/` must commit their npm lockfiles. CI uses `npm ci` against each package manifest and lockfile. Generate or refresh lockfiles with the supported Node.js/npm version, review dependency changes, then run the test, build, and security workflows.
