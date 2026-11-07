const REQUIRED_NAMES = [
  'core-tests',
  'frontend-e2e',
  'frontend-build',
  'gateway-e2e',
  'security',
];

const entries = process.argv.slice(2);

if (entries.length === 0) {
  console.error('Release gate blocked: no dependency results were supplied.');
  process.exit(2);
}

const results = new Map();
for (const entry of entries) {
  const separator = entry.indexOf('=');
  if (separator <= 0 || separator === entry.length - 1) {
    console.error(`Release gate blocked: expected name=result, received ${JSON.stringify(entry)}.`);
    process.exit(2);
  }
  const name = entry.slice(0, separator);
  const result = entry.slice(separator + 1);
  if (results.has(name)) {
    console.error(`Release gate blocked: duplicate result for ${name}.`);
    process.exit(2);
  }
  results.set(name, result);
}

const missing = REQUIRED_NAMES.filter((name) => !results.has(name));
const unexpected = [...results.keys()].filter((name) => !REQUIRED_NAMES.includes(name));
if (missing.length > 0 || unexpected.length > 0) {
  const details = [
    ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
    ...(unexpected.length ? [`unexpected: ${unexpected.join(', ')}`] : []),
  ];
  console.error(`Release gate blocked: ${details.join('; ')}.`);
  process.exit(2);
}

const failed = REQUIRED_NAMES
  .map((name) => [name, results.get(name)])
  .filter(([, result]) => result !== 'success');
if (failed.length > 0) {
  console.error(`Release gate blocked: ${failed.map(([name, result]) => `${name}=${result}`).join(', ')}.`);
  process.exit(1);
}

console.log(`Release gate passed: all ${REQUIRED_NAMES.length} required jobs succeeded.`);
