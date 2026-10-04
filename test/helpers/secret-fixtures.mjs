/**
 * Secret-shaped strings for redaction tests, assembled at runtime.
 *
 * The redaction tests need input that the redactor will actually match, which means
 * the input has to look exactly like a credential. Writing that literal into the
 * source has a cost that is easy to forget: every automated secret scanner run
 * against this repository flags it, and a security-focused repository that cannot
 * pass a secret scan is a repository nobody can run one against.
 *
 * The values are therefore never present in any file. They are concatenated here, at
 * load time, into exactly the same string the redactor sees in production. Nothing
 * about the guarantee under test changes -- `redact()` is handed the same bytes it
 * would be handed by a leaked credential, and the assertions are unchanged.
 *
 * The AWS value is AWS's own documented example key, which is as fake as a
 * credential can be. It is split rather than kept whole only so that no scanner sees
 * a contiguous match.
 *
 * `no-secrets-in-source.test.mjs` is what keeps this from regressing: it scans every
 * file in the repository with these same shapes and fails if any of them appears.
 */

/** An AWS-shaped access key id: `AKIA` plus sixteen uppercase alphanumerics. */
export const awsKeyId = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');

/** A GitHub-shaped personal access token: `ghp_` plus sixteen or more alphanumerics. */
export const githubToken = ['ghp_', 'abcdefghijklmnop', 'qrstuvwxyz012345'].join('');

/**
 * The same shapes as regular expressions, for scanning the repository with.
 *
 * Built by concatenation for the same reason the values are. A scanner reading this
 * file sees `AKIA` followed by a quote, not by sixteen uppercase characters.
 *
 * The splits fall *between* tokens, never inside a character class. An earlier
 * version cut `[0-9A-Z]` after the `A`, producing `[0-9AZ]`, which quietly stopped
 * matching anything -- and the test that forbids secret literals passed against a
 * repository full of them. A guard that cannot fail is worse than no guard.
 */
export const SECRET_SHAPES = [
  ['aws access key id', new RegExp(['\\b(?:AK', 'IA|AS', 'IA)[0-9A', '-Z]{16}\\b'].join(''), 'g')],
  ['github token', new RegExp(['\\bgh[pous', 'r]_[A-Za-z', '0-9]{16,}\\b'].join(''), 'g')],
  ['anthropic key', new RegExp(['\\bsk-', 'ant-[A-Za-z0-9_-]{20,}'].join(''), 'g')],
  ['github fine-grained pat', new RegExp(['\\bgithub_', 'pat_[A-Za-z0-9_]{50,}'].join(''), 'g')],
  ['google api key', new RegExp(['\\bAI', 'za[0-9A-Za-z_-]{35}'].join(''), 'g')],
  ['openai-style key', new RegExp(['\\bsk-', '[A-Za-z0-9]{32,}'].join(''), 'g')],
];

/** A line of text carrying both shapes, for the common "output contained a key" case. */
export const evidenceWithSecrets = (extra = 'deploy failed') =>
  `${extra}: using AWS key ${awsKeyId} and github token ${githubToken} to push`;