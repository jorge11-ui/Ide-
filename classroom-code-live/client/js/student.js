// ---------- socket (inalterado) ----------
const qs = new URLSearchParams(location.search);
const roomInput = document.getElementById('roomInput');
const nameInput = document.getElementById('nameInput');
const langSelect = document.getElementById('langSelect');
const themeSelect = document.getElementById('themeSelect');
const fontSelect = document.getElementById('fontSelect');
const loginNameInput = document.getElementById('loginName');
const loginRoomInput = document.getElementById('loginRoom');
const codeFonts = {
  jetbrains: '"JetBrains Mono"',
  fira: '"Fira Code"',
  ibm: '"IBM Plex Mono"'
};
function applyCodeFont(font) {
  const selectedFont = Object.prototype.hasOwnProperty.call(codeFonts, font) ? font : 'jetbrains';
  fontSelect.value = selectedFont;
  document.documentElement.style.setProperty('--code-font-family', codeFonts[selectedFont]);
  if (window._editor) window._editor.updateOptions({ fontFamily: codeFonts[selectedFont] + ', ui-monospace, Consolas, monospace' });
  if (window._terminal) window._terminal.options.fontFamily = codeFonts[selectedFont] + ', ui-monospace, Consolas, monospace';
  try { localStorage.setItem('ccl-code-font', selectedFont); } catch (e) {}
}
let savedCodeFont = 'jetbrains';
try { savedCodeFont = localStorage.getItem('ccl-code-font') || 'jetbrains'; } catch (e) {}
applyCodeFont(savedCodeFont);
fontSelect.onchange = () => applyCodeFont(fontSelect.value);
// Tema gravado: aplica à página já antes do Monaco carregar
function applyTheme(mode) {
  const light = mode === 'light';
  document.body.classList.toggle('light', light);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  themeSelect.value = light ? 'light' : 'dark';
  try { localStorage.setItem('ccl-theme', light ? 'light' : 'dark'); } catch (e) {}
  if (window._editor && window.monaco) monaco.editor.setTheme(light ? 'vs' : 'vs-dark');
}
let savedTheme = 'dark';
try { savedTheme = localStorage.getItem('ccl-theme') || 'dark'; } catch (e) {}
applyTheme(savedTheme === 'light' ? 'light' : 'dark');
themeSelect.onchange = () => applyTheme(themeSelect.value);
// Menu Definições (⋯): abre/fecha, fecha ao clicar fora ou com Escape
const settingsMenu = document.getElementById('settingsMenu');
document.getElementById('settingsBtn').onclick = (e) => { e.stopPropagation(); settingsMenu.classList.toggle('hidden'); };
document.addEventListener('click', (e) => { if (!settingsMenu.classList.contains('hidden') && !settingsMenu.contains(e.target)) settingsMenu.classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') settingsMenu.classList.add('hidden'); });
settingsMenu.addEventListener('click', (e) => { if (e.target.closest('button')) settingsMenu.classList.add('hidden'); });
let savedRoom = '';
let savedName = '';
try { savedRoom = localStorage.getItem('ccl-student-room') || ''; } catch (e) {}
roomInput.value = qs.get('room') || savedRoom || roomInput.value;
if (qs.get('name')) nameInput.value = qs.get('name');
document.getElementById('roomLabel').textContent = roomInput.value;
// ---- Registo do aluno: nome + ID persistente neste computador ----
// O servidor identifica o aluno por este ID: reconnects juntam-se ao mesmo
// registo e o código fica visível à professora mesmo com o aluno offline.
function getStudentId() {
  try {
    let id = localStorage.getItem('ccl-student-id');
    if (!id) {
      id = 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('ccl-student-id', id);
    }
    return id;
  } catch (e) { return 's-temp-' + Math.random().toString(36).slice(2, 8); }
}
const studentId = getStudentId();
try {
  savedName = localStorage.getItem('ccl-student-name') || '';
  if (savedName && !qs.get('name')) nameInput.value = savedName;
} catch (e) {}
const shouldRestoreStudentSession = Boolean(
  savedName.trim() && savedRoom.trim() && roomInput.value === savedRoom &&
  (!qs.get('name') || qs.get('name') === savedName)
);
loginNameInput.value = nameInput.value;
loginRoomInput.value = roomInput.value;
function refreshRegLabel() {
  const el = document.getElementById('regLabel');
  if (el) el.textContent = 'Registo: ' + (nameInput.value || 'Aluno') + ' (' + studentId.slice(0, 12) + '…)';
}
refreshRegLabel();
async function loadStudentClassrooms() {
  const preferredRoom = roomInput.value;
  try {
    const response = await fetch('/student-classrooms', { cache: 'no-store' });
    if (!response.ok) throw new Error('Não foi possível carregar as turmas.');
    const availableClassrooms = await response.json();
    loginRoomInput.replaceChildren(new Option('Escolhe uma turma', ''));
    availableClassrooms.forEach(classroom => {
      loginRoomInput.add(new Option(classroom.name + ' (' + classroom.id + ')', classroom.id));
    });
    loginRoomInput.value = availableClassrooms.some(classroom => classroom.id === preferredRoom) ? preferredRoom : '';
    if (!availableClassrooms.length) {
      document.getElementById('loginFeedback').textContent = 'Ainda não há turmas disponíveis. Pede à professora para criar uma turma.';
    }
  } catch (error) {
    loginRoomInput.replaceChildren(new Option('Não foi possível carregar as turmas', ''));
    document.getElementById('loginFeedback').textContent = error.message;
  }
}
loadStudentClassrooms();

const socket = io();
let isRegistered = shouldRestoreStudentSession;
const statusDot = document.getElementById('statusDot');
function setStatus(txt, ok) {
  statusDot.textContent = txt;
  statusDot.className = 'text-xs px-2 py-1 rounded-full border ' + (ok
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : 'bg-red-500/15 text-red-300 border-red-500/30');
}
socket.on('connect', () => {
  setStatus('● ligado', true);
  if (isRegistered) join();
  else document.getElementById('loginFeedback').textContent = 'Ligação pronta. Regista o teu nome e escolhe uma turma.';
});
socket.on('disconnect', () => {
  setStatus('● desligado', false);
  if (!isRegistered) document.getElementById('loginFeedback').textContent = 'Sem ligação ao servidor. O registo precisa de ligação para guardar a turma.';
});
function join() {
  document.getElementById('roomLabel').textContent = roomInput.value;
  try { localStorage.setItem('ccl-student-name', nameInput.value); } catch (e) {}
  try { localStorage.setItem('ccl-student-room', roomInput.value); } catch (e) {}
  refreshRegLabel();
  socket.emit('join_room', { roomId: roomInput.value, name: nameInput.value, role: 'student', language: langSelect.value, studentId });
  sendUpdate(true);
}
nameInput.onchange = () => join();
function enterClass(name, room) {
  nameInput.value = name;
  roomInput.value = room;
  loginNameInput.value = name;
  loginRoomInput.value = room;
  isRegistered = true;
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  document.getElementById('appShell').classList.add('flex');
  document.getElementById('loginFeedback').textContent = '';
  join();
  setTimeout(() => { if (window._editor) window._editor.layout(); }, 80);
}
document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = loginNameInput.value.trim();
  const room = loginRoomInput.value.trim();
  if (!name || !room) {
    document.getElementById('loginFeedback').textContent = 'Preenche o teu nome e escolhe uma turma.';
    return;
  }
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  document.getElementById('loginFeedback').textContent = 'A guardar o registo…';
  try {
    const response = await fetch('/student-register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId, name, roomId: room })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Não foi possível guardar o registo.');
    nameInput.value = result.name;
    roomInput.value = result.roomId;
    enterClass(result.name, result.roomId);
  } catch (error) {
    document.getElementById('loginFeedback').textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});
if (shouldRestoreStudentSession) enterClass(nameInput.value.trim(), roomInput.value.trim());
function sendUpdate() {
  if (!window._editor) return;
  const code = window._editor.getValue();
  socket.emit('code_update', {
    roomId: roomInput.value, code, language: langSelect.value,
    progressStatus: studentProgressStatus
  });
}
// Congelar: a professora bloqueia a escrita (readOnly) via freeze_state
window._frozen = false;
function applyFreeze(f) {
  window._frozen = f === true;
  const b = document.getElementById('freezeBanner');
  if (b) b.classList.toggle('hidden', !window._frozen);
  if (window._editor && window.monaco) window._editor.updateOptions({ readOnly: window._frozen });
}
socket.on('freeze_state', ({ frozen: f }) => applyFreeze(f));

const pendingTasks = [];
const studentTasks = new Map();
const submittingTasks = new Set();
function renderStudentTasks() {
  const list = document.getElementById('studentTaskList');
  list.textContent = '';
  const tasks = [...studentTasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  document.getElementById('studentTaskCount').textContent = String(tasks.length);
  if (!tasks.length) {
    const empty = document.createElement('p');
    empty.className = 'rounded-lg border border-slate-800 bg-slate-950/40 p-4 text-xs text-slate-500';
    empty.textContent = 'Ainda não há tarefas publicadas nesta sala.';
    list.appendChild(empty);
    return;
  }
  tasks.forEach(task => {
    const card = document.createElement('article');
    card.className = 'student-task-card rounded-lg border border-slate-800 bg-slate-950/40 p-3';
    const heading = document.createElement('div');
    heading.className = 'flex items-start gap-2';
    const title = document.createElement('h3');
    title.className = 'min-w-0 flex-1 text-sm font-semibold';
    title.textContent = task.title;
    const status = document.createElement('span');
    status.className = task.mySubmission
      ? (task.mySubmission.late
        ? 'shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300'
        : 'shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400')
      : 'shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300';
    status.textContent = task.mySubmission ? (task.mySubmission.late ? 'Entregue com atraso' : 'Entregue') :
      (task.deadlineAt && Date.now() > task.deadlineAt ? 'Prazo ultrapassado' : 'Por entregar');
    heading.append(title, status);
    const description = document.createElement('p');
    description.className = 'task-description mt-1 whitespace-pre-wrap break-words text-xs text-slate-400';
    description.textContent = task.description;
    const meta = document.createElement('p');
    meta.className = 'mt-2 text-[10px] text-slate-500';
    meta.textContent = (task.mySubmission
      ? 'Última entrega: ' + new Date(task.mySubmission.submittedAt).toLocaleString()
      : 'Publicada: ' + new Date(task.createdAt).toLocaleString()) +
      (task.deadlineAt ? ' • Prazo: ' + new Date(task.deadlineAt).toLocaleString() : '');
    const feedback = task.mySubmission && task.mySubmission.feedback;
    let feedbackElement = null;
    if (feedback) {
      feedbackElement = document.createElement('p');
      feedbackElement.className = 'mt-2 whitespace-pre-wrap rounded-md border border-violet-500/20 bg-violet-500/5 p-2 text-xs text-violet-200';
      feedbackElement.textContent = 'Feedback da professora: ' + feedback;
    }
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'mt-3 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:cursor-wait disabled:opacity-60';
    submit.disabled = submittingTasks.has(task.id);
    submit.textContent = submittingTasks.has(task.id) ? 'A enviar…' : (task.mySubmission ? 'Entregar novamente' : 'Entregar tarefa');
    submit.setAttribute('aria-label', submit.textContent + ': ' + task.title);
    submit.onclick = () => submitTask(task);
    card.append(heading, description, meta);
    if (feedbackElement) card.appendChild(feedbackElement);
    card.appendChild(submit);
    list.appendChild(card);
  });
}
function receiveClassTasks(tasks) {
  if (!Array.isArray(tasks)) return;
  studentTasks.clear();
  tasks.forEach(task => {
    if (task && typeof task.id === 'string' && task.roomId === roomInput.value) {
      studentTasks.set(task.id, task);
      applyClassTask(task);
    }
  });
  renderStudentTasks();
}
function receiveClassTask(task) {
  if (!task || task.roomId !== roomInput.value) return;
  const previous = studentTasks.get(task.id);
  studentTasks.set(task.id, { ...task, mySubmission: previous ? previous.mySubmission : (task.mySubmission || null) });
  applyClassTask(task);
  renderStudentTasks();
}
function receiveDeletedTask({ taskId } = {}) {
  if (typeof taskId !== 'string') return;
  for (let i = pendingTasks.length - 1; i >= 0; i--) {
    if (pendingTasks[i] && pendingTasks[i].id === taskId) pendingTasks.splice(i, 1);
  }
  submittingTasks.delete(taskId);
  if (studentTasks.delete(taskId)) {
    document.getElementById('studentTaskStatus').textContent = 'Uma tarefa foi removida pela professora.';
    renderStudentTasks();
  }
}
let studentProgressStatus = 'not_started';
function renderStudentProgress() {
  const button = document.getElementById('studentProgressBtn');
  const needsHelp = studentProgressStatus === 'help';
  button.textContent = needsHelp ? 'A pedir ajuda ✓' : 'Preciso de ajuda';
  button.setAttribute('aria-pressed', String(needsHelp));
  button.classList.toggle('border-amber-500/50', needsHelp);
  button.classList.toggle('text-amber-300', needsHelp);
}
document.getElementById('studentProgressBtn').onclick = () => {
  studentProgressStatus = studentProgressStatus === 'help' ? 'working' : 'help';
  renderStudentProgress();
  socket.emit('student_progress', { roomId: roomInput.value, status: studentProgressStatus });
};
socket.on('student_progress_state', ({ status } = {}) => {
  studentProgressStatus = ['working', 'help'].includes(status) ? status : 'not_started';
  renderStudentProgress();
});
renderStudentProgress();
function submitTask(task) {
  if (!window._editor || !socket.connected || submittingTasks.has(task.id)) {
    document.getElementById('studentTaskStatus').textContent = 'A ligação ou o editor ainda não estão prontos.';
    return;
  }
  submittingTasks.add(task.id);
  document.getElementById('studentTaskStatus').textContent = 'A enviar a entrega…';
  renderStudentTasks();
  socket.emit('submit_task', {
    roomId: roomInput.value,
    taskId: task.id,
    code: window._editor.getValue(),
    language: langSelect.value
  });
}
const studentTasksToggle = document.getElementById('studentTasksToggle');
const studentTasksPanel = document.getElementById('studentTasksPanel');
function setStudentTasksOpen(open) {
  studentTasksPanel.classList.toggle('hidden', !open);
  document.getElementById('studentTasksBackdrop').classList.toggle('hidden', !open);
  studentTasksToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    const toolbarBottom = document.getElementById('toolbar').getBoundingClientRect().bottom;
    studentTasksPanel.style.setProperty('--student-tasks-top', Math.max(8, toolbarBottom + 8) + 'px');
    document.getElementById('studentTasksClose').focus();
  } else {
    studentTasksToggle.focus();
  }
}
studentTasksToggle.onclick = () => {
  setStudentTasksOpen(studentTasksPanel.classList.contains('hidden'));
};
document.getElementById('studentTasksClose').onclick = () => setStudentTasksOpen(false);
document.getElementById('studentTasksBackdrop').onclick = () => setStudentTasksOpen(false);
window.addEventListener('resize', () => {
  if (!studentTasksPanel.classList.contains('hidden')) {
    const toolbarBottom = document.getElementById('toolbar').getBoundingClientRect().bottom;
    studentTasksPanel.style.setProperty('--student-tasks-top', Math.max(8, toolbarBottom + 8) + 'px');
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !studentTasksPanel.classList.contains('hidden')) {
    setStudentTasksOpen(false);
  }
});
renderStudentTasks();
function applyClassTask(task) {
  if (!task || task.roomId !== roomInput.value || !window._editor || !window.monaco) {
    if (task && task.roomId === roomInput.value && (!window._editor || !window.monaco)) pendingTasks.push(task);
    return;
  }
  if (langSelect.value !== 'python' || typeof task.id !== 'string' ||
      typeof task.title !== 'string' || typeof task.description !== 'string') return;
  const editor = window._editor;
  const model = editor.getModel();
  if (!model) return;
  const marker = '# Tarefa ID: ' + task.id;
  if (model.getValue().includes(marker)) return;
  const description = task.description.replace(/\r\n?/g, '\n').split('\n').map(line => line ? '# ' + line : '#');
  const commentBlock = [
    marker,
    '# Tarefa: ' + task.title,
    ...description,
    '# --- Fim da tarefa ---',
    '',
    ''
  ].join('\n');
  const selections = editor.getSelections() || [];
  const cursorOffsets = selections.map(selection => ({
    start: model.getOffsetAt(selection.getStartPosition()),
    end: model.getOffsetAt(selection.getEndPosition())
  }));
  model.applyEdits([{
    range: new monaco.Range(1, 1, 1, 1),
    text: commentBlock,
    forceMoveMarkers: true
  }]);
  if (cursorOffsets.length) {
    editor.setSelections(cursorOffsets.map(offsets => {
      const start = model.getPositionAt(offsets.start + commentBlock.length);
      const end = model.getPositionAt(offsets.end + commentBlock.length);
      return new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column);
    }));
  }
}
socket.on('class_task', receiveClassTask);
socket.on('class_tasks', receiveClassTasks);
socket.on('task_deleted', receiveDeletedTask);
socket.on('submission_saved', ({ taskId, submission }) => {
  const task = studentTasks.get(taskId);
  if (task) task.mySubmission = submission;
  submittingTasks.delete(taskId);
  document.getElementById('studentTaskStatus').textContent = 'Entrega enviada com sucesso.';
  renderStudentTasks();
});
socket.on('submission_error', ({ taskId, message }) => {
  if (taskId) submittingTasks.delete(taskId);
  document.getElementById('studentTaskStatus').textContent = message || 'Não foi possível enviar a entrega.';
  renderStudentTasks();
});
socket.on('submission_feedback', ({ taskId, submissionId, feedback, feedbackAt }) => {
  const task = studentTasks.get(taskId);
  if (!task || !task.mySubmission || task.mySubmission.id !== submissionId) return;
  task.mySubmission.feedback = feedback;
  task.mySubmission.feedbackAt = feedbackAt;
  document.getElementById('studentTaskStatus').textContent = 'Recebeste feedback da professora.';
  renderStudentTasks();
});

// ---------- execução local e rápida ----------
const output = document.getElementById('output');
const preview = document.getElementById('preview');
const runBtn = document.getElementById('runBtn');
const runTime = document.getElementById('runTime');
const runLabel = document.getElementById('runLabel');
const terminal = new Terminal({
  cursorBlink: true,
  convertEol: true,
  scrollback: 2000,
  fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--code-font-family').trim() + ', ui-monospace, Consolas, monospace',
  fontSize: 13,
  theme: {
    background: '#012456',
    foreground: '#f2f2f2',
    cursor: '#7dd3fc',
    selectionBackground: '#1b4e85'
  }
});
const terminalFitAddon = new FitAddon.FitAddon();
terminal.loadAddon(terminalFitAddon);
terminal.open(document.getElementById('terminal-container'));
window._terminal = terminal;
window._terminalFitAddon = terminalFitAddon;
function fitTerminal() {
  if (output.clientWidth && output.clientHeight) terminalFitAddon.fit();
}
new ResizeObserver(fitTerminal).observe(output);
window.addEventListener('resize', fitTerminal);
terminal.writeln('Bem-vindo ao Terminal Real!');
terminal.write('PS C:\\classroom> ');
function clearTerminal() {
  terminal.write('\r', () => {
    terminal.reset();
    terminal.write('PS C:\\classroom> ');
  });
}
function print(lines, isErr) {
  if (!lines.length) {
    terminal.writeln('(sem output — o programa correu sem print)');
    return;
  }
  const colorStart = isErr ? '\x1b[31m' : '';
  const colorEnd = isErr ? '\x1b[0m' : '';
  terminal.write(lines.map(line => colorStart + String(line) + colorEnd).join('\r\n') + '\r\n');
}
function showConsole(){ output.classList.remove('hidden'); preview.classList.add('hidden'); }
function showPreview(){ output.classList.add('hidden'); preview.classList.remove('hidden'); }
document.getElementById('clearBtn').onclick = () => {
  if (pendingConsoleInput) cancelConsoleInput();
  terminalCommandBuffer = '';
  clearTerminal(); showConsole(); runTime.textContent = '';
};

// Resize the console beside the editor on desktop and below it on small screens.
const editorConsoleResize = document.getElementById('editorConsoleResize');
const consolePanel = document.getElementById('consolePanel');
const consoleHeightKey = 'ccl-console-height';
const consoleWidthKey = 'ccl-console-width';
const editorWorkspace = document.getElementById('editorWorkspace');
function isConsoleSideBySide() { return window.matchMedia('(min-width: 761px)').matches; }
function setConsoleExtent(value, save) {
  const sideBySide = isConsoleSideBySide();
  const available = sideBySide
    ? Math.max(220, editorWorkspace.clientWidth - editorConsoleResize.offsetWidth - 120)
    : Math.max(120, editorWorkspace.clientHeight - editorConsoleResize.offsetHeight - 120);
  const minimum = sideBySide ? 220 : 120;
  const maximum = Math.max(minimum, Math.min(available - 120, available * 0.7));
  const next = Math.round(Math.max(minimum, Math.min(maximum, value)));
  if (sideBySide) {
    document.documentElement.style.setProperty('--console-width', next + 'px');
    editorConsoleResize.setAttribute('aria-orientation', 'vertical');
    editorConsoleResize.setAttribute('aria-valuemin', '220');
    editorConsoleResize.setAttribute('aria-valuenow', String(next));
  } else {
    document.documentElement.style.setProperty('--console-height', next + 'px');
    editorConsoleResize.setAttribute('aria-orientation', 'horizontal');
    editorConsoleResize.setAttribute('aria-valuemin', '120');
    editorConsoleResize.setAttribute('aria-valuenow', String(next));
  }
  if (save) {
    try { localStorage.setItem(sideBySide ? consoleWidthKey : consoleHeightKey, String(next)); } catch (e) {}
  }
  if (window._editor) window._editor.layout();
}
try {
  const sideBySide = isConsoleSideBySide();
  const savedExtent = Number(localStorage.getItem(sideBySide ? consoleWidthKey : consoleHeightKey));
  if (Number.isFinite(savedExtent) && savedExtent >= (sideBySide ? 220 : 120)) setConsoleExtent(savedExtent, false);
  else if (sideBySide) setConsoleExtent(editorWorkspace.clientWidth * 0.34, false);
} catch (e) {}
editorConsoleResize.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  editorConsoleResize.setPointerCapture(event.pointerId);
  editorConsoleResize.classList.add('is-resizing');
  const sideBySide = isConsoleSideBySide();
  const startPosition = sideBySide ? event.clientX : event.clientY;
  const startExtent = sideBySide ? consolePanel.getBoundingClientRect().width : consolePanel.getBoundingClientRect().height;
  const resize = (moveEvent) => {
    const position = sideBySide ? moveEvent.clientX : moveEvent.clientY;
    setConsoleExtent(startExtent + startPosition - position, true);
  };
  const stop = () => {
    editorConsoleResize.classList.remove('is-resizing');
    editorConsoleResize.removeEventListener('pointermove', resize);
    editorConsoleResize.removeEventListener('pointerup', stop);
    editorConsoleResize.removeEventListener('pointercancel', stop);
  };
  editorConsoleResize.addEventListener('pointermove', resize);
  editorConsoleResize.addEventListener('pointerup', stop);
  editorConsoleResize.addEventListener('pointercancel', stop);
});
editorConsoleResize.addEventListener('keydown', (event) => {
  const sideBySide = isConsoleSideBySide();
  const decrease = sideBySide ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
  const increase = sideBySide ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
  if (decrease || increase) {
    event.preventDefault();
    const current = sideBySide ? consolePanel.getBoundingClientRect().width : consolePanel.getBoundingClientRect().height;
    setConsoleExtent(current + (increase ? 16 : -16), true);
  }
});
window.addEventListener('resize', () => {
  const sideBySide = isConsoleSideBySide();
  let savedExtent = null;
  try { savedExtent = Number(localStorage.getItem(sideBySide ? consoleWidthKey : consoleHeightKey)); } catch (e) {}
  if (Number.isFinite(savedExtent) && savedExtent >= (sideBySide ? 220 : 120)) setConsoleExtent(savedExtent, false);
  else if (sideBySide) setConsoleExtent(editorWorkspace.clientWidth * 0.34, false);
  else setConsoleExtent(consolePanel.getBoundingClientRect().height, false);
});

