require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const routes = require('./src/api/routes');
const { router: qbwcRouter } = require('./src/ingestion/qbwc/router');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '5mb' }));
app.use('/api', routes);
// QuickBooks Desktop's Web Connector calls this (SOAP over HTTPS); see src/ingestion/qbwc.
app.use('/qbwc', qbwcRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`NRS SI middleware (collect, IRN, sign, QR) running on http://localhost:${PORT}`);
});

module.exports = app;
