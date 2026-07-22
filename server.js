const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');

// --- Upload de la vidéo ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const roomId = req.params.roomId;
    const ext = path.extname(file.originalname);
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${roomId}-${unique}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } }); // 5 Go max

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.post('/upload/:roomId', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const room = getRoom(req.params.roomId);
  const socketId = req.body.socketId;

  if (room.hostId && socketId !== room.hostId) {
    return res.status(403).json({ error: "Seul l'hôte de la room peut choisir la vidéo" });
  }

  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname
  };
  room.playlist.push(item);

  // Si rien n'est en cours de lecture, on démarre directement sur cet ajout
  if (room.currentIndex === -1) {
    playItem(req.params.roomId, room.playlist.length - 1);
  } else {
    io.to(req.params.roomId).emit('playlist-updated', { playlist: room.playlist, currentIndex: room.currentIndex });
  }

  res.json({ ok: true });
});

function playItem(roomId, index) {
  const room = getRoom(roomId);
  const item = room.playlist[index];
  if (!item) return;
  room.currentIndex = index;
  room.videoUrl = item.url;
  room.videoName = item.name;
  room.playback = { time: 0, playing: true, updatedAt: Date.now() };
  io.to(roomId).emit('video-ready', { url: item.url, name: item.name });
  io.to(roomId).emit('playlist-updated', { playlist: room.playlist, currentIndex: room.currentIndex });
}

// --- État des rooms en mémoire ---
const rooms = {}; // roomId -> { videoUrl, videoName, users: { socketId: pseudo }, playback: { time, playing, updatedAt } }

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      videoUrl: null,
      videoName: null,
      hostId: null,
      users: {},
      playlist: [],
      currentIndex: -1,
      playback: { time: 0, playing: false, updatedAt: Date.now() }
    };
  }
  return rooms[roomId];
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId, pseudo }) => {
    currentRoom = roomId;
    socket.join(roomId);
    const room = getRoom(roomId);

    // Le premier arrivant dans une room vide en devient l'hôte ("le chef")
    if (!room.hostId || !room.users[room.hostId]) {
      room.hostId = socket.id;
    }

    room.users[socket.id] = pseudo || 'Invité';

    // Envoie l'état actuel au nouvel arrivant
    socket.emit('room-state', {
      videoUrl: room.videoUrl,
      videoName: room.videoName,
      playback: room.playback,
      users: room.users,
      hostId: room.hostId,
      isHost: room.hostId === socket.id,
      playlist: room.playlist,
      currentIndex: room.currentIndex
    });

    // Prévient les autres pour établir les connexions WebRTC (mesh)
    socket.to(roomId).emit('user-joined', { id: socket.id, pseudo: room.users[socket.id] });
    io.to(roomId).emit('user-list', room.users);
    io.to(roomId).emit('host-changed', { hostId: room.hostId });
  });

  // --- Synchronisation de la lecture vidéo ---
  socket.on('playback-action', ({ roomId, action, time }) => {
    const room = getRoom(roomId);
    room.playback = {
      time,
      playing: action === 'play',
      updatedAt: Date.now()
    };
    socket.to(roomId).emit('playback-action', { action, time, from: socket.id });
  });

  socket.on('playback-seek', ({ roomId, time }) => {
    const room = getRoom(roomId);
    room.playback.time = time;
    room.playback.updatedAt = Date.now();
    socket.to(roomId).emit('playback-seek', { time, from: socket.id });
  });

  // --- Playlist (contrôlée uniquement par l'hôte) ---
  socket.on('playlist-play', ({ roomId, index }) => {
    const room = getRoom(roomId);
    if (room.hostId !== socket.id) return;
    playItem(roomId, index);
  });

  socket.on('playlist-next', ({ roomId }) => {
    const room = getRoom(roomId);
    if (room.hostId !== socket.id) return;
    if (room.currentIndex + 1 < room.playlist.length) {
      playItem(roomId, room.currentIndex + 1);
    }
  });

  socket.on('playlist-remove', ({ roomId, id }) => {
    const room = getRoom(roomId);
    if (room.hostId !== socket.id) return;
    const idx = room.playlist.findIndex((v) => v.id === id);
    if (idx === -1) return;
    room.playlist.splice(idx, 1);
    if (idx < room.currentIndex) room.currentIndex -= 1;
    else if (idx === room.currentIndex) room.currentIndex = -1;
    io.to(roomId).emit('playlist-updated', { playlist: room.playlist, currentIndex: room.currentIndex });
  });

  // --- Réactions emoji flottantes ---
  socket.on('reaction', ({ roomId, emoji }) => {
    const room = getRoom(roomId);
    io.to(roomId).emit('reaction', { emoji, pseudo: room.users[socket.id] || 'Invité' });
  });

  // --- Chat ---
  socket.on('chat-message', ({ roomId, message, pseudo }) => {
    io.to(roomId).emit('chat-message', { message, pseudo, ts: Date.now() });
  });

  // --- Signalisation WebRTC (mesh peer-to-peer) ---
  socket.on('webrtc-signal', ({ to, signal }) => {
    io.to(to).emit('webrtc-signal', { from: socket.id, signal });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = getRoom(currentRoom);
      delete room.users[socket.id];

      // Si l'hôte part, transfère le rôle à la prochaine personne présente
      if (room.hostId === socket.id) {
        const remaining = Object.keys(room.users);
        room.hostId = remaining.length > 0 ? remaining[0] : null;
        io.to(currentRoom).emit('host-changed', { hostId: room.hostId });
      }

      socket.to(currentRoom).emit('user-left', { id: socket.id });
      io.to(currentRoom).emit('user-list', room.users);
    }
  });
});

server.listen(PORT, () => {
  console.log(`WatchParty lancé sur http://localhost:${PORT}`);
});
