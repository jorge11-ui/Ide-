const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 30 * 1024 * 1024 });

const CLIENT_DIR = path.join(__dirname, '../client');
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const STUDENT_REGISTRATIONS_FILE = path.join(DATA_DIR, 'student-registrations.json');
const TEACHER_AUTH_FILE = path.join(DATA_DIR, 'teacher-auth.json');
const TEACHER_CLASSROOMS_FILE = path.join(DATA_DIR, 'classrooms.json');
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || '';
const ENV_SESSION_SECRET = process.env.TEACHER_SESSION_SECRET || '';
const TEACHER_SESSION_MS = 365 * 24 * 60 * 60 * 1000;
const TEACHER_COOKIE = 'ccl_teacher_session';

function readTeacherCredentials() {
  if (!fs.existsSync(TEACHER_AUTH_FILE)) return null;
  const credentials = JSON.parse(fs.readFileSync(TEACHER_AUTH_FILE, 'utf8'));
  if (!credentials || credentials.version !== 1 ||
      typeof credentials.salt !== 'string' || typeof credentials.passwordHash !== 'string' ||
      typeof credentials.sessionSecret !== 'string') {
    throw new Error('O ficheiro de autenticação da professora está inválido.');
  }
  return credentials;
}

let teacherCredentials = readTeacherCredentials();
let teacherSessionSecret = ENV_SESSION_SECRET ||
  (teacherCredentials && teacherCredentials.sessionSecret) ||
  crypto.randomBytes(32).toString('hex');

function signTeacherSession(payload) {
  return crypto.createHmac('sha256', teacherSessionSecret).update(payload).digest('base64url');
}

function isValidTeacherSession(cookieHeader) {
  const cookie = String(cookieHeader || '').split(';').map(part => part.trim())
    .find(part => part.startsWith(TEACHER_COOKIE + '='));
  if (!cookie) return false;
  const token = cookie.slice(TEACHER_COOKIE.length + 1);
  const separator = token.lastIndexOf('.');
  if (separator < 1) return false;
  const payload = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(signTeacherSession(payload));
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(session.expiresAt) && session.expiresAt > Date.now();
  } catch (error) {
    return false;
  }
}

app.use(express.json({ limit: '2kb' }));
app.get('/teacher-auth-status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ setupRequired: !TEACHER_PASSWORD && !teacherCredentials });
});

function issueTeacherSession(req, res) {
  const expiresAt = Date.now() + TEACHER_SESSION_MS;
  const payload = Buffer.from(JSON.stringify({ expiresAt })).toString('base64url');
  const token = `${payload}.${signTeacherSession(payload)}`;
  res.cookie(TEACHER_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: '/',
    maxAge: TEACHER_SESSION_MS
  });
  res.json({ ok: true });
}

app.post('/teacher-auth', (req, res) => {
  const suppliedPassword = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (TEACHER_PASSWORD) {
    const suppliedHash = crypto.createHash('sha256').update(suppliedPassword).digest();
    const expectedHash = crypto.createHash('sha256').update(TEACHER_PASSWORD).digest();
    if (!crypto.timingSafeEqual(suppliedHash, expectedHash)) {
      return res.status(401).json({ message: 'Palavra-passe incorreta.' });
    }
    return issueTeacherSession(req, res);
  }

  if (!teacherCredentials) {
    if (suppliedPassword.length < 12) {
      return res.status(400).json({ message: 'Cria uma palavra-passe com pelo menos 12 caracteres.' });
    }
    const credentials = {
      version: 1,
      salt: crypto.randomBytes(16).toString('base64'),
      passwordHash: '',
      sessionSecret: crypto.randomBytes(32).toString('hex')
    };
    credentials.passwordHash = crypto.scryptSync(suppliedPassword, credentials.salt, 64).toString('base64');
    let fileDescriptor;
    try {
      fileDescriptor = fs.openSync(TEACHER_AUTH_FILE, 'wx', 0o600);
      fs.writeFileSync(fileDescriptor, JSON.stringify(credentials));
      fs.closeSync(fileDescriptor);
      fileDescriptor = undefined;
    } catch (error) {
      if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
      if (error.code === 'EEXIST') {
        teacherCredentials = readTeacherCredentials();
        if (!ENV_SESSION_SECRET && teacherCredentials) {
          teacherSessionSecret = teacherCredentials.sessionSecret;
        }
        return res.status(409).json({ message: 'O acesso da professora já foi configurado. Inicia sessão com a palavra-passe definida.' });
      }
      console.error('Não foi possível guardar o acesso da professora:', error.message);
      return res.status(500).json({ message: 'Não foi possível guardar a configuração no servidor.' });
    }
    teacherCredentials = credentials;
    if (!ENV_SESSION_SECRET) teacherSessionSecret = credentials.sessionSecret;
    return issueTeacherSession(req, res);
  }

  const suppliedHash = crypto.scryptSync(suppliedPassword, teacherCredentials.salt, 64);
  const expectedHash = Buffer.from(teacherCredentials.passwordHash, 'base64');
  if (suppliedHash.length !== expectedHash.length || !crypto.timingSafeEqual(suppliedHash, expectedHash)) {
    return res.status(401).json({ message: 'Palavra-passe incorreta.' });
  }
  issueTeacherSession(req, res);
});

app.post('/teacher-logout', (req, res) => {
  res.clearCookie(TEACHER_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: '/'
  });
  res.json({ ok: true });
});

app.get(['/teacher', '/teacher.html'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!isValidTeacherSession(req.headers.cookie)) {
    return res.sendFile(path.join(CLIENT_DIR, 'teacher-login.html'));
  }
  res.sendFile(path.join(CLIENT_DIR, 'teacher.html'));
});

function requireTeacher(req, res, next) {
  if (!isValidTeacherSession(req.headers.cookie)) {
    return res.status(401).json({ message: 'Inicia sessão como professora.' });
  }
  next();
}

function readClassrooms() {
  try {
    const saved = JSON.parse(fs.readFileSync(TEACHER_CLASSROOMS_FILE, 'utf8'));
    return Array.isArray(saved) ? saved.filter(classroom =>
      classroom && typeof classroom.id === 'string' && typeof classroom.name === 'string'
    ) : [];
  } catch (error) {
    return [];
  }
}

let classrooms = readClassrooms();
function readStudentRegistrations() {
  if (!fs.existsSync(STUDENT_REGISTRATIONS_FILE)) return new Map();
  const saved = JSON.parse(fs.readFileSync(STUDENT_REGISTRATIONS_FILE, 'utf8'));
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    throw new Error('O ficheiro de registos dos alunos está inválido.');
  }
  const entries = Object.entries(saved);
  if (entries.some(([studentId, registration]) =>
    !/^[a-zA-Z0-9_-]{1,80}$/.test(studentId) || !registration ||
    typeof registration.roomId !== 'string' || typeof registration.name !== 'string'
  )) {
    throw new Error('O ficheiro de registos dos alunos está inválido.');
  }
  return new Map(entries);
}
const studentRegistrations = readStudentRegistrations();
function persistStudentRegistrations() {
  try {
    fs.writeFileSync(STUDENT_REGISTRATIONS_FILE, JSON.stringify(Object.fromEntries(studentRegistrations), null, 2));
    return true;
  } catch (error) {
    console.error('Não foi possível guardar os registos dos alunos:', error.message);
    return false;
  }
}
function persistStudentRegistration(studentId, registration) {
  const previous = studentRegistrations.get(studentId);
  studentRegistrations.set(studentId, registration);
  if (persistStudentRegistrations()) return true;
  if (previous) studentRegistrations.set(studentId, previous);
  else studentRegistrations.delete(studentId);
  return false;
}
function persistClassrooms() {
  try {
    fs.writeFileSync(TEACHER_CLASSROOMS_FILE, JSON.stringify(classrooms, null, 2));
    return true;
  } catch (error) {
    console.error('Não foi possível guardar as turmas:', error.message);
    return false;
  }
}

app.get('/teacher-classrooms', requireTeacher, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(classrooms);
});

app.get('/student-classrooms', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(classrooms.map(({ id, name }) => ({ id, name })));
});

app.post('/student-register', (req, res) => {
  const studentId = typeof req.body.studentId === 'string' ? req.body.studentId.trim() : '';
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const roomId = typeof req.body.roomId === 'string' ? req.body.roomId.trim() : '';
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(studentId)) {
    return res.status(400).json({ message: 'Identificador de aluno inválido.' });
  }
  if (!name || name.length > 40) {
    return res.status(400).json({ message: 'O nome deve ter entre 1 e 40 caracteres.' });
  }
  if (!classrooms.some(classroom => classroom.id === roomId)) {
    return res.status(404).json({ message: 'Turma não encontrada. Confirma o convite da professora.' });
  }
  const binding = bindStudentToRoom(studentId, roomId, name);
  if (!binding.ok) {
    if (binding.reason === 'locked') {
      const registeredClass = classrooms.find(classroom => classroom.id === binding.registration.roomId);
      return res.status(409).json({ message: `Este aluno já está registado na turma ${registeredClass ? registeredClass.name : binding.registration.roomId}.` });
    }
    return res.status(500).json({ message: 'Não foi possível guardar o registo. Tenta novamente.' });
  }
  res.status(201).json({ studentId, name: binding.registration.name, roomId: binding.registration.roomId });
});

app.post('/teacher-classrooms', requireTeacher, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const requestedId = typeof req.body.roomId === 'string' ? req.body.roomId.trim() : '';
  if (!name || name.length > 80) {
    return res.status(400).json({ message: 'O nome da turma deve ter entre 1 e 80 caracteres.' });
  }
  if (requestedId && !/^[a-zA-Z0-9_-]{1,60}$/.test(requestedId)) {
    return res.status(400).json({ message: 'O código da turma é inválido.' });
  }
  if (requestedId && classrooms.some(classroom => classroom.id === requestedId)) {
    return res.json(classrooms.find(classroom => classroom.id === requestedId));
  }
  let id = requestedId;
  if (!id) {
    do { id = 'room_' + crypto.randomBytes(6).toString('hex'); }
    while (classrooms.some(classroom => classroom.id === id));
  }
  const classroom = { id, name, createdAt: Date.now() };
  classrooms.push(classroom);
  if (!persistClassrooms()) {
    classrooms.pop();
    return res.status(500).json({ message: 'Não foi possível guardar a turma.' });
  }
  res.status(201).json(classroom);
});

app.patch('/teacher-classrooms/:roomId', requireTeacher, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) {
    return res.status(400).json({ message: 'O nome da turma deve ter entre 1 e 80 caracteres.' });
  }
  const classroom = classrooms.find(item => item.id === req.params.roomId);
  if (!classroom) return res.status(404).json({ message: 'Turma não encontrada.' });
  const previousName = classroom.name;
  classroom.name = name;
  if (!persistClassrooms()) {
    classroom.name = previousName;
    return res.status(500).json({ message: 'Não foi possível guardar o nome da turma.' });
  }
  res.json(classroom);
});

// Serve o client/ (index.html do aluno + teacher.html da professora)
// O servidor corre no PC da professora: alunos acedem via http://IP-LOCAL:3000
app.use(express.static(CLIENT_DIR));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/invite-qr.png', async (req, res) => {
  const roomId = String(req.query.room || '');
  if (!roomId.trim() || roomId.length > 60 || /[\u0000-\u001f]/.test(roomId)) return res.status(400).send('Invalid room code');
  try {
    const invite = `${req.protocol}://${req.get('host')}/?room=${encodeURIComponent(roomId)}`;
    const png = await QRCode.toBuffer(invite, { type: 'png', width: 280, margin: 2, errorCorrectionLevel: 'M' });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  } catch (error) {
    console.error('Não foi possível gerar o QR da turma:', error.message);
    res.status(500).send('QR generation failed');
  }
});

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
  return [...room.entries()].map(([studentId, s]) => ({
    studentId, name: s.name, language: s.language, code: s.code || '',
    online: !!s.online, updatedAt: s.updatedAt || 0, joinedAt: s.joinedAt || 0,
    lastSeenAt: s.lastSeenAt || s.updatedAt || s.joinedAt || 0,
    progressStatus: s.progressStatus || 'not_started',
    progressUpdatedAt: s.progressUpdatedAt || 0
  }));
}
// ---- persistência em disco: roster + último código sobrevivem a refresh/disconnect.
// NOTA: no Render (disco efémero) sobrevive a disconnects mas perde-se em restarts/redeploys;
// a página da professora guarda ainda uma cópia em cache no browser como reserva.
const dirty = new Set();
function dataFile(roomId) { return path.join(DATA_DIR, String(roomId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) + '.json'); }
function markDirty(roomId) { dirty.add(roomId); }
function persistRoomNow(roomId) {
  try {
    fs.writeFileSync(dataFile(roomId), JSON.stringify([...getRoom(roomId).entries()]));
    dirty.delete(roomId);
    return true;
  } catch (error) {
    console.error('Não foi possível guardar a lista de alunos:', error.message);
    return false;
  }
}
setInterval(() => {
  dirty.forEach((roomId) => {
    persistRoomNow(roomId);
  });
}, 3000);
try {
  fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json') &&
    !['tasks.json', 'student-registrations.json', 'teacher-auth.json', 'classrooms.json'].includes(f)).forEach((f) => {
    try {
      const roomId = f.slice(0, -5);
      JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')).forEach(([sid, s]) => {
        getRoom(roomId).set(String(sid), {
          name: String((s && s.name) || 'Aluno'), language: (s && s.language) || 'python',
          code: (s && s.code) || '', updatedAt: (s && s.updatedAt) || 0, online: false, socketId: null,
          joinedAt: (s && s.joinedAt) || (s && s.updatedAt) || 0,
          lastSeenAt: (s && s.lastSeenAt) || (s && s.updatedAt) || 0,
          progressStatus: (s && s.progressStatus) || 'not_started',
          progressUpdatedAt: (s && s.progressUpdatedAt) || 0
        });
      });
    } catch (e) {}
  });
} catch (e) {}

const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
function persistTasks() {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify([...tasksByRoom.entries()]));
    return true;
  } catch (error) {
    console.error('Não foi possível guardar tarefas e entregas:', error.message);
    return false;
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
function findLegacyStudentRegistration(studentId) {
  let match = null;
  for (const [roomId, room] of rooms) {
    const student = room.get(studentId);
    if (!student) continue;
    const lastSeenAt = student.lastSeenAt || student.updatedAt || 0;
    if (!match || lastSeenAt > match.lastSeenAt) {
      match = { roomId, name: student.name || 'Aluno', lastSeenAt };
    }
  }
  return match && { roomId: match.roomId, name: match.name };
}
function bindStudentToRoom(studentId, roomId, name) {
  let registration = studentRegistrations.get(studentId);
  if (!registration) {
    registration = findLegacyStudentRegistration(studentId);
    if (registration && !persistStudentRegistration(studentId, registration)) {
      return { ok: false, reason: 'storage' };
    }
  }
  if (registration && registration.roomId !== roomId) {
    return { ok: false, reason: 'locked', registration };
  }
  const nextRegistration = { roomId, name: name || (registration && registration.name) || 'Aluno' };
  if ((!registration || registration.name !== nextRegistration.name) &&
      !persistStudentRegistration(studentId, nextRegistration)) {
    return { ok: false, reason: 'storage' };
  }
  return { ok: true, registration: nextRegistration };
}

io.on('connection', (socket) => {
  let myRoom = null;
  let myRole = null;
  let myStudentId = null;

  socket.use((packet, next) => {
    if (myRole === 'teacher' && !isValidTeacherSession(socket.handshake.headers.cookie)) {
      socket.disconnect(true);
      return;
    }
    next();
  });

  socket.on('join_room', ({ roomId, name, role, language, studentId }) => {
    if (!roomId) return;
    if (role === 'teacher' && !isValidTeacherSession(socket.handshake.headers.cookie)) {
      socket.emit('teacher_auth_required');
      socket.disconnect(true);
      return;
    }
    const nextRoom = String(roomId);
    const nextRole = role === 'teacher' ? 'teacher' : 'student';
    const sid = String(studentId || socket.id).slice(0, 80);
    if (nextRole === 'student') {
      if (!classrooms.some(classroom => classroom.id === nextRoom)) {
        socket.emit('student_room_locked', { message: 'Turma não encontrada. Usa o convite da professora.' });
        return;
      }
      const binding = bindStudentToRoom(sid, nextRoom, String(name || 'Aluno').slice(0, 40));
      if (!binding.ok) {
        const registeredClass = binding.registration && classrooms.find(classroom => classroom.id === binding.registration.roomId);
        socket.emit('student_room_locked', {
          roomId: binding.registration && binding.registration.roomId,
          message: binding.reason === 'locked'
            ? `Este aluno já está registado na turma ${registeredClass ? registeredClass.name : binding.registration.roomId}.`
            : 'Não foi possível guardar o registo do aluno.'
        });
        return;
      }
    }
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
      io.to(previousRoom + ':teachers').emit('room_state', roomState(previousRoom));
    }
    myRoom = nextRoom;
    myRole = nextRole;
    myStudentId = null;
    socket.join(myRoom);
    if (myRole === 'teacher') socket.join(myRoom + ':teachers');

    if (myRole === 'student') {
      myStudentId = sid;
      const room = getRoom(myRoom);
      const prev = room.get(sid);
      room.set(sid, {
        name: String(name || (prev && prev.name) || 'Aluno').slice(0, 40),
        language: String(language || (prev && prev.language) || 'python'),
        code: (prev && prev.code) || '',
        updatedAt: Date.now(),
        joinedAt: (prev && prev.joinedAt) || Date.now(),
        lastSeenAt: Date.now(),
        progressStatus: (prev && prev.progressStatus) || 'not_started',
        progressUpdatedAt: (prev && prev.progressUpdatedAt) || 0,
        online: true,
        socketId: socket.id
      });
      sock2id.set(socket.id, { roomId: myRoom, studentId: sid });
      markDirty(myRoom);
    }
    // Roster completo (inclui offline); quem entra recebe o freeze atual
    io.to(myRoom + ':teachers').emit('room_state', roomState(myRoom));
    // Quem entra (aluno ou professora) recebe logo o estado de freeze atual
    socket.emit('freeze_state', { frozen: frozen.get(myRoom) === true });
    const roomTasks = tasksByRoom.get(myRoom) || [];
    socket.emit('class_tasks', myRole === 'teacher'
      ? roomTasks.map(teacherTask)
      : roomTasks.map(task => publicTask(task, myStudentId)));
    if (myRole === 'student') {
      const student = getRoom(myRoom).get(myStudentId);
      socket.emit('student_progress_state', { status: student.progressStatus || 'not_started' });
    }
  });

  socket.on('code_update', ({ roomId, code, language, progressStatus }) => {
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
    entry.lastSeenAt = entry.updatedAt;
    if (['working', 'help'].includes(progressStatus)) {
      entry.progressStatus = progressStatus;
      entry.progressUpdatedAt = entry.updatedAt;
    }
    entry.online = true;
    entry.socketId = socket.id;
    room.set(sid, entry);
    markDirty(r);
    // envia só para os outros (professora + não ecoa ao próprio aluno)
    io.to(r + ':teachers').emit('code_update', {
      studentId: sid, name: entry.name, code: entry.code, language: entry.language,
      progressStatus: entry.progressStatus, progressUpdatedAt: entry.progressUpdatedAt,
      joinedAt: entry.joinedAt, lastSeenAt: entry.lastSeenAt
    });
  });

  // Professora pede snapshot (quando entra a meio da aula)
  socket.on('request_snapshot', ({ roomId }) => {
    const r = String(roomId || myRoom || '');
    if (!r) return;
    socket.to(r).emit('request_state');
  });

  socket.on('remove_student', (payload = {}) => {
    const r = String(payload.roomId || myRoom || '');
    const sid = typeof payload.studentId === 'string' ? payload.studentId : '';
    if (!r || myRole !== 'teacher' || r !== myRoom || !sid) {
      socket.emit('student_remove_error', { studentId: sid, message: 'Não foi possível remover esse aluno.' });
      return;
    }
    const room = getRoom(r);
    const student = room.get(sid);
    if (!student) {
      socket.emit('student_remove_error', { studentId: sid, message: 'O aluno já não está nesta turma.' });
      return;
    }
    const studentSocketId = student.socketId;
    const originalSubmissions = (tasksByRoom.get(r) || []).map(task => [task, task.submissions]);
    room.delete(sid);
    originalSubmissions.forEach(([task]) => {
      task.submissions = task.submissions.filter(submission => submission.studentId !== sid);
    });

    if (!persistRoomNow(r) || !persistTasks()) {
      room.set(sid, student);
      originalSubmissions.forEach(([task, submissions]) => { task.submissions = submissions; });
      persistRoomNow(r);
      persistTasks();
      socket.emit('student_remove_error', { studentId: sid, message: 'Não foi possível guardar a remoção. O aluno e as entregas foram mantidos.' });
      return;
    }

    if (studentSocketId) {
      sock2id.delete(studentSocketId);
      const studentSocket = io.sockets.sockets.get(studentSocketId);
      if (studentSocket) studentSocket.disconnect(true);
    }
    io.to(r + ':teachers').emit('student_removed', { studentId: sid, name: student.name });
    io.to(r + ':teachers').emit('room_state', roomState(r));
    io.to(r + ':teachers').emit('class_tasks', (tasksByRoom.get(r) || []).map(teacherTask));
  });

  socket.on('student_progress', (payload = {}) => {
    const r = String(payload.roomId || myRoom || '');
    const link = sock2id.get(socket.id);
    const status = payload.status;
    if (!r || myRole !== 'student' || r !== myRoom || !link || link.roomId !== r ||
        !['working', 'help'].includes(status)) return;
    const student = getRoom(r).get(link.studentId);
    if (!student) return;
    student.progressStatus = status;
    student.progressUpdatedAt = Date.now();
    student.lastSeenAt = student.progressUpdatedAt;
    markDirty(r);
    io.to(r + ':teachers').emit('room_state', roomState(r));
  });

  // Only a teacher may publish an assignment to the room they joined.
  socket.on('publish_task', (payload = {}) => {
    const { roomId, title, description, deadlineAt } = payload && typeof payload === 'object' ? payload : {};
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
    const safeDeadline = deadlineAt === null || deadlineAt === undefined || deadlineAt === ''
      ? null
      : Number(deadlineAt);
    if (safeDeadline !== null && (!Number.isFinite(safeDeadline) || safeDeadline <= Date.now())) {
      socket.emit('task_error', { message: 'O prazo deve ser uma data e hora futuras.' });
      return;
    }
    const task = {
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9),
      roomId: r,
      title: safeTitle,
      description: safeDescription,
      createdAt: Date.now(),
      deadlineAt: safeDeadline,
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
      submittedAt: Date.now(),
      late: task.deadlineAt !== null && Date.now() > task.deadlineAt,
      feedback: '',
      feedbackAt: null
    };
    task.submissions.push(submission);
    persistTasks();
    socket.emit('submission_saved', { taskId: task.id, submission: { ...submission } });
    io.to(r + ':teachers').emit('task_submission', { taskId: task.id, submission: { ...submission } });
  });

  socket.on('task_feedback', (payload = {}) => {
    const { roomId, taskId, submissionId, feedback } = payload;
    const r = String(roomId || myRoom || '');
    if (!r || myRole !== 'teacher' || r !== myRoom || typeof feedback !== 'string') return;
    const task = (tasksByRoom.get(r) || []).find(entry => entry.id === taskId);
    const submission = task && task.submissions.find(entry => entry.id === submissionId);
    const latestSubmission = submission && task.submissions.filter(entry => entry.studentId === submission.studentId).slice(-1)[0];
    const safeFeedback = feedback.trim().slice(0, 2000);
    if (!submission || !latestSubmission || latestSubmission.id !== submission.id || !safeFeedback) {
      socket.emit('feedback_error', { submissionId, message: 'Escreve um comentário (máximo 2000 caracteres).' });
      return;
    }
    submission.feedback = safeFeedback;
    submission.feedbackAt = Date.now();
    persistTasks();
    socket.emit('feedback_saved', { taskId, submission: { ...submission } });
    const student = getRoom(r).get(submission.studentId);
    if (student && student.socketId) {
      io.to(student.socketId).emit('submission_feedback', {
        taskId, submissionId, feedback: safeFeedback, feedbackAt: submission.feedbackAt
      });
    }
  });

  socket.on('request_backup', ({ roomId } = {}) => {
    const r = String(roomId || myRoom || '');
    if (!r || myRole !== 'teacher' || r !== myRoom) {
      socket.emit('backup_error', { message: 'Só a professora pode exportar a cópia desta sala.' });
      return;
    }
    socket.emit('backup_data', {
      version: 1,
      roomId: r,
      createdAt: Date.now(),
      students: [...getRoom(r).entries()].map(([id, student]) => [id, {
        ...student, online: false, socketId: null
      }]),
      tasks: (tasksByRoom.get(r) || []).map(teacherTask)
    });
  });

  socket.on('export_submissions', async ({ roomId } = {}) => {
    const r = String(roomId || myRoom || '');
    if (!r || myRole !== 'teacher' || r !== myRoom) {
      socket.emit('backup_error', { message: 'Só a professora pode exportar entregas desta sala.' });
      return;
    }
    try {
      const archive = require('archiver')('zip', { zlib: { level: 6 } });
      const chunks = [];
      archive.on('data', chunk => chunks.push(chunk));
      archive.on('warning', error => {
        console.error('Aviso ao criar ZIP de entregas:', error.message);
      });
      archive.on('error', error => {
        console.error('Não foi possível criar ZIP de entregas:', error.message);
        socket.emit('backup_error', { message: 'Não foi possível criar o ZIP das entregas.' });
      });
      archive.on('end', () => {
        socket.emit('submissions_zip', {
          roomId: r, createdAt: Date.now(),
          fileName: `entregas-${r.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`,
          data: Buffer.concat(chunks)
        });
      });
      const roomTasks = tasksByRoom.get(r) || [];
      roomTasks.forEach(task => {
        const safeTaskId = String(task.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
        const taskFolder = `${String(task.title).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) || 'tarefa'}-${safeTaskId}/`;
        const byStudent = new Map();
        task.submissions.forEach(submission => {
          const attempts = byStudent.get(submission.studentId) || [];
          attempts.push(submission);
          byStudent.set(submission.studentId, attempts);
        });
        byStudent.forEach((attempts, rawStudentId) => {
          const studentId = String(rawStudentId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
          const studentName = String(attempts[0].studentName || 'aluno').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'aluno';
          attempts.forEach((submission, index) => {
            const suffix = attempts.length > 1 ? `_entrega-${index + 1}` : '';
            archive.append(submission.code, { name: `${taskFolder}${studentName}-${studentId}${suffix}.py` });
          });
          archive.append(JSON.stringify(attempts.map(({ code, ...details }) => details), null, 2), {
            name: `${taskFolder}${studentName}-${studentId}-detalhes.json`
          });
        });
      });
      if (!roomTasks.some(task => task.submissions.length)) {
        archive.append('Ainda não há entregas nesta turma.', { name: 'LEIA-ME.txt' });
      }
      await archive.finalize();
    } catch (error) {
      console.error('Não foi possível exportar entregas:', error.message);
      socket.emit('backup_error', { message: 'Não foi possível exportar as entregas.' });
    }
  });

  socket.on('restore_backup', (backup = {}) => {
    const r = String(myRoom || '');
    if (!r || myRole !== 'teacher' || backup.version !== 1 ||
        backup.roomId !== r || !Array.isArray(backup.students) || !Array.isArray(backup.tasks) ||
        backup.students.length > 1000 || backup.tasks.length > 20) {
      socket.emit('backup_error', { message: 'A cópia não é válida para esta sala.' });
      return;
    }
    const restoredStudents = new Map();
    for (const entry of backup.students) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
          !entry[1] || typeof entry[1].name !== 'string' || typeof entry[1].code !== 'string' ||
          entry[1].code.length > 100000) {
        socket.emit('backup_error', { message: 'A cópia contém dados de alunos inválidos.' });
        return;
      }
      restoredStudents.set(entry[0].slice(0, 80), {
        name: entry[1].name.slice(0, 40), language: String(entry[1].language || 'python').slice(0, 30),
        code: entry[1].code, updatedAt: Number(entry[1].updatedAt) || 0,
        joinedAt: Number(entry[1].joinedAt) || 0, lastSeenAt: Number(entry[1].lastSeenAt) || 0,
        progressStatus: ['working', 'help'].includes(entry[1].progressStatus) ? entry[1].progressStatus : 'not_started',
        progressUpdatedAt: Number(entry[1].progressUpdatedAt) || 0, online: false, socketId: null
      });
    }
    const restoredTasks = [];
    for (const task of backup.tasks) {
      if (!task || typeof task.id !== 'string' || typeof task.title !== 'string' ||
          typeof task.description !== 'string' || !Array.isArray(task.submissions) ||
          task.submissions.length > 5000) {
        socket.emit('backup_error', { message: 'A cópia contém tarefas ou entregas inválidas.' });
        return;
      }
      const submissions = [];
      for (const submission of task.submissions) {
        if (!submission || typeof submission.id !== 'string' || typeof submission.studentId !== 'string' ||
            typeof submission.code !== 'string' || submission.code.length > 100000) {
          socket.emit('backup_error', { message: 'A cópia contém uma entrega inválida.' });
          return;
        }
        submissions.push({ ...submission, feedback: String(submission.feedback || '').slice(0, 2000) });
      }
      restoredTasks.push({
        id: task.id.slice(0, 100), roomId: r, title: task.title.slice(0, 120),
        description: task.description.slice(0, 2000), createdAt: Number(task.createdAt) || Date.now(),
        deadlineAt: Number.isFinite(task.deadlineAt) ? task.deadlineAt : null, submissions
      });
    }
    const currentRoom = getRoom(r);
    const mergedStudents = new Map(restoredStudents);
    restoredStudents.forEach((restored, studentId) => {
      const current = currentRoom.get(studentId);
      if (current && current.online) {
        mergedStudents.set(studentId, { ...restored, online: true, socketId: current.socketId });
      }
    });
    currentRoom.forEach((current, studentId) => {
      if (!mergedStudents.has(studentId) && current.online) mergedStudents.set(studentId, current);
    });
    rooms.set(r, mergedStudents);
    tasksByRoom.set(r, restoredTasks);
    markDirty(r);
    persistTasks();
    io.to(r + ':teachers').emit('room_state', roomState(r));
    io.to(r + ':teachers').emit('class_tasks', restoredTasks.map(teacherTask));
    socket.emit('backup_restored', { roomId: r, students: mergedStudents.size, tasks: restoredTasks.length });
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
      entry.lastSeenAt = Date.now();
      markDirty(link.roomId);
      io.to(link.roomId + ':teachers').emit('student_left', { studentId: link.studentId });
      io.to(link.roomId + ':teachers').emit('room_state', roomState(link.roomId));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Classroom Code Live a correr:`);
  if (!TEACHER_PASSWORD && !teacherCredentials) console.log('  - Primeira visita a /teacher: a primeira professora configura o acesso.');
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