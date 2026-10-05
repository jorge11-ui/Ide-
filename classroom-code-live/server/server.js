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

// roomId -> Map(studentId -> { name, language, code, updatedAt, online, socketId })
const rooms = new Map();
// roomId -> true quando a professora congelou a turma
const frozen = new Map();
// Tarefas recentes são reenviadas a alunos que entram ou reconectam a meio da aula.
const tasksByRoom = new Map();
// roomId -> Map(studentId -> { name, language, code, updatedAt, online, socketId })
const sock2id = new Map(); // socket.id -> { roomId, studentId } (para mapear disconnects)
function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}
function roomState(roomId) {
  const room = getRoom(roomId);
  return [...room.entries()].map(([studentId, s]) => ({ studentId, name: s.name, language: s.language, code: s.code || '', online: !!s.online, updatedAt: s.updatedAt || 0 }));
}
// ---- persistência em disco: roster + último código sobrevivem a refresh/disconnect.
// NOTA: no Render (disco efémero) sobrevive a disconnects mas perde-se em restarts/redeploys;
// a página da professora guarda ainda uma cópia em cache no browser como reserva.
const fs = require('fs');
const DATA_DIR = path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const dirty = new Set();
function dataFile(roomId) { return path.join(DATA_DIR, String(roomId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) + '.json'); }
function markDirty(roomId) { dirty.add(roomId); }
setInterval(() => {
  dirty.forEach((roomId) => {
    try { fs.writeFileSync(dataFile(roomId), JSON.stringify([...getRoom(roomId).entries()])); } catch (e) {}
  });
  dirty.clear();
}, 3000);
try {
  fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json') && f !== 'tasks.json').forEach((f) => {
    try {
      const roomId = f.slice(0, -5);
      JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')).forEach(([sid, s]) => {
        getRoom(roomId).set(String(sid), { name: String((s && s.name) || 'Aluno'), language: (s && s.language) || 'python', code: (s && s.code) || '', updatedAt: (s && s.updatedAt) || 0, online: false, socketId: null });
      });
    } catch (e) {}
  });
} catch (e) {}

const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
function persistTasks() {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify([...tasksByRoom.entries()]));
  } catch (error) {
    console.error('Não foi possível guardar tarefas e entregas:', error.message);
  }
}
try {
  if (fs.existsSync(TASKS_FILE)) {
    const savedTasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    if (Array.isArray(savedTasks)) {
      savedTasks.forEach(([roomId, tasks]) => {
        if (typeof roomId === 'string' && Array.isArray(tasks)) {
          tasksByRoom.set(roomId, tasks.filter(task =>
            task && typeof task.id === 'string' && Array.isArray(task.submissions)
          ).slice(-20));
        }
      });
    }
  }
} catch (error) {
  console.error('Não foi possível carregar tarefas guardadas:', error.message);
}
function publicTask(task, studentId) {
  const { submissions, ...details } = task;
  return {
    ...details,
    mySubmission: submissions.filter(submission => submission.studentId === studentId).slice(-1)[0] || null
  };
}
function teacherTask(task) {
  return { ...task, submissions: task.submissions.slice() };
}

