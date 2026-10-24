/**
 * Parse a Cookie header without allowing malformed percent-encoding to escape
 * into the request handler. Invalid cookie values become empty strings, which
 * makes session authentication fail closed.
 */
export function parseCookies(header = '') {
  const cookies = Object.create(null);
  for (const segment of String(header).split(';')) {
    const part = segment.trim();
    if (!part) continue;
    const separator = part.indexOf('=');
    const name = separator < 0 ? part : part.slice(0, separator);
    const rawValue = separator < 0 ? '' : part.slice(separator + 1);
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      // A malformed cookie is untrusted input, not a reason to abort a request.
      cookies[name] = '';
    }
  }
  return cookies;
}
