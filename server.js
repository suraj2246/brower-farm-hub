require('dotenv').config();
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const mongoose  = require('mongoose');
const cors      = require('cors');
const path      = require('path');
const { verifyShareSession } = require('./services/shareSessions');

// — Fail closed on missing critical env vars —
if (!process.env.API_KEY) {
  console.error('❌ API_KEY env var is required. Set it in Railway → Variables and redeploy.');
  process.exit(1);
}
if (!process.env.MONGO_URI) {
  console.error('❌ MONGO_URI env var is required.');
  process.exit(1);
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','DELETE','PATCH'] },
  maxHttpBufferSize: 1e6,
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
app.get('/', (_req, res) => res.redirect('/dashboard'));

// — API key middleware —
const requireApiKey = (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// Dashboard login check
app.post('/api/auth', (req, res) => {
  const { key } = req.body || {};
  if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  res.json({ ok: true });
});

// Protected API
app.use('/api/farm', requireApiKey, require('./routes/farm'));

// Public share viewer (password-protected at app level)
app.use('/share', require('./routes/share'));

app.get('/health', (_req, res) => res.json({ status: 'running', uptime: process.uptime() }));

// — Socket.io handshake auth —
io.use((socket, next) => {
  const a = socket.handshake.auth  || {};
  const q = socket.handshake.query || {};

  // Path 1: admin (API key)
  if (a.apiKey === process.env.API_KEY || q.apiKey === process.env.API_KEY) {
    socket.data.role = 'admin';
    return next();
  }

  // Path 2: share session token
  const sessTok = a.shareSession || q.shareSession;
  if (sessTok) {
    const sess = verifyShareSession(sessTok);
    if (sess) {
      socket.data.role      = 'share';
      socket.data.profileId = sess.profileId;
      return next();
    }
    return next(new Error('Invalid or expired share session'));
  }

  next(new Error('Authentication required'));
});

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id} role=${socket.data.role}`);

  if (socket.data.role === 'admin') {
    socket.join('admins');
  } else if (socket.data.role === 'share' && socket.data.profileId) {
    socket.join(`profile_${socket.data.profileId}`);
  }

  socket.on('watch_profile', (profileId) => {
    if (socket.data.role === 'share' && profileId !== socket.data.profileId) return;
    socket.join(`profile_${profileId}`);
  });

  socket.on('unwatch_profile', (profileId) => {
    if (socket.data.role === 'share') return; // share sockets stay in their assigned room
    socket.leave(`profile_${profileId}`);
  });

  socket.on('browser_input', async (data) => {
    try {
      let profileId = data?.profileId;
      // Share sockets always target their own profile, regardless of payload
      if (socket.data.role === 'share') profileId = socket.data.profileId;
      if (!profileId) return;
      const farm = require('./services/browserFarm');
      await farm.dispatchInput(profileId, data);
    } catch (e) {
      socket.emit('input_error', { error: e.message });
    }
  });

  socket.on('disconnect', () => console.log('[Socket] Disconnected:', socket.id));
});

// — Event routing —
// farm_frame → only watchers of that profile
// profile-scoped events → admins + share viewers of THAT profile (deduped by socket.io)
// other events → admins only
const profileScoped = new Set([
  'farm_log','session_started','session_ended','session_killed','profile_ready','profile_deleted'
]);

const _originalEmit = io.emit.bind(io);
io.emit = (event, data) => {
  if (event === 'farm_frame' && data?.profileId) {
    io.to(`profile_${data.profileId}`).emit(event, data);
    return;
  }
  if (event === 'profile_update' && data?._id) {
    // Admins always; share viewer only if it's their profile
    io.to(['admins', `profile_${data._id}`]).emit(event, data);
    return;
  }
  const pid = data?.profileId;
  if (pid && profileScoped.has(event)) {
    io.to(['admins', `profile_${pid}`]).emit(event, data);
    return;
  }
  // Default fallback: admins only
  io.to('admins').emit(event, data);
};

// — Start —
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✓ MongoDB connected');
    const farm = require('./services/browserFarm');
    farm.setIo(io);
    farm.startScheduler();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`✓ Browser Farm listening on :${PORT}`);
      console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
    });
  })
  .catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });
