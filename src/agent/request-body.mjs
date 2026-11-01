/**
 * Read a small JSON object from an incoming HTTP request without building an
 * unbounded intermediate string. The caller owns the HTTP response and closes
 * the connection after sending a 413 response.
 */
export function readJsonBody(req, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    const chunks = [];

    const fail = (error, pause = false) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      if (pause && typeof req.pause === 'function') req.pause();
      reject(error);
    };

    const declaredLength = req.headers?.['content-length'];
    if (declaredLength !== undefined && /^\\d+$/.test(String(declaredLength))) {
      const declaredBytes = Number(declaredLength);
      if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes) {
        fail(Object.assign(new Error('request body too large'), { status: 413 }), true);
        return;
      }
    }

    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length > maxBytes - totalBytes) {
        fail(Object.assign(new Error('request body too large'), { status: 413 }), true);
        return;
      }
      totalBytes += buffer.length;
      chunks.push(buffer);
    });

    req.on('end', () => {
      if (settled) return;
      let parsed;
      try {
        const raw = Buffer.concat(chunks, totalBytes).toString('utf8');
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        fail(Object.assign(new Error('invalid JSON'), { status: 400 }));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(Object.assign(new Error('JSON body must be an object'), { status: 400 }));
        return;
      }
      settled = true;
      resolve(parsed);
    });

    req.on('error', (error) => fail(error));
    req.on('aborted', () => fail(Object.assign(new Error('request aborted'), { status: 400 })));
  });
}
