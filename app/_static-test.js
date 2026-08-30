const express = require('express');
const http = require('http');
const fs = require('fs');
const app = express();
app.use('/uploads', express.static(__dirname + '/uploads', { fallthrough: true }));
app.use(express.static(__dirname, { index: false, extensions: ['html'], fallthrough: true }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(__dirname + '/index.html');
});

const server = app.listen(0, () => {
  const port = server.address().port;
  
  function req(path) {
    return new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
      });
    });
  }
  
  (async () => {
    const adm = await req('/admin.html');
    const admBody = adm.body.toString();
    console.log('/admin.html →', adm.status, '| type:', adm.type, '| has "Meltha Honda Admin":', admBody.includes('Meltha Honda Admin'));
    
    const idx = await req('/');
    const idxBody = idx.body.toString();
    console.log('/ →', idx.status, '| type:', idx.type, '| has "Meltha Honda":', idxBody.includes('Meltha Honda'));
    
    const pos = await req('/posinvoice.html');
    console.log('/posinvoice.html →', pos.status, '| type:', pos.type, '| has "POS Invoice":', pos.body.toString().includes('POS Invoice'));
    
    const webp = fs.readdirSync(__dirname).find(f => f.endsWith('.webp'));
    if (webp) {
      const img = await req('/' + encodeURIComponent(webp));
      console.log('/(webp) →', img.status, '| type:', img.type, '| size:', img.body.length, 'bytes');
    }
    
    server.close();
  })();
});
