/* eslint no-console: 0 */ // --> OFF

const express = require('express');

const app = express();

app.use(express.static('public'));

app.get('*', (req, res) => {
  res.sendFile('public/index.html', { root: __dirname });
});

app.listen(3001, () => {
  console.log('Express listening on port 3001.');
});
