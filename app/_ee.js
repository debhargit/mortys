const express = require('express');
const http = require('http');
const app = express();
app.use(express.json());
// Mock the auth signin endpoint
app.post('/api/auth/signin', (req, res) => {
  const { email, password } = req.body || {};
  if (email === 'admin@melthahonda.com' && password === 'password123') {
    return res.json({ user: { id: 1, email, name: 'Admin', is_admin: true } });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});
app.get('/api/me', (req, res) => res.json({ user: null }));
app.use(express.static(__dirname, { index: false, extensions: ['html'], fallthrough: true }));
app.get('*', (req, res) => res.sendFile(__dirname + '/index.html'));
const server = app.listen(0, () => {
  const port = server.address().port;
  function req(path, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const r = http.request({ port, path, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
        let chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      if (opts.body) r.write(opts.body);
      r.end();
    });
  }
  (async () => {
    const adm = await req('/admin.html');
    console.log('admin.html →', adm.status, '| has signin form:', adm.body.includes('id="signinForm"'), '| has DOMContentLoaded boot:', adm.body.includes('async function init()'));
    const idx = await req('/');
    console.log('index.html →', idx.status, '| has signin modal injection:', idx.body.includes('SIGN-IN MODAL — inject markup'), '| has navSignin button:', idx.body.includes('id="navSignin"'));
    const auth = await req('/api/auth/signin', { method:'POST', body: JSON.stringify({email:'admin@melthahonda.com',password:'password123'}), headers:{'Content-Type':'application/json'} });
    console.log('/api/auth/signin (correct creds) →', auth.status, '|', auth.body);
    const bad = await req('/api/auth/signin', { method:'POST', body: JSON.stringify({email:'admin@melthahonda.com',password:'wrong'}), headers:{'Content-Type':'application/json'} });
    console.log('/api/auth/signin (bad creds) →', bad.status, '|', bad.body);
    server.close();
  })();
});
