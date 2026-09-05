// Binary uploads for the ported app. app/server.js wrote multer files to
// app/uploads/ and served them with express.static; on Workers there is no
// filesystem, so files live in an R2 bucket (env.UPLOADS) and are served back
// by GET /uploads/* in functions/_routes/media.js.
//
// R2 needs a one-time account opt-in (see wrangler.toml). Until the binding
// exists, putUpload() throws a userFacing 501 and the upload endpoints report
// it cleanly — every non-upload path is unaffected.

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif',
  'image/heic': '.heic', 'application/pdf': '.pdf',
};

export function uploadsEnabled(env) {
  return !!(env && env.UPLOADS);
}

function notConfigured() {
  const e = new Error('File uploads need the R2 "UPLOADS" bucket binding, which is not enabled on this account yet (see wrangler.toml). The record was not saved.');
  e.userFacing = true;
  e.status = 501;
  return e;
}

function extFor(filename, contentType) {
  const m = String(filename || '').toLowerCase().match(/\.[a-z0-9]{1,5}$/);
  if (m) return m[0];
  return EXT_BY_TYPE[String(contentType || '').toLowerCase()] || '';
}

/**
 * Store bytes in R2 under `<prefix>/<timestamp>-<rand><ext>`.
 * @returns {Promise<{key:string, url:string}>}  url is the public /uploads/ path
 */
export async function putUpload(env, { prefix = 'misc', bytes, contentType = 'application/octet-stream', filename = '' }) {
  if (!uploadsEnabled(env)) throw notConfigured();
  const key = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extFor(filename, contentType)}`;
  await env.UPLOADS.put(key, bytes, { httpMetadata: { contentType } });
  return { key, url: '/uploads/' + key };
}

export async function getUpload(env, key) {
  if (!uploadsEnabled(env)) return null;
  return env.UPLOADS.get(key);
}

/**
 * Duplicate an existing R2 object under a fresh key — used by matrix items so
 * every child product gets its own independently-addressable `img` that's a
 * byte-for-byte copy of the one photo the admin uploaded, without touching
 * any of the photo-rendering code that treats `img` as a real, unique path.
 * @returns {Promise<{key:string, url:string}>}
 */
export async function copyUpload(env, sourceKey, { prefix = 'products', filename = '' } = {}) {
  if (!uploadsEnabled(env)) throw notConfigured();
  const obj = await env.UPLOADS.get(sourceKey);
  if (!obj) { const e = new Error('Source photo not found (' + sourceKey + ')'); e.userFacing = true; e.status = 404; throw e; }
  const bytes = await obj.arrayBuffer();
  const contentType = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
  return putUpload(env, { prefix, bytes, contentType, filename: filename || sourceKey });
}

export async function deleteUpload(env, key) {
  if (!uploadsEnabled(env)) return;
  await env.UPLOADS.delete(key);
}

// Pull the first file field out of a parsed multipart body. Returns
// { file, body } — file is null when the caller sent JSON or no file part.
export async function readUploadBody(c, fields) {
  const ct = c.req.header('content-type') || '';
  if (!ct.includes('multipart/form-data') && !ct.includes('application/x-www-form-urlencoded')) {
    return { file: null, body: await c.req.json().catch(() => ({})) };
  }
  const body = await c.req.parseBody();
  for (const f of fields) {
    if (body[f] && typeof body[f] !== 'string') return { file: body[f], body };
  }
  return { file: null, body };
}