// Python via Pyodide, pré-carregado em fundo para o Run ser rápido
let pyodidePromise = null;
function getPyodide() {
  if (!pyodidePromise) pyodidePromise = loadPyodide();
  return pyodidePromise;
}
window.addEventListener('load', () => {
  setTimeout(() => {
    getPyodide().then(() => {
      const el = document.getElementById('pyStatus');
      el.textContent = 'py: pronto ✓'; el.className = 'text-xs px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30';
    }).catch(() => { document.getElementById('pyStatus').textContent = 'py: falhou (sem net?)'; });
  }, 1500);
});
let pendingConsoleInput = null;
let terminalCommandBuffer = '';
let terminalInputBuffer = '';
function submitTerminalCommand() {
  const command = terminalCommandBuffer.trim();
  terminalCommandBuffer = '';
  if (!command) {
    terminal.write('PS C:\\classroom> ');
  } else if (command.toLowerCase() === 'clear' || command.toLowerCase() === 'cls') {
    clearTerminal();
  } else if (command.toLowerCase() === 'help') {
    terminal.writeln('Comandos: python workspace.py, clear, cls, help');
    terminal.write('PS C:\\classroom> ');
  } else if (command.toLowerCase() === 'python workspace.py' || command.toLowerCase() === 'py workspace.py') {
    run(true);
  } else {
    terminal.write('\x1b[31mComando não reconhecido. Usa "python workspace.py" ou "help".\x1b[0m\r\nPS C:\\classroom> ');
  }
}
function submitPendingConsoleInput(value) {
  if (!pendingConsoleInput) return;
  const pending = pendingConsoleInput;
  pending.answers.push(value);
  pendingConsoleInput = null;
  terminalInputBuffer = '';
  executePython(pending.code, pending.answers, true, pending.printedLogCount, (pending.prompt || '') + value);
}
terminal.onData(data => {
  const input = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const character of input) {
    if (pendingConsoleInput) {
      if (character === '\x03') {
        cancelConsoleInput();
        terminal.write('^C\r\nPS C:\\classroom> ');
        return;
      }
      if (character === '\r' || character === '\n') {
        terminal.write('\r\n');
        submitPendingConsoleInput(terminalInputBuffer);
        return;
      }
      if (character === '\u007f') {
        if (terminalInputBuffer) {
          terminalInputBuffer = terminalInputBuffer.slice(0, -1);
          terminal.write('\b \b');
        }
      } else if (character >= ' ' && character !== '\x7f') {
        terminalInputBuffer += character;
        terminal.write(character);
      }
      continue;
    }
    if (runBtn.disabled) return;
    if (character === '\r' || character === '\n') {
      terminal.write('\r\n');
      submitTerminalCommand();
      return;
    }
    if (character === '\u007f') {
      if (terminalCommandBuffer) {
        terminalCommandBuffer = terminalCommandBuffer.slice(0, -1);
        terminal.write('\b \b');
      }
    } else if (character === '\x03') {
      terminalCommandBuffer = '';
      terminal.write('^C\r\nPS C:\\classroom> ');
    } else if (character >= ' ' && character !== '\x7f') {
      terminalCommandBuffer += character;
      terminal.write(character);
    }
  }
});
function showConsoleInput(prompt) {
  terminalInputBuffer = '';
  if (prompt) terminal.write(prompt);
  terminal.focus();
}
function cancelConsoleInput() {
  pendingConsoleInput = null;
  terminalInputBuffer = '';
  runBtn.disabled = false;
  runBtn.innerHTML = '▶ Executar <span class="font-normal opacity-70">(Ctrl+Enter)</span>';
}
async function runPython(code, answers) {
  const py = await getPyodide();
  const logs = [];
  py.setStdout({ batched: (s) => logs.push(s) });
  py.setStderr({ batched: (s) => logs.push('[erro] ' + s) });
  // Replay with queued answers because Pyodide cannot await browser input() synchronously.
  const wrapper = [
    'import json as _ccl_json',
    '_ccl_answers = ' + JSON.stringify(answers),
    'class _CCLNeedInput(BaseException): pass',
    'def _ccl_input(prompt=""):',
    '    if not _ccl_answers: raise _CCLNeedInput(str(prompt))',
    '    answer = _ccl_answers.pop(0)',
    '    print(str(prompt) + answer)',
    '    return answer',
    "_ccl_namespace = {'__name__': '__main__', 'input': _ccl_input}",
    'try:',
    '    exec(compile(' + JSON.stringify(code) + ', "<student>", "exec"), _ccl_namespace, _ccl_namespace)',
    'except _CCLNeedInput as _ccl_error:',
    '    _ccl_result = {"waiting": True, "prompt": str(_ccl_error)}',
    'else:',
    '    _ccl_result = {"waiting": False}',
    '_ccl_json.dumps(_ccl_result)'
  ].join('\n');
  const result = await py.runPythonAsync(wrapper);
  return { ...JSON.parse(result), logs };
}

async function run(commandAlreadyWritten = false) {
  if (!window._editor || pendingConsoleInput) return;
  const code = window._editor.getValue();
  executePython(code, [], commandAlreadyWritten);
}
async function executePython(code, answers, commandAlreadyWritten = false, printedLogCount = 0, echoedInput = '') {
  const t0 = performance.now();
  let waitingForInput = false;
  runBtn.disabled = true; runBtn.textContent = '⏳ A correr...';
  runLabel.textContent = 'python • ' + code.length + ' chars';
  try {
    showConsole();
    if (!commandAlreadyWritten && !answers.length) terminal.write('python workspace.py\r\n');
    const result = await runPython(code, answers);
    const newLogs = result.logs.slice(printedLogCount);
    if (echoedInput) {
      const echoedLogIndex = newLogs.findIndex(line => String(line).replace(/\r?\n$/, '') === echoedInput);
      if (echoedLogIndex >= 0) newLogs.splice(echoedLogIndex, 1);
    }
    if (result.waiting) {
      pendingConsoleInput = { code, answers, printedLogCount: result.logs.length, prompt: result.prompt };
      if (newLogs.length) print(newLogs, false);
      showConsoleInput(result.prompt);
      runBtn.textContent = 'A aguardar input…';
      waitingForInput = true;
      return;
    }
    pendingConsoleInput = null;
    if (newLogs.length) print(newLogs, false);
    else if (!result.logs.length && !printedLogCount) print([], false);
    terminal.write('PS C:\\classroom> ');
    runTime.textContent = Math.round(performance.now() - t0) + 'ms';
  } catch (e) {
    pendingConsoleInput = null;
    showConsole(); print(['⛔ ' + (e && e.message || e)], true);
    terminal.write('PS C:\\classroom> ');
  } finally {
    if (!waitingForInput) {
      runBtn.disabled = false; runBtn.innerHTML = '▶ Executar <span class="font-normal opacity-70">(Ctrl+Enter)</span>';
    }
  }
}
runBtn.onclick = () => run();
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });

// ---------- guardar no computador (localStorage por sala+linguagem) ----------
function codeKey(room, lang) { return 'ccl-code:' + room + ':' + lang; }
function defaultTemplate() {
  return '';
}
function isOldStudentTemplate(code) {
  const normalized = code.replace(/\r\n/g, '\n').trim();
  return normalized === '# Escreve aqui o teu código...\ndef soma(a, b):\n    return a + b\n\nprint(soma(2, 3))';
}
function loadSaved(room, lang) {
  try {
    const saved = localStorage.getItem(codeKey(room, lang));
    if (saved !== null && isOldStudentTemplate(saved)) {
      localStorage.setItem(codeKey(room, lang), '');
      return '';
    }
    return saved;
  } catch (e) { return null; }
}
function saveLocal(room, lang, code) {
  try { localStorage.setItem(codeKey(room, lang), code); } catch (e) { return; }
  const el = document.getElementById('savedLabel');
  if (el) el.textContent = 'Guardado: ' + new Date().toLocaleTimeString();
}
function downloadStudentCode() {
  if (!window._editor) return;
  const ext = 'py';
  const safe = (nameInput.value || 'aluno').replace(/[\\/:*?"<>|]/g, '-').slice(0, 40);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([window._editor.getValue()], { type: 'text/plain;charset=utf-8' }));
  a.download = safe + '.' + ext;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
document.getElementById('dlBtn').onclick = downloadStudentCode;
document.getElementById('newBtn').onclick = () => {
  if (!window._editor) return;
  if (confirm('Queres descarregar uma cópia do código atual antes de o limpar? Escolhe Cancelar para continuar sem descarregar.')) {
    downloadStudentCode();
  }
  if (!confirm('Começar do zero? O código atual será substituído por um editor vazio.')) return;
  window._editor.setValue(defaultTemplate(langSelect.value));
  saveLocal(roomInput.value, langSelect.value, window._editor.getValue());
  showConsole(); sendUpdate(true);
};
// Upload: carrega um ficheiro .py/.txt do computador para o editor
document.getElementById('uploadBtn').onclick = () => document.getElementById('uploadInput').click();
document.querySelector('[data-panel="files"]').onclick = () => document.getElementById('uploadInput').click();
document.querySelector('[data-panel="search"]').onclick = () => {
  if (window._editor) window._editor.trigger('activity-bar', 'actions.find', null);
};
document.getElementById('uploadInput').onchange = (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f || !window._editor) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '').slice(0, 200000);
    window._editor.setValue(text);
    saveLocal(roomInput.value, langSelect.value, text);
    const sl = document.getElementById('savedLabel');
    if (sl) sl.textContent = 'Ficheiro ' + f.name.slice(0, 30) + ' carregado ✓';
    showConsole(); sendUpdate(true);
  };
  reader.readAsText(f);
  e.target.value = '';
};

