// Strict JSON object decoding for request bodies. Buffer concatenation must happen
// before UTF-8 decoding so a multi-byte code point split across network chunks
// is reconstructed rather than replaced with U+FFFD.
export function parseJsonObject(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return {};

  const bytes = Buffer.concat(chunks);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    const error = new Error('invalid UTF-8 JSON body');
    error.code = 'ERR_INVALID_JSON_UTF8';
    throw error;
  }

  const value = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('JSON body must be an object');
    error.code = 'ERR_JSON_BODY_TYPE';
    throw error;
  }
  return value;
}
