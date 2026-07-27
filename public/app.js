const params = new URLSearchParams(window.location.search);
const roomId = params.get('room');
const pseudo = params.get('pseudo') || 'Invité';

if (!roomId) window.location.href = 'index.html';

document.getElementById('roomLabel').textContent = `Room : ${roomId}`;

const socket = io();
const mainVideo = document.getElementById('mainVideo');
const uploadStatus = document.getElementById('uploadStatus');
const uploadLabel = document.getElementById('uploadLabel');
const hostBadge = document.getElementById('hostBadge');

let suppressSync = false; // évite les boucles quand on applique une action reçue du serveur
let isHost = false;

// ---------- Rejoindre la room ----------
socket.emit('join-room', { roomId, pseudo });

socket.on('room-state', ({ videoUrl, videoName, playback, hostId, playlist, currentIndex }) => {
  if (videoUrl) {
    mainVideo.src = videoUrl;
    uploadStatus.textContent = `Lecture de : ${videoName}`;
    mainVideo.currentTime = playback.time;
    if (playback.playing) mainVideo.play().catch(() => {});
  }
  applyHost(hostId);
  renderPlaylist(playlist, currentIndex);
});

socket.on('host-changed', ({ hostId }) => applyHost(hostId));

function applyHost(hostId) {
  isHost = hostId === socket.id;
  uploadLabel.style.display = isHost ? 'inline-flex' : 'none';
  hostBadge.style.display = isHost ? 'inline-block' : 'none';
  if (!isHost && !uploadStatus.textContent) {
    uploadStatus.textContent = "En attente que l'hôte choisisse une vidéo...";
  }
}

socket.on('video-ready', ({ url, name }) => {
  mainVideo.src = url;
  uploadStatus.textContent = `Lecture de : ${name}`;
  mainVideo.play().catch(() => {});
});

let currentPlaylist = [];
let currentPlaylistIndex = -1;

socket.on('playlist-updated', ({ playlist, currentIndex }) => {
  renderPlaylist(playlist, currentIndex);
});

function renderPlaylist(playlist, currentIndex) {
  currentPlaylist = playlist || [];
  currentPlaylistIndex = currentIndex;
  const container = document.getElementById('playlistItems');
  container.innerHTML = '';

  if (currentPlaylist.length === 0) {
    container.innerHTML = '<div class="playlist-empty">Aucune vidéo pour l\'instant</div>';
    return;
  }

  currentPlaylist.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'playlist-item' + (idx === currentIndex ? ' playing' : '');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = (idx === currentIndex ? '▶ ' : `${idx + 1}. `) + item.name;
    row.appendChild(name);

    if (isHost) {
      const actions = document.createElement('span');
      actions.className = 'pl-actions';
      if (idx !== currentIndex) {
        const playBtn = document.createElement('button');
        playBtn.textContent = '▶';
        playBtn.title = 'Lire';
        playBtn.onclick = () => socket.emit('playlist-play', { roomId, index: idx });
        actions.appendChild(playBtn);
      }
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '✕';
      removeBtn.title = 'Retirer';
      removeBtn.onclick = () => socket.emit('playlist-remove', { roomId, id: item.id });
      actions.appendChild(removeBtn);
      row.appendChild(actions);
    }

    container.appendChild(row);
  });
}

// Quand la vidéo se termine, seul l'hôte déclenche le passage à la suivante
// (évite que chaque client tente de le faire en même temps)
mainVideo.addEventListener('ended', () => {
  if (isHost) socket.emit('playlist-next', { roomId });
});

// ---------- Upload vidéo ----------
document.getElementById('videoFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  uploadStatus.textContent = `Envoi de "${file.name}"...`;
  const formData = new FormData();
  formData.append('video', file);
  formData.append('socketId', socket.id);
  try {
    const res = await fetch(`/upload/${roomId}`, { method: 'POST', body: formData });
    if (res.status === 403) {
      uploadStatus.textContent = "Seul l'hôte peut choisir la vidéo";
      return;
    }
    if (!res.ok) throw new Error('upload failed');
    uploadStatus.textContent = `Envoyé : ${file.name}`;
  } catch (err) {
    uploadStatus.textContent = "Erreur lors de l'envoi de la vidéo";
  }
});

// ---------- Synchronisation lecture ----------
mainVideo.addEventListener('play', () => {
  if (suppressSync) return;
  socket.emit('playback-action', { roomId, action: 'play', time: mainVideo.currentTime });
});
mainVideo.addEventListener('pause', () => {
  if (suppressSync) return;
  socket.emit('playback-action', { roomId, action: 'pause', time: mainVideo.currentTime });
});
let seekTimeout;
mainVideo.addEventListener('seeked', () => {
  if (suppressSync) return;
  clearTimeout(seekTimeout);
  seekTimeout = setTimeout(() => {
    socket.emit('playback-seek', { roomId, time: mainVideo.currentTime });
  }, 150);
});

