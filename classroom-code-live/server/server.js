const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve o client/ (index.html do aluno + teacher.html da professora)
// O servidor corre no PC da professora: alunos acedem via http://IP-LOCAL:3000
app.use(express.static(path.join(__dirname, '../client')));
app.get('/health', (req, res) => res.json({ ok: true }));

// roomId -> Map(socketId -> { name, language, code, updatedAt })
const rooms = new Map();
function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}
function roomState(roomId) {
  const room = getRoom(roomId);
  return [...room.entries()].map(([socketId, s]) => ({ socketId, ...s }));
}

io.on('connection', (socket) => {
  let myRoom = null;
  let myRole = null;

  socket.on('join_room', ({ roomId, name, role, language }) => {
    if (!roomId) return;
    myRoom = String(roomId);
    myRole = role === 'teacher' ? 'teacher' : 'student';
    socket.join(myRoom);

    if (myRole === 'student') {
      getRoom(myRoom).set(socket.id, {
        name: String(name || 'Aluno').slice(0, 40),
        language: String(language || 'javascript'),
        code: '',
        updatedAt: Date.now()
      });
    }
    // Professora nova recebe estado completo; turma fica a saber que há update
    io.to(myRoom).emit('room_state', roomState(myRoom));
  });

  socket.on('code_update', ({ roomId, code, language }) => {
    const r = String(roomId || myRoom || '');
    if (!r) return;
    const room = getRoom(r);
    const entry = room.get(socket.id);
    const text = String(code || '').slice(0, 100000); // limite anti-abuso
    if (entry) {
      entry.code = text;
      if (language) entry.language = String(language);
      entry.updatedAt = Date.now();
    } else {
      // chegou update sem join (reconnect): regista na mesma
      room.set(socket.id, { name: 'Aluno', language: String(language || 'javascript'), code: text, updatedAt: Date.now() });
    }
    const info = room.get(socket.id);
    // envia só para os outros (professora + não ecoa ao próprio aluno)
    socket.to(r).emit('code_update', { socketId: socket.id, name: info.name, code: text, language: info.language });
  });

  // Professora pede snapshot (quando entra a meio da aula)
  socket.on('request_snapshot', ({ roomId }) => {
    const r = String(roomId || myRoom || '');
    if (!r) return;
    socket.to(r).emit('request_state');
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    const room = getRoom(myRoom);
    const wasStudent = room.has(socket.id);
    room.delete(socket.id);
    if (wasStudent) {
      io.to(myRoom).emit('student_left', { socketId: socket.id });
      io.to(myRoom).emit('room_state', roomState(myRoom));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Classroom Code Live a correr:`);
  console.log(`  - Professora (neste PC): http://localhost:${PORT}/teacher.html?room=room_12A`);
  console.log(`  - Alunos (mesma rede):  http://<IP-DESTE-PC>:${PORT}/?room=room_12A`);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  - IP local detetado: http://${n.address}:${PORT}/?room=room_12A`);
    }
  }
  console.log('');
});
