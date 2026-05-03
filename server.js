require('dotenv').config();
const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const mongoose  = require('mongoose');
const cors      = require('cors');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve dashboard
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
app.get('/', (req, res) => res.redirect('/dashboard'));

// Auth middleware
const auth = require('./middleware/auth');

// Routes (all under /api)
app.use('/api/accounts',    auth, require('./routes/accounts'));
app.use('/api/proxies',     auth, require('./routes/proxies'));
app.use('/api/jobs',        auth, require('./routes/jobs'));
app.use('/api/logs',        auth, require('./routes/logs'));
app.use('/api/proxy-rules',      auth, require('./routes/proxy-rules'));
app.use('/api/account-creator', auth, require('./routes/account-creator'));

// Health check (no auth needed)
app.get('/health', (req, res) => res.json({
  status: 'running',
  uptime: process.uptime(),
  time: new Date()
}));

// Socket.io
io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);
  socket.on('disconnect', () => console.log('[Socket] Client disconnected:', socket.id));
});

// Pass io to services
require('./services/logger').setIo(io);
require('./services/jobProcessor').setIo(io);
require('./services/accountCreator').setIo(io);

// MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('[DB] MongoDB connected');

    // ── FIX: Reset any jobs stuck in "running" from a previous crash ──────
    // Every restart means any "running" job has no processor — mark them failed
    // so they can be retried cleanly from the dashboard.
    const Job = require('./models/Job');
    try {
      const stuck = await Job.updateMany(
        { status: 'running' },
        {
          $set: {
            status:       'failed',
            progressText: 'Failed',
            errorMessage: 'Server restarted during execution — click Retry to requeue',
            completedAt:  new Date()
          }
        }
      );
      if (stuck.modifiedCount > 0) {
        console.log(`[Startup] Reset ${stuck.modifiedCount} stuck running job(s) → failed`);
      }
    } catch (cleanupErr) {
      console.error('[Startup] Failed to clean stuck jobs:', cleanupErr.message);
    }
    // ── End fix ───────────────────────────────────────────────────────────

    server.listen(process.env.PORT || 4000, () => {
      console.log(`[Engine] Running on port ${process.env.PORT || 4000}`);
      console.log(`[Engine] Dashboard: http://localhost:${process.env.PORT || 4000}/dashboard`);

      // Start job queue worker
      require('./services/jobProcessor').startQueueWorker();

      // Health checks run via the dashboard Check button (manual) or auto-scheduled
      // via Account.healthCheckAt field — no separate worker needed

      // Log startup
      require('./services/logger').success('System', 'Engine started', `Port ${process.env.PORT || 4000}`);
    });
  })
  .catch(err => {
    console.error('[DB] MongoDB connection failed:', err.message);
    process.exit(1);
  });

module.exports = { io };
