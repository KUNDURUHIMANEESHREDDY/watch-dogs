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

const failed = [...results.entries()].filter(([, result]) => result !== 'success');
if (failed.length > 0) {
  console.error(`Release gate blocked: ${failed.map(([name, result]) => `${name}=${result}`).join(', ')}.`);
  process.exit(1);
}

console.log(`Release gate passed: all ${results.size} required jobs succeeded.`);
