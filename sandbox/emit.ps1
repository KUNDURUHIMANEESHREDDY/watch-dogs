param([switch]$Residual)

# Emits realistic terminal failures from a real PowerShell session, so the daemon
# exercises the same path a user's shell would: profile -> transcript -> rules
# (and, for -Residual, the LLM second opinion).

if ($Residual) {
  Write-Host 'PS> ./gradlew deploy'
  Write-Host '> Task :app:deploy'
  # Error-shaped, but no deterministic rule matches it -> residual triage -> LLM.
  Write-Host 'CustomDomainException: frobnicator rejected widget batch 7f3a after 3 retries'
  # Contains the word "errors" but is good news; must NOT be triaged.
  Write-Host 'Build completed with 0 errors'
  exit 0
}

Write-Host 'PS> npm install'
Write-Host 'added 1 package in 0.4s'
Write-Host 'PS> node -e "require(1)"'
Write-Host 'ReferenceError: count is not defined'
Write-Host '    at tally (src/tally.js:5:10)'
Write-Host 'PS> git status'
Write-Host 'nothing to commit, working tree clean'