// ---------- monaco ----------
require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
require(['vs/editor/editor.main'], function () {
    const editor = monaco.editor.create(document.getElementById('editor'), {
      value: (loadSaved(roomInput.value, langSelect.value) ?? defaultTemplate(langSelect.value)),
      language: langSelect.value, theme: document.body.classList.contains('light') ? 'vs' : 'vs-dark', readOnly: window._frozen === true, automaticLayout: true, fontSize: 14, fontFamily: codeFonts[fontSelect.value] + ', ui-monospace, Consolas, monospace', minimap: { enabled: true, maxColumn: 120, showSlider: 'always' }
    });
  window._editor = editor;
  pendingTasks.splice(0).forEach(applyClassTask);
  if ((loadSaved(roomInput.value, langSelect.value) ?? '') !== '') {
    const sl = document.getElementById('savedLabel');
    if (sl) sl.textContent = 'Restaurado onde paraste ✓';
  }
  window._prevLang = langSelect.value;
  langSelect.onchange = () => {
    try { localStorage.setItem(codeKey(roomInput.value, window._prevLang), editor.getValue()); } catch (e) {}
    monaco.editor.setModelLanguage(editor.getModel(), langSelect.value);
    const saved = loadSaved(roomInput.value, langSelect.value);
    editor.setValue((saved !== null && saved !== undefined) ? saved : defaultTemplate(langSelect.value));
    window._prevLang = langSelect.value;
    showConsole(); sendUpdate(true);
  };
  let t;
  editor.onDidChangeModelContent(() => {
    const code = editor.getValue();
    clearTimeout(t);
    t = setTimeout(() => {
      if (isRegistered && studentProgressStatus !== 'help') {
        studentProgressStatus = 'working';
        renderStudentProgress();
      }
      sendUpdate(false);
    }, 400);
    // autosave local (debounce próprio para não escrever a cada tecla)
    clearTimeout(window._saveT);
    window._saveT = setTimeout(() => saveLocal(roomInput.value, langSelect.value, editor.getValue()), 800);
  });
  socket.on('request_state', () => sendUpdate(true));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run());
});

// ---------- anti copy-paste: bloqueia colar e arrastar texto para o editor ----------
// Cobre Ctrl+V, menu de contexto, colar no telemóvel e drag-and-drop.
// Só atua dentro do #editor: os outros campos (nome, login, etc.) colam normalmente.
let pasteNoticeTimer = null;
function showPasteBlockedNotice() {
  const notice = document.getElementById('pasteNotice');
  if (!notice) return;
  notice.classList.remove('hidden');
  clearTimeout(pasteNoticeTimer);
  pasteNoticeTimer = setTimeout(() => notice.classList.add('hidden'), 2500);
}
['paste', 'drop'].forEach((eventName) => {
  document.addEventListener(eventName, (event) => {
    const target = event.target;
    if (target && target.closest && target.closest('#editor')) {
      event.preventDefault();
      event.stopPropagation();
      showPasteBlockedNotice();
    }
  }, true);
});
document.addEventListener('dragover', (event) => {
  const target = event.target;
  if (target && target.closest && target.closest('#editor')) event.preventDefault();
}, true);
