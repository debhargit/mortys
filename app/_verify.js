const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.post('/api/auth/signin', (req, res) => {
  if (req.body && req.body.email === 'admin@melthahonda.com' && req.body.password === 'password123') {
    return res.json({ user: { id: 1, email: 'admin@melthahonda.com', name: 'Admin', is_admin: true } });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});
app.get('/api/me', (req, res) => res.json({ user: null }));
app.use('/uploads', express.static(__dirname + '/uploads', { fallthrough: true }));
app.use(express.static(__dirname, { index: false, extensions: ['html'], fallthrough: true }));
app.get('*', (req, res) => res.sendFile(__dirname + '/index.html'));

const server = app.listen(0, () => {
  const port = server.address().port;
  
  function req(p) {
    return new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}${p}`, (res) => {
        let chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
      });
    });
  }
  
  (async () => {
    console.log('=== Storefront (index.html) ===');
    const idx = await req('/');
    const idxBody = idx.body.toString();
    console.log('  status:', idx.status, '| size:', idx.body.length);
    console.log('  has hero slider markup:', idxBody.includes('id="heroSlider"'));
    console.log('  has slider track:', idxBody.includes('id="sliderTrack"'));
    console.log('  has HERO SLIDER JS:', idxBody.includes('// HERO SLIDER'));
    console.log('  has signin modal injector:', idxBody.includes('SIGN-IN MODAL — inject markup'));
    
    console.log('\n=== Slider images ===');
    const sliderImgs = ['2022 BMW i4 m50.jpg', '2020 lexr rx450.jpg', '2019 lexus es.jpg'];
    for (const i of sliderImgs) {
      const r = await req('/' + encodeURIComponent(i));
      console.log(`  /${i} →`, r.status, '| type:', r.type, '| size:', r.body.length);
    }
    
    console.log('\n=== Admin page ===');
    const adm = await req('/admin.html');
    const admBody = adm.body.toString();
    console.log('  status:', adm.status, '| size:', adm.body.length);
    console.log('  has signin form:', admBody.includes('id="signinForm"'));
    console.log('  has init function:', admBody.includes('async function init()'));
    console.log('  has DOMContentLoaded boot calling /api/me:', /DOMContentLoaded[\s\S]{1,300}\/api\/me/.test(admBody));
    console.log('  renderers re-bound (renderers.customers = ...):', admBody.includes('renderers.customers      = renderCustomers'));
    
    server.close();
  })();
});