io.on('connection', (socket) => {
  let myRoom = null;
  let myRole = null;
  let myStudentId = null;

  socket.on('join_room', ({ roomId, name, role, language, studentId }) => {
    if (!roomId) return;
    const nextRoom = String(roomId);
    const nextRole = role === 'teacher' ? 'teacher' : 'student';
    if (myRoom && (myRoom !== nextRoom || myRole !== nextRole)) {
      const previousRoom = myRoom;
      if (myRole === 'student') {
        const previousLink = sock2id.get(socket.id);
        sock2id.delete(socket.id);
        if (previousLink) {
          const previousStudent = getRoom(previousRoom).get(previousLink.studentId);
          if (previousStudent && previousStudent.socketId === socket.id) {
            previousStudent.online = false;
            previousStudent.socketId = null;
            markDirty(previousRoom);
          }
        }
      }
      socket.leave(myRoom);
      socket.leave(myRoom + ':teachers');
      io.to(previousRoom).emit('room_state', roomState(previousRoom));
    }
    myRoom = nextRoom;
    myRole = nextRole;
    myStudentId = null;
    socket.join(myRoom);
    if (myRole === 'teacher') socket.join(myRoom + ':teachers');

    if (myRole === 'student') {
      const sid = String(studentId || socket.id).slice(0, 80); // registado ou legado
      myStudentId = sid;
      const room = getRoom(myRoom);
      const prev = room.get(sid);
      room.set(sid, {
        name: String(name || (prev && prev.name) || 'Aluno').slice(0, 40),
        language: String(language || (prev && prev.language) || 'python'),
        code: (prev && prev.code) || '',
        updatedAt: Date.now(),
        online: true,
        socketId: socket.id
      });
      sock2id.set(socket.id, { roomId: myRoom, studentId: sid });
      markDirty(myRoom);
    }
    // Roster completo (inclui offline); quem entra recebe o freeze atual
    io.to(myRoom).emit('room_state', roomState(myRoom));
    // Quem entra (aluno ou professora) recebe logo o estado de freeze atual
    socket.emit('freeze_state', { frozen: frozen.get(myRoom) === true });
    const roomTasks = tasksByRoom.get(myRoom) || [];
    socket.emit('class_tasks', myRole === 'teacher'
      ? roomTasks.map(teacherTask)
      : roomTasks.map(task => publicTask(task, myStudentId)));
  });

  socket.on('code_update', ({ roomId, code, language }) => {
    const r = String(roomId || myRoom || '');
    if (!r) return;
    const link = sock2id.get(socket.id);
    const sid = (link && link.roomId === r) ? link.studentId : null;
    if (!sid) return;
    const room = getRoom(r);
    const entry = room.get(sid) || { name: 'Aluno', language: 'python', code: '', updatedAt: 0, online: true, socketId: socket.id };
    entry.code = String(code || '').slice(0, 100000); // limite anti-abuso
    if (language) entry.language = String(language);
    entry.updatedAt = Date.now();
    entry.online = true;
    entry.socketId = socket.id;
    room.set(sid, entry);
    markDirty(r);
    // envia só para os outros (professora + não ecoa ao próprio aluno)
    socket.to(r).emit('code_update', { studentId: sid, name: entry.name, code: entry.code, language: entry.language });
  });

  // Professora pede snapshot (quando entra a meio da aula)
  socket.on('request_snapshot', ({ roomId }) => {
    const r = String(roomId || myRoom || '');
    if (!r) return;
    socket.to(r).emit('request_state');
  });

  // Only a teacher may publish an assignment to the room they joined.
  socket.on('publish_task', (payload = {}) => {
    const { roomId, title, description } = payload && typeof payload === 'object' ? payload : {};
    const r = String(roomId || myRoom || '');
    if (!r || myRole !== 'teacher' || r !== myRoom) {
      socket.emit('task_error', { message: 'Não foi possível publicar a tarefa nesta sala.' });
      return;
    }
    const safeTitle = String(title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
    const safeDescription = String(description || '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
    if (!safeTitle || !safeDescription) {
      socket.emit('task_error', { message: 'Preenche o título e as instruções da tarefa.' });
      return;
    }
    const task = {
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9),
      roomId: r,
      title: safeTitle,
      description: safeDescription,
      createdAt: Date.now(),
      submissions: []
    };
    const roomTasks = tasksByRoom.get(r) || [];
    roomTasks.push(task);
    if (roomTasks.length > 20) roomTasks.shift();
    tasksByRoom.set(r, roomTasks);
    persistTasks();
    io.to(r).emit('class_task', publicTask(task, null));
    io.to(r + ':teachers').emit('teacher_task', teacherTask(task));
  });

  socket.on('submit_task', (payload = {}) => {
    const { roomId, taskId, code, language } = payload && typeof payload === 'object' ? payload : {};
    const r = String(roomId || myRoom || '');
    const link = sock2id.get(socket.id);
    if (!r || myRole !== 'student' || r !== myRoom || !link || link.roomId !== r) {
      socket.emit('submission_error', { taskId, message: 'Não foi possível entregar nesta sala.' });
      return;
    }
    const room = getRoom(r);
    const student = room.get(link.studentId);
    const task = (tasksByRoom.get(r) || []).find(entry => entry.id === taskId);
    if (!student || !task || typeof code !== 'string' || code.length > 100000) {
      socket.emit('submission_error', { taskId, message: 'Tarefa ou código inválido. Atualiza a página e tenta novamente.' });
      return;
    }
    const submission = {
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9),
      taskId: task.id,
      studentId: link.studentId,
      studentName: student.name,
      language: String(language || student.language || 'python').slice(0, 30),
      code,
      submittedAt: Date.now()
    };
    task.submissions.push(submission);
    persistTasks();
    socket.emit('submission_saved', { taskId: task.id, submission: { ...submission } });
    io.to(r + ':teachers').emit('task_submission', { taskId: task.id, submission: { ...submission } });
  });

  // Professora congela/descongela a turma (só aceite de teacher)
  socket.on('freeze', ({ roomId, frozen: f }) => {
    const r = String(roomId || myRoom || '');
    if (!r || myRole !== 'teacher') return;
    frozen.set(r, f === true);
    io.to(r).emit('freeze_state', { frozen: frozen.get(r) });
  });

  socket.on('disconnect', () => {
    const link = sock2id.get(socket.id);
    sock2id.delete(socket.id);
    if (!link) return;
    const room = getRoom(link.roomId);
    const entry = room.get(link.studentId);
    // Marca offline mas MANTÉM o código: continua visível à professora
    if (entry && entry.socketId === socket.id) {
      entry.online = false;
      entry.socketId = null;
      markDirty(link.roomId);
      io.to(link.roomId).emit('student_left', { studentId: link.studentId });
      io.to(link.roomId).emit('room_state', roomState(link.roomId));
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
