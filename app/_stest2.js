const express = require('express');
const http = require('http');
const app = express();
app.use(express.static(__dirname, { index: false, extensions: ['html'], fallthrough: true }));
app.get('*', (req, res) => res.sendFile(__dirname + '/index.html'));
const server = app.listen(0, () => {
  const port = server.address().port;
  http.get(`http://127.0.0.1:${port}/admin.html`, (res) => {
    let chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const title = (body.match(/<title>([^<]+)<\/title>/) || [])[1];
      console.log('TITLE returned:', JSON.stringify(title));
      console.log('Is admin page?', title && title.toLowerCase().includes('admin'));
      console.log('Is SPA fallback?', title && title.toLowerCase().includes('parts ltd'));
      server.close();
    });
  });
});
