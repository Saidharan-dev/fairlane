require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const catalog = require('./catalog');
const { AllocationEngine } = require('./allocation');
const { buildPaymentAdapter } = require('./payment');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---- Demo control state: force-fail one agent's payment on cue ----
let forceFailAgentId = null;

const paymentAdapter = buildPaymentAdapter({
  getForceFailAgentId: () => forceFailAgentId,
  clearForceFailAgentId: () => { forceFailAgentId = null; },
});

const engine = new AllocationEngine(catalog, {
  onAudit: (record) => io.emit('audit', record),
  onBroadcast: (event) => io.emit('event', event),
  paymentAdapter,
});

// ---- REST API ----

// Current catalog / stock snapshot
app.get('/api/catalog', (req, res) => {
  res.json(catalog);
});

// Full audit trail (for the dashboard on load / refresh)
app.get('/api/audit', (req, res) => {
  res.json(engine.auditTrail);
});

// An AI buyer agent submits a bid for an item.
// body: { agentId, itemId, bidAmount, urgency (0-1), loyalty (0-1) }
app.post('/api/bid', (req, res) => {
  const { agentId, itemId, bidAmount, urgency, loyalty, reasoning, llmUsed } = req.body || {};
  if (!agentId || !itemId || bidAmount == null) {
    return res.status(400).json({ error: 'agentId, itemId, and bidAmount are required' });
  }
  const result = engine.submitBid({ agentId, itemId, bidAmount, urgency, loyalty, reasoning, llmUsed });
  res.json(result);
});

// Demo control: close a batch early instead of waiting out the window.
app.post('/api/demo/force-close/:itemId', (req, res) => {
  const result = engine.forceCloseBatch(req.params.itemId);
  res.json(result);
});

// Demo control: make a specific agent's next payment fail, to reliably
// demonstrate the live-reallocation flow during a pitch.
app.post('/api/demo/force-fail', (req, res) => {
  const { agentId } = req.body || {};
  forceFailAgentId = agentId || null;
  res.json({ forceFailAgentId });
});

// Demo control: reset stock/state between runs.
app.post('/api/demo/reset', (req, res) => {
  Object.assign(catalog, require('./catalog-reset')());
  engine.auditTrail = [];
  forceFailAgentId = null;
  io.emit('reset');
  res.json({ reset: true });
});

io.on('connection', (socket) => {
  socket.emit('bootstrap', { catalog, audit: engine.auditTrail });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`FairLane backend running on http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/index.html`);
});
