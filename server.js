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
  cors: { origin: '*', methods: ['GET','POST','DELETE'] }
});

app.use(cors());
app.use(express.json());
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
app.get('/', (req, res) => res.redirect('/dashboard'));

// Simple API key auth
const auth = (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (process.env.API_KEY && key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Auth check endpoint — dashboard calls this to validate key before showing UI
// Returns 200 OK if key is valid, 401 if not
app.post('/api/auth', (req, res) => {
  const { key } = req.body;
  if (!process.env.API_KEY) return res.status(500).json({ error: 'API_KEY not set on server' });
  if (key !== process.env.API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  res.json({ ok: true });
});

app.use('/api/farm', auth, require('./routes/farm'));
app.get('/health', (req, res) => res.json({ status: 'running', uptime: process.uptime() }));

// Socket.io
io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);

  // Client requests to watch a specific profile's live feed
  socket.on('watch_profile', (profileId) => {
    socket.join(`profile_${profileId}`);
    console.log(`[Socket] ${socket.id} watching profile ${profileId}`);
  });
  socket.on('unwatch_profile', (profileId) => socket.leave(`profile_${profileId}`));
  socket.on('disconnect', () => console.log('[Socket] Disconnected:', socket.id));
});

// Pass io to farm service
const farm = require('./services/browserFarm');
farm.setIo(io);

// Override emit to route frames only to watchers of that profile (bandwidth efficiency)
const _originalEmit = io.emit.bind(io);
io.emit = (event, data) => {
  if (event === 'farm_frame' && data?.profileId) {
    // Only send frames to sockets watching this profile
    io.to(`profile_${data.profileId}`).emit(event, data);
    return;
  }
  _originalEmit(event, data);
};

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('[DB] MongoDB connected');
    server.listen(process.env.PORT || 5000, () => {
      console.log(`[Farm] Running on port ${process.env.PORT || 5000}`);
      farm.startScheduler();
    });
  })
  .catch(err => {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  });