socket.on('playback-action', ({ action, time }) => {
  suppressSync = true;
  if (Math.abs(mainVideo.currentTime - time) > 0.75) mainVideo.currentTime = time;
  if (action === 'play') mainVideo.play().catch(() => {});
  else mainVideo.pause();
  setTimeout(() => (suppressSync = false), 200);
});

socket.on('playback-seek', ({ time }) => {
  suppressSync = true;
  mainVideo.currentTime = time;
  setTimeout(() => (suppressSync = false), 200);
});

// ---------- Chat ----------
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  socket.emit('chat-message', { roomId, message, pseudo });
  chatInput.value = '';
});

socket.on('chat-message', ({ message, pseudo: from, ts }) => {
  const div = document.createElement('div');
  div.className = 'msg';
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `<span class="pseudo">${escapeHtml(from)}</span> <span style="color:#666;font-size:0.7rem">${time}</span><br>${escapeHtml(message)}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Appel vidéo (WebRTC mesh, caméra/micro opt-in) ----------
const videoGrid = document.getElementById('videoGrid');
const peerConns = {}; // socketId -> { pc, polite, makingOffer, pseudo }
const peerVideos = {}; // socketId -> <div> tuile
let localStream = new MediaStream(); // vide au départ : personne n'est forcé d'activer cam/micro

const ICE_SERVERS = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function addVideoTile(id, stream, label, muted) {
  const wrapper = document.createElement('div');
  wrapper.id = `tile-${id}`;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = muted;
  video.srcObject = stream;
  const labelEl = document.createElement('div');
  labelEl.className = 'peer-label';
  labelEl.textContent = label;
  wrapper.appendChild(video);
  wrapper.appendChild(labelEl);
  videoGrid.appendChild(wrapper);
  peerVideos[id] = wrapper;
}

function removeVideoTile(id) {
  const el = document.getElementById(`tile-${id}`);
  if (el) el.remove();
  delete peerVideos[id];
}

// On utilise le pattern de "négociation parfaite" (perfect negotiation) pour pouvoir
// ajouter/retirer la caméra ou le micro à tout moment, même une fois déjà connecté.
function createPeerConnection(peerId, pseudoPeer) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  const polite = socket.id < peerId; // les deux pairs calculent l'inverse l'un de l'autre
  const state = { pc, polite, makingOffer: false, ignoreOffer: false, pseudo: pseudoPeer };
  peerConns[peerId] = state;

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('webrtc-signal', { to: peerId, signal: { sdp: pc.localDescription } });
    } catch (err) {
      console.warn('Erreur négociation', err);
    } finally {
      state.makingOffer = false;
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc-signal', { to: peerId, signal: { candidate: e.candidate } });
    }
  };

  pc.ontrack = (e) => {
    if (!peerVideos[peerId]) {
      addVideoTile(peerId, e.streams[0], state.pseudo || 'Invité', false);
    }
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      removeVideoTile(peerId);
    }
  };

  return state;
}

socket.on('user-joined', ({ id, pseudo: peerPseudo }) => {
  createPeerConnection(id, peerPseudo);
  // onnegotiationneeded se déclenchera tout seul si on a déjà des pistes actives
});

socket.on('webrtc-signal', async ({ from, signal }) => {
  const state = peerConns[from] || createPeerConnection(from);
  const { pc, polite } = state;

  try {
    if (signal.sdp) {
      const offerCollision = signal.sdp.type === 'offer' &&
        (state.makingOffer || pc.signalingState !== 'stable');
      state.ignoreOffer = !polite && offerCollision;
      if (state.ignoreOffer) return;

      if (offerCollision) {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription(signal.sdp)
        ]);
      } else {
        await pc.setRemoteDescription(signal.sdp);
      }

      if (signal.sdp.type === 'offer') {
        await pc.setLocalDescription();
        socket.emit('webrtc-signal', { to: from, signal: { sdp: pc.localDescription } });
      }
    } else if (signal.candidate) {
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch (err) {
        if (!state.ignoreOffer) console.warn('Erreur ICE candidate', err);
      }
    }
  } catch (err) {
    console.warn('Erreur signalisation WebRTC', err);
  }
});

socket.on('user-left', ({ id }) => {
  if (peerConns[id]) {
    peerConns[id].pc.close();
    delete peerConns[id];
  }
  removeVideoTile(id);
});

// ---------- Contrôles caméra / micro (opt-in, off par défaut) ----------
const camBtn = document.getElementById('toggleCamBtn');
const micBtn = document.getElementById('toggleMicBtn');
let localTileAdded = false;

function ensureLocalTile() {
  if (!localTileAdded) {
    addVideoTile('local', localStream, 'Toi', true);
    localTileAdded = true;
  }
}

function removeLocalTileIfEmpty() {
  if (localStream.getTracks().length === 0 && localTileAdded) {
    removeVideoTile('local');
    localTileAdded = false;
  }
}

async function toggleCamera() {
  const existing = localStream.getVideoTracks()[0];
  if (existing) {
    // Désactivation : on retire la piste de tout le monde et on coupe la caméra
    localStream.removeTrack(existing);
    existing.stop();
    Object.values(peerConns).forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) pc.removeTrack(sender);
    });
    camBtn.textContent = '📷 Activer la caméra';
    camBtn.classList.remove('on');
    removeLocalTileIfEmpty();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    localStream.addTrack(track);
    ensureLocalTile();
    Object.values(peerConns).forEach(({ pc }) => pc.addTrack(track, localStream));
    camBtn.textContent = '📷 Désactiver la caméra';
    camBtn.classList.add('on');
  } catch (err) {
    alert("Impossible d'accéder à la caméra");
  }
}

async function toggleMic() {
  const existing = localStream.getAudioTracks()[0];
  if (existing) {
    localStream.removeTrack(existing);
    existing.stop();
    Object.values(peerConns).forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender) pc.removeTrack(sender);
    });
    micBtn.textContent = '🎤 Activer le micro';
    micBtn.classList.remove('on');
    removeLocalTileIfEmpty();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    localStream.addTrack(track);
    ensureLocalTile();
    Object.values(peerConns).forEach(({ pc }) => pc.addTrack(track, localStream));
    micBtn.textContent = '🎤 Désactiver le micro';
    micBtn.classList.add('on');
  } catch (err) {
    alert("Impossible d'accéder au micro");
  }
}

camBtn.onclick = toggleCamera;
micBtn.onclick = toggleMic;

// ---------- Réactions emoji flottantes ----------
const reactionsLayer = document.getElementById('reactionsLayer');

document.getElementById('emojiToggleBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('emojiPicker').classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  const picker = document.getElementById('emojiPicker');
  if (!picker.classList.contains('hidden') && !picker.contains(e.target)) {
    picker.classList.add('hidden');
  }
});

document.querySelectorAll('.reaction-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const emoji = btn.dataset.emoji;
    socket.emit('reaction', { roomId, emoji });
    document.getElementById('emojiPicker').classList.add('hidden');
    // Pas d'affichage local ici : le serveur nous renvoie l'événement 'reaction'
    // à nous aussi, donc l'afficher ici en plus créerait un doublon.
  });
});

socket.on('reaction', ({ emoji }) => {
  spawnFloatingEmoji(emoji);
});

function spawnFloatingEmoji(emoji) {
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  el.style.right = `${20 + Math.random() * 40}px`;
  reactionsLayer.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ---------- Caster (Chromecast / AirPlay) ----------
const castBtn = document.getElementById('castBtn');

if ('remote' in mainVideo) {
  // Chrome / Edge : API Remote Playback, ouvre le sélecteur Chromecast natif
  // et lance lui-même la recherche des appareils sur le réseau
  castBtn.style.display = 'inline-flex';
  castBtn.addEventListener('click', async () => {
    try {
      await mainVideo.remote.prompt();
    } catch (err) {
      console.warn('Cast annulé ou aucun appareil trouvé', err);
      alert("Aucun appareil de cast trouvé sur le réseau (vérifie que ton Chromecast est sur le même Wi-Fi)");
    }
  });
} else if (typeof mainVideo.webkitShowPlaybackTargetPicker === 'function') {
  // Safari : AirPlay
  castBtn.style.display = 'inline-flex';
  castBtn.textContent = '📺 AirPlay';
  castBtn.addEventListener('click', () => {
    mainVideo.webkitShowPlaybackTargetPicker();
  });
} else {
  // Navigateur sans API de cast (ex: Firefox) : le bouton reste visible
  // mais explique pourquoi ça ne marche pas plutôt que de rester muet
  castBtn.style.display = 'inline-flex';
  castBtn.addEventListener('click', () => {
    alert("Ton navigateur ne supporte pas le cast direct. Essaie avec Chrome, Edge ou Safari.");
  });
}

// ---------- Copier le lien ----------
document.getElementById('copyLinkBtn').onclick = () => {
  const url = `${window.location.origin}/room.html?room=${roomId}`;
  navigator.clipboard.writeText(url);
  alert('Lien copié : ' + url);
};

// ---------- Démarrage ----------
// Rien à initialiser côté média : caméra et micro restent éteints tant que
// l'utilisateur ne clique pas explicitement sur les boutons dédiés.
