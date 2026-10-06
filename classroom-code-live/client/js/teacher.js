// ================= base =================
const qs = new URLSearchParams(location.search);
const roomInput = document.getElementById('roomInput');
const classroomSelect = document.getElementById('classroomSelect');
const classroomNameInput = document.getElementById('classroomNameInput');
let teacherClassrooms = [];
const teacherRoomStorageKey = 'ccl-teacher-current-room';
let savedTeacherRoom = '';
try { savedTeacherRoom = localStorage.getItem(teacherRoomStorageKey) || ''; } catch (e) {}
// O HTML já pré-preencheu a sala (window._earlyTeacherRoom) antes do paint;
// aqui só garantimos a mesma prioridade: localStorage > ?room= > DOM.
roomInput.value = window._earlyTeacherRoom || savedTeacherRoom || qs.get('room') || roomInput.value;
function persistTeacherRoom(room) {
  const selectedRoom = String(room || '').trim();
  if (!selectedRoom) return;
  try { localStorage.setItem(teacherRoomStorageKey, selectedRoom); } catch (e) {}
  const nextUrl = new URL(location.href);
  nextUrl.searchParams.set('room', selectedRoom);
  history.replaceState(null, '', nextUrl);
}
function classroomNameForRoom(room) {
  const classroom = teacherClassrooms.find(item => item.id === room);
  return classroom ? classroom.name : room;
}
function renderClassroomSelect() {
  classroomSelect.textContent = '';
  teacherClassrooms.forEach(classroom => {
    const option = document.createElement('option');
    option.value = classroom.id;
    option.textContent = classroom.name + ' · ' + classroom.id;
    classroomSelect.appendChild(option);
  });
  const activeExists = teacherClassrooms.some(item => item.id === roomInput.value);
  if (!activeExists && roomInput.value) {
    const option = document.createElement('option');
    option.value = roomInput.value;
    option.textContent = roomInput.value + ' · sala atual';
    classroomSelect.appendChild(option);
  }
  classroomSelect.value = roomInput.value;
  classroomNameInput.value = classroomNameForRoom(roomInput.value);
  document.getElementById('renameClassroomBtn').disabled = !activeExists;
}
async function classroomRequest(url, options) {
  const response = await fetch(url, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || 'Não foi possível atualizar as turmas.');
  return result;
}
persistTeacherRoom(roomInput.value);
document.getElementById('teacherLogoutBtn').onclick = async () => {
  try {
    const response = await fetch('/teacher-logout', { method: 'POST' });
    if (!response.ok) throw new Error('Não foi possível terminar a sessão.');
    location.reload();
  } catch (error) {
    logEvent(error.message || 'Não foi possível terminar a sessão.');
  }
};

let socket = null;
try { socket = io(); } catch (e) { socket = null; }
// Socket opcional: sem servidor a página continua 100% utilizável para
// programar/projetar — só o live dos alunos fica desligado.
function emitSock(ev, data) { try { if (socket && socket.connected) socket.emit(ev, data); } catch (e) {} }
function onSock(ev, fn) { try { if (socket) socket.on(ev, fn); } catch (e) {} }
const students = new Map(); // studentId -> { name, language, code, online, updatedAt }
let focusId = null;
let boardEditor = null;
let frozen = false;
let sessionStart = Date.now();
let lastRoomT = roomInput.value;
let unread = 0;
let prevOnline = new Set();
const helpNotifications = new Set();
const AV_COLORS = ['#7c3aed', '#2563eb', '#059669', '#ea580c', '#db2777', '#0891b2'];
function avColor(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AV_COLORS[h % AV_COLORS.length]; }
function escapeHtml(t) { return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtDur(ms) { const m = Math.floor(ms / 60000); if (m < 1) return 'agora mesmo'; const h = Math.floor(m / 60); return h ? h + 'h ' + String(m % 60).padStart(2, '0') + 'm' : m + 'm'; }
function tickClock() { document.getElementById('infoTime').textContent = fmtDur(Date.now() - sessionStart); }
setInterval(tickClock, 20000);

// ---------- tema claro/escuro ----------
function applyThemeT(mode) {
  const light = mode === 'light';
  document.body.classList.toggle('light', light);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  try { localStorage.setItem('ccl-teacher-theme', light ? 'light' : 'dark'); } catch (e) {}
  document.getElementById('icoSun').classList.toggle('hidden', !light);
  document.getElementById('icoMoon').classList.toggle('hidden', light);
  if (window.monaco) monaco.editor.setTheme(light ? 'vs' : 'vs-dark');
}
let savedThemeT = 'dark';
try { savedThemeT = localStorage.getItem('ccl-teacher-theme') || 'dark'; } catch (e) {}
applyThemeT(savedThemeT === 'light' ? 'light' : 'dark');
document.getElementById('themeBtn').onclick = () => applyThemeT(document.body.classList.contains('light') ? 'dark' : 'light');

// ---------- tabs = vistas (cada uma mostra só a sua secção) ----------
// Início: tudo (dashboard) • Alunos: roster + foco (código grande)
// Projetor e tarefas focam no workspace da professora.
function showCol(id, show) {
  const el = document.getElementById(id);
  if (el) el.style.display = show ? '' : 'none';
}
function setTab(name) {
  document.querySelectorAll('.navtab').forEach(b => {
    const active = b.dataset.tab === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const isProjector = name === 'projetor';
  document.body.classList.toggle('projector-mode', isProjector);

  // Ajuste de fonte para o modo projetor (editor + terminal maiores).
  try { if (typeof weditor !== 'undefined' && weditor) weditor.updateOptions({ fontSize: isProjector ? 20 : 13 }); } catch (e) {}
  try {
    if (typeof terminal !== 'undefined' && terminal) {
      terminal.options.fontSize = isProjector ? 16 : 13;
      if (typeof terminalFitAddon !== 'undefined' && terminalFitAddon) {
        setTimeout(() => { try { terminalFitAddon.fit(); } catch (fitError) {} }, 80);
      }
    }
  } catch (e) {}

  const isAlunos = name === 'alunos';
  document.getElementById('mainViews').classList.toggle('hidden', name === 'tarefas');
  document.getElementById('viewAlunos').style.display = isAlunos ? 'flex' : 'none';
  showCol('colLeft', name === 'inicio');
  showCol('colCenter', name === 'inicio' || name === 'projetor');
  showCol('colRight', name === 'inicio');
  const tasksView = document.getElementById('tasksView');
  tasksView.classList.toggle('hidden', name !== 'tarefas');
  tasksView.classList.toggle('flex', name === 'tarefas');
  if (name === 'tarefas') {
    const t = document.getElementById('tasksView');
    t.scrollIntoView({ behavior: 'smooth', block: 'center' });
    t.style.boxShadow = '0 0 0 2px #8b5cf6';
    setTimeout(() => { t.style.boxShadow = ''; }, 1200);
    setTimeout(() => { const title = document.getElementById('taskTitle'); if (title) title.focus(); }, 350);
  }
  let _we = null, _be = null;
  try { _we = weditor; } catch (e) {}
  try { _be = boardEditor; } catch (e) {}
  const relayout = () => {
    try { if (_we) _we.layout(); if (_be) _be.layout(); } catch (e) {}
    try { if (typeof terminalFitAddon !== 'undefined' && terminalFitAddon && terminal) terminalFitAddon.fit(); } catch (e) {}
  };
  setTimeout(relayout, 60);
  setTimeout(relayout, 220);
  try { localStorage.setItem('ccl-teacher-tab', name); } catch (e) {}
}
document.querySelectorAll('.navtab').forEach(b => { b.onclick = () => setTab(b.dataset.tab); });
document.getElementById('homeTasksOpen').onclick = () => {
  const tasksTab = document.querySelector('.navtab[data-tab="tarefas"]');
  if (tasksTab) tasksTab.click();
};

// ---------- notificações ----------
function logEvent(text) {
  unread++;
  const badge = document.getElementById('bellBadge');
  badge.textContent = unread > 9 ? '9+' : unread;
  badge.classList.remove('hidden');
  const list = document.getElementById('bellList');
  const ph = list.querySelector('p');
  if (ph && list.children.length === 1) list.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'rounded bg-slate-800/70 px-2 py-1.5';
  d.innerHTML = '<span class="text-slate-500 font-mono">' + new Date().toLocaleTimeString() + '</span> ' + escapeHtml(text);
  list.prepend(d);
  while (list.children.length > 12) list.lastChild.remove();
}
document.getElementById('bellBtn').onclick = (e) => {
  e.stopPropagation();
  document.getElementById('bellPanel').classList.toggle('hidden');
  unread = 0;
  document.getElementById('bellBadge').classList.add('hidden');
};
document.addEventListener('click', (e) => {
  if (!document.getElementById('bellPanel').classList.contains('hidden') && !document.getElementById('bellPanel').contains(e.target)) document.getElementById('bellPanel').classList.add('hidden');
  const sm = document.getElementById('settingsMenu');
  if (!sm.classList.contains('hidden') && !sm.contains(e.target) && e.target.id !== 'settingsBtn') sm.classList.add('hidden');
});

// ---------- ligação e sala ----------
const connDot = document.getElementById('connDot');
function setConnectionStatus(connected, label) {
  connDot.className = 'w-2 h-2 rounded-full ' + (connected ? 'bg-emerald-400' : 'bg-red-500');
  document.getElementById('connLabel').textContent = label;
}
onSock('connect', () => { setConnectionStatus(true, 'Ligada'); join(); });
onSock('disconnect', () => setConnectionStatus(false, 'Sem ligação'));
onSock('connect_error', () => setConnectionStatus(false, 'Indisponível'));
onSock('teacher_auth_required', () => location.reload());
if (!socket) setConnectionStatus(false, 'Indisponível');

let taskHistory = [];
let taskHistoryRoom = '';
function taskHistoryKey(room) { return 'ccl-teacher-tasks:' + room; }
function loadTaskHistory(room) {
  taskHistoryRoom = room;
  try {
    const saved = JSON.parse(localStorage.getItem(taskHistoryKey(room)) || '[]');
    taskHistory = Array.isArray(saved) ? saved.filter(task =>
      task && typeof task.id === 'string' && typeof task.title === 'string' &&
      typeof task.description === 'string' && Number.isFinite(task.createdAt)
    ).map(task => ({ ...task, submissions: Array.isArray(task.submissions) ? task.submissions : [] })).slice(0, 20) : [];
  } catch (error) {
    taskHistory = [];
  }
  renderTaskHistory();
}
function renderTaskHistory() {
  const list = document.getElementById('taskList');
  list.textContent = '';
  updateHomeTaskSummary();
  if (!taskHistory.length) {
    const empty = document.createElement('p');
    empty.className = 'py-3 text-center text-xs text-slate-500';
    empty.textContent = 'Ainda não há tarefas publicadas nesta sala.';
    list.appendChild(empty);
    return;
  }
  taskHistory.forEach(task => {
    const submissions = Array.isArray(task.submissions) ? task.submissions : [];
    const latestByStudent = new Map();
    submissions.forEach(submission => latestByStudent.set(submission.studentId, submission));
    const people = new Map([...students.entries()].map(([id, student]) => [id, { id, name: student.name, online: student.online }]));
    latestByStudent.forEach((submission, id) => {
      if (!people.has(id)) people.set(id, { id, name: submission.studentName || 'Aluno', online: false });
    });
    const card = document.createElement('article');
    card.className = 'task-card p-3';
    const heading = document.createElement('div');
    heading.className = 'flex items-start gap-2';
    const title = document.createElement('h4');
    title.className = 'min-w-0 flex-1 text-sm font-semibold';
    title.textContent = task.title;
    const status = document.createElement('span');
    const deliveredCount = latestByStudent.size;
    const totalCount = Math.max(people.size, deliveredCount);
    status.className = 'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ' +
      (deliveredCount ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-700 text-slate-300');
    status.textContent = deliveredCount + ' / ' + totalCount + ' entregaram';
    const delTask = document.createElement('button');
    delTask.type = 'button';
    delTask.className = 'remove-student-btn';
    delTask.textContent = 'Eliminar';
    delTask.title = 'Eliminar esta tarefa e todas as entregas';
    delTask.setAttribute('aria-label', 'Eliminar a tarefa ' + task.title);
    delTask.onclick = () => deleteTask(task.id, task.title);
    const editTaskBtn = document.createElement('button');
    editTaskBtn.type = 'button';
    editTaskBtn.className = 'shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700';
    editTaskBtn.textContent = 'Editar';
    editTaskBtn.title = 'Editar título, instruções e prazo';
    editTaskBtn.setAttribute('aria-label', 'Editar a tarefa ' + task.title);
    editTaskBtn.onclick = () => openTaskEditModal(task.id);
    const dupTaskBtn = document.createElement('button');
    dupTaskBtn.type = 'button';
    dupTaskBtn.className = 'shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700';
    dupTaskBtn.textContent = 'Duplicar';
    dupTaskBtn.title = 'Carregar uma cópia no formulário para publicar de novo';
    dupTaskBtn.setAttribute('aria-label', 'Duplicar a tarefa ' + task.title);
    dupTaskBtn.onclick = () => duplicateTask(task.id);
    heading.append(title, status, editTaskBtn, dupTaskBtn, delTask);
    const description = document.createElement('p');
    description.className = 'mt-1 whitespace-pre-wrap break-words text-xs text-slate-400';
    description.textContent = task.description;
    const when = document.createElement('p');
    when.className = 'mt-2 text-[10px] text-slate-500';
    when.textContent = 'Publicada em ' + new Date(task.createdAt).toLocaleString() +
      (task.deadlineAt ? ' • Prazo: ' + new Date(task.deadlineAt).toLocaleString() : '') +
      (task.editedAt ? ' • Editada em ' + new Date(task.editedAt).toLocaleString() : '');
    const deliveryList = document.createElement('div');
    deliveryList.className = 'task-submissions mt-3 space-y-2';
    const sectionTitle = document.createElement('h5');
    sectionTitle.className = 'text-xs font-semibold text-slate-300';
    sectionTitle.textContent = 'Entregas dos alunos';
    deliveryList.appendChild(sectionTitle);
    if (!people.size) {
      const noStudents = document.createElement('p');
      noStudents.className = 'text-xs text-slate-500';
      noStudents.textContent = 'Ainda não há alunos registados nesta sala.';
      deliveryList.appendChild(noStudents);
    }
    [...people.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt')).forEach(person => {
      const attempts = submissions.filter(submission => submission.studentId === person.id);
      const row = document.createElement('details');
      row.className = 'submission-card p-2';
      const summary = document.createElement('summary');
      summary.className = 'flex cursor-pointer list-none items-start gap-2 text-xs';
      const studentName = document.createElement('span');
      studentName.className = 'min-w-0 flex-1 font-medium';
      studentName.textContent = person.name;
      const deliveryState = document.createElement('span');
      deliveryState.className = attempts.length
        ? 'text-emerald-400'
        : (person.online ? 'text-amber-300' : 'text-slate-500');
      deliveryState.textContent = attempts.length
        ? 'Entregue' + (attempts[attempts.length - 1].late ? ' com atraso' : '') +
          ' • ' + new Date(attempts[attempts.length - 1].submittedAt).toLocaleString()
        : ((task.deadlineAt && Date.now() > task.deadlineAt) ? 'Atrasada' : 'Por entregar') +
          (person.online ? ' • online' : ' • offline');
      summary.append(studentName, deliveryState);
      row.appendChild(summary);
      attempts.slice().reverse().forEach((submission, index) => {
        const attempt = document.createElement('div');
        attempt.className = 'mt-2 border-t border-slate-700/60 pt-2';
        const meta = document.createElement('p');
        meta.className = 'mb-1 text-[10px] text-slate-500';
        meta.textContent = (attempts.length > 1 ? 'Entrega ' + (attempts.length - index) + ' • ' : '') +
          new Date(submission.submittedAt).toLocaleString() + ' • ' + submission.language +
          ' • ' + submission.code.length + ' caracteres' + (submission.late ? ' • ATRASADA' : '');
        const code = document.createElement('pre');
        code.className = 'submission-code';
        code.textContent = submission.code;
        const feedback = document.createElement('p');
        feedback.className = 'mb-2 whitespace-pre-wrap rounded bg-violet-500/5 p-2 text-xs text-violet-200';
        if (submission.feedback) {
          feedback.textContent = 'Feedback: ' + submission.feedback +
            (submission.feedbackAt ? ' • ' + new Date(submission.feedbackAt).toLocaleString() : '');
          attempt.appendChild(feedback);
        }
        if (index === 0) {
        const feedbackForm = document.createElement('form');
        feedbackForm.className = 'mt-2 flex flex-col gap-2 sm:flex-row';
        const feedbackInput = document.createElement('textarea');
        feedbackInput.maxLength = 2000;
        feedbackInput.required = true;
        feedbackInput.rows = 2;
        feedbackInput.value = submission.feedback || '';
        feedbackInput.placeholder = 'Escreve feedback para este código…';
        feedbackInput.className = 'min-w-0 flex-1 resize-y rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs';
        const feedbackButton = document.createElement('button');
        feedbackButton.type = 'submit';
        feedbackButton.className = 'self-start rounded bg-violet-600 px-3 py-2 text-xs font-semibold hover:bg-violet-500';
        feedbackButton.textContent = 'Enviar feedback';
        feedbackForm.append(feedbackInput, feedbackButton);
        feedbackForm.onsubmit = event => {
          event.preventDefault();
          emitSock('task_feedback', {
            roomId: roomInput.value, taskId: task.id,
            submissionId: submission.id, feedback: feedbackInput.value.trim()
          });
          feedbackButton.disabled = true;
          feedbackButton.textContent = 'A enviar…';
        };
          attempt.appendChild(feedbackForm);
        }
        attempt.prepend(meta);
        attempt.appendChild(code);
        row.appendChild(attempt);
      });
      deliveryList.appendChild(row);
    });
    card.append(heading, description, when, deliveryList);
    list.appendChild(card);
  });
}
function updateHomeTaskSummary() {
  const count = document.getElementById('homeTaskCount');
  const summary = document.getElementById('homeTaskSummary');
  if (!count || !summary) return;
  count.textContent = String(taskHistory.length);
  if (!taskHistory.length) {
    summary.textContent = 'Ainda não há tarefas nesta sala.';
    return;
  }
  const latest = taskHistory[0];
  const deliveries = new Set((latest.submissions || []).map(submission => submission.studentId)).size;
  summary.textContent = 'Mais recente: ' + latest.title + ' — ' + deliveries + ' de ' + students.size + ' aluno(s) entregaram.' +
    (latest.deadlineAt ? ' Prazo: ' + new Date(latest.deadlineAt).toLocaleString() + '.' : '');
}
function saveTaskHistory() {
  try { localStorage.setItem(taskHistoryKey(taskHistoryRoom), JSON.stringify(taskHistory)); } catch (error) {}
}
function handleClassTasks(tasks) {
  if (!Array.isArray(tasks)) return;
  taskHistory = tasks.filter(task => task && typeof task.id === 'string' &&
    typeof task.title === 'string' && typeof task.description === 'string')
    .map(task => ({ ...task, submissions: Array.isArray(task.submissions) ? task.submissions : [] }))
    .slice(-20).reverse();
  taskHistoryRoom = roomInput.value;
  saveTaskHistory();
  renderTaskHistory();
}
function handlePublishedTask(task) {
  if (!task || task.roomId !== roomInput.value || typeof task.id !== 'string' ||
      typeof task.title !== 'string' || typeof task.description !== 'string') return;
  if (taskHistoryRoom !== task.roomId) loadTaskHistory(task.roomId);
  const existingIndex = taskHistory.findIndex(entry => entry.id === task.id);
  if (existingIndex >= 0) {
    taskHistory[existingIndex] = { ...taskHistory[existingIndex], ...task,
      submissions: Array.isArray(task.submissions) ? task.submissions : taskHistory[existingIndex].submissions || [] };
  } else {
    taskHistory.unshift({ ...task, submissions: Array.isArray(task.submissions) ? task.submissions : [] });
  }
  taskHistory = taskHistory.slice(0, 20);
  renderTaskHistory();
  saveTaskHistory();
  document.getElementById('taskFeedback').textContent =
    'Tarefa publicada para ' + [...students.values()].filter(student => student.online).length + ' aluno(s) ligado(s).';
  document.getElementById('taskPublishBtn').disabled = false;
  document.getElementById('taskPublishBtn').textContent = 'Publicar tarefa';
  document.getElementById('taskForm').reset();
  if (existingIndex < 0) logEvent('Tarefa publicada: ' + task.title);
}
async function deleteTask(taskId, title) {
  const confirmed = await teacherConfirm({
    title: 'Eliminar tarefa',
    message: 'Eliminar a tarefa "' + title + '"? Todas as entregas e feedbacks serão apagados permanentemente.',
    okLabel: 'Eliminar',
    danger: true
  });
  if (!confirmed) return;
  if (!socket || !socket.connected) {
    logEvent('Sem ligação ao servidor — a tarefa não foi eliminada.');
    return;
  }
  socket.emit('delete_task', { roomId: roomInput.value, taskId });
}
function handleDeletedTask({ taskId } = {}) {
  if (typeof taskId !== 'string') return;
  const index = taskHistory.findIndex(entry => entry.id === taskId);
  if (index < 0) return;
  const removed = taskHistory[index];
  taskHistory.splice(index, 1);
  saveTaskHistory();
  renderTaskHistory();
  logEvent('Tarefa eliminada: ' + (removed ? removed.title : taskId));
}
function toLocalDateTimeInput(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  try { return new Date(timestamp - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  catch (error) { return ''; }
}
let editingTaskId = null;
function openTaskEditModal(taskId) {
  const task = taskHistory.find(entry => entry.id === taskId);
  if (!task) return;
  editingTaskId = taskId;
  document.getElementById('editTaskTitle').value = task.title;
  document.getElementById('editTaskDescription').value = task.description;
  document.getElementById('editTaskDeadline').value = task.deadlineAt ? toLocalDateTimeInput(task.deadlineAt) : '';
  document.getElementById('editTaskFeedback').textContent = '';
  const save = document.getElementById('editTaskSave');
  save.disabled = false;
  save.textContent = 'Guardar alterações';
  const modal = document.getElementById('taskEditModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => { try { document.getElementById('editTaskTitle').focus(); } catch (e) {} }, 50);
}
function closeTaskEditModal() {
  editingTaskId = null;
  const modal = document.getElementById('taskEditModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}
function duplicateTask(taskId) {
  const task = taskHistory.find(entry => entry.id === taskId);
  if (!task) return;
  document.getElementById('taskTitle').value = task.title + ' (cópia)';
  document.getElementById('taskDescription').value = task.description;
  document.getElementById('taskDeadline').value = task.deadlineAt ? toLocalDateTimeInput(task.deadlineAt) : '';
  document.getElementById('taskFeedback').textContent = 'Cópia carregada — revê e prime Publicar tarefa.';
  const composer = document.querySelector('#tasksView .task-composer');
  if (composer) composer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => { const title = document.getElementById('taskTitle'); if (title) title.focus(); }, 350);
}
function handleEditedTask(task) {
  if (!task || task.roomId !== roomInput.value || typeof task.id !== 'string') return;
  const index = taskHistory.findIndex(entry => entry.id === task.id);
  if (index < 0) return;
  taskHistory[index] = {
    ...taskHistory[index], ...task,
    submissions: Array.isArray(task.submissions) ? task.submissions : (taskHistory[index].submissions || [])
  };
  saveTaskHistory();
  renderTaskHistory();
  if (editingTaskId === task.id) closeTaskEditModal();
  logEvent('Tarefa atualizada: ' + task.title);
}
document.getElementById('taskEditForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!editingTaskId) return;
  const title = document.getElementById('editTaskTitle').value.trim();
  const description = document.getElementById('editTaskDescription').value.trim();
  const deadlineValue = document.getElementById('editTaskDeadline').value;
  if (!title || !description) {
    document.getElementById('editTaskFeedback').textContent = 'Preenche o título e as instruções da tarefa.';
    return;
  }
  if (!socket || !socket.connected) {
    document.getElementById('editTaskFeedback').textContent = 'Sem ligação ao servidor. As alterações não foram enviadas.';
    return;
  }
  const save = document.getElementById('editTaskSave');
  save.disabled = true;
  save.textContent = 'A guardar…';
  socket.emit('edit_task', {
    roomId: roomInput.value, taskId: editingTaskId, title, description,
    deadlineAt: deadlineValue ? new Date(deadlineValue).getTime() : null
  });
});
document.getElementById('editTaskCancel').onclick = closeTaskEditModal;
document.getElementById('editTaskClose').onclick = closeTaskEditModal;
document.getElementById('taskEditModal').addEventListener('click', event => {
  if (event.target.id === 'taskEditModal') closeTaskEditModal();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && editingTaskId &&
      !document.getElementById('taskEditModal').classList.contains('hidden')) closeTaskEditModal();
});
function handleTaskSubmission({ taskId, submission } = {}) {
  const task = taskHistory.find(entry => entry.id === taskId);
  if (!task || !submission || typeof submission.id !== 'string') return;
  if (!Array.isArray(task.submissions)) task.submissions = [];
  const previous = task.submissions.findIndex(entry => entry.id === submission.id);
  if (previous >= 0) task.submissions[previous] = { ...task.submissions[previous], ...submission };
  else task.submissions.push(submission);
  renderTaskHistory();
  saveTaskHistory();
  if (previous < 0) logEvent('Entrega recebida de ' + (submission.studentName || 'aluno') + '.');
}
function handleFeedbackSaved({ taskId, submission } = {}) {
  const task = taskHistory.find(entry => entry.id === taskId);
  if (!task || !submission) return;
  const index = task.submissions.findIndex(entry => entry.id === submission.id);
  if (index >= 0) task.submissions[index] = { ...task.submissions[index], ...submission };
  renderTaskHistory();
  saveTaskHistory();
  logEvent('Feedback enviado a ' + (submission.studentName || 'aluno') + '.');
}
document.getElementById('taskForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = document.getElementById('taskTitle').value.trim();
  const description = document.getElementById('taskDescription').value.trim();
  const deadlineValue = document.getElementById('taskDeadline').value;
  const deadlineAt = deadlineValue ? new Date(deadlineValue).getTime() : null;
  if (!title || !description) {
    document.getElementById('taskFeedback').textContent = 'Preenche o título e as instruções da tarefa.';
    return;
  }
  if (!socket || !socket.connected) {
    document.getElementById('taskFeedback').textContent = 'Sem ligação ao servidor. A tarefa não foi enviada.';
    return;
  }
  const button = document.getElementById('taskPublishBtn');
  button.disabled = true;
  button.textContent = 'A publicar…';
  document.getElementById('taskFeedback').textContent = 'A enviar para a sala ' + roomInput.value + '…';
  socket.emit('publish_task', { roomId: roomInput.value, title, description, deadlineAt });
});
onSock('teacher_task', handlePublishedTask);
onSock('class_tasks', handleClassTasks);
onSock('task_deleted', handleDeletedTask);
onSock('task_edited', handleEditedTask);
onSock('task_edit_error', ({ message } = {}) => {
  const feedback = document.getElementById('editTaskFeedback');
  if (feedback) feedback.textContent = message || 'Não foi possível guardar as alterações.';
  const save = document.getElementById('editTaskSave');
  if (save) { save.disabled = false; save.textContent = 'Guardar alterações'; }
});
onSock('task_delete_error', ({ message } = {}) => {
  if (message) logEvent(message);
});
onSock('task_submission', handleTaskSubmission);
onSock('feedback_saved', handleFeedbackSaved);
onSock('feedback_error', ({ submissionId, message } = {}) => {
  const buttons = [...document.querySelectorAll('#taskList button[type="submit"]')];
  buttons.forEach(button => { button.disabled = false; button.textContent = 'Enviar feedback'; });
  if (message) logEvent(message);
});
onSock('task_error', ({ message } = {}) => {
  document.getElementById('taskPublishBtn').disabled = false;
  document.getElementById('taskPublishBtn').textContent = 'Publicar tarefa';
  document.getElementById('taskFeedback').textContent = message || 'Não foi possível publicar a tarefa.';
});

function joinUI() {
  const room = roomInput.value.trim();
  if (!room) {
    logEvent('Indica o código da turma antes de entrar.');
    return false;
  }
  roomInput.value = room;
  persistTeacherRoom(room);
  const classroomName = classroomNameForRoom(room);
  classroomNameInput.value = classroomName;
  if ([...classroomSelect.options].some(option => option.value === room)) classroomSelect.value = room;
  document.getElementById('renameClassroomBtn').disabled = !teacherClassrooms.some(item => item.id === room);
  if (room !== lastRoomT) {
    sessionStart = Date.now();
    prevOnline = new Set();
    helpNotifications.clear();
    lastRoomT = room;
  }
  document.getElementById('sessRoom').textContent = classroomName;
  document.getElementById('profileCurrentClass').textContent = classroomName === room ? classroomName : classroomName + ' (' + room + ')';
  document.getElementById('roomName').textContent = classroomName;
  document.getElementById('infoRoom').textContent = classroomName;
  document.getElementById('taskRoomLabel').textContent = classroomName;
  document.getElementById('roomAvatar').textContent = (classroomName.trim()[0] || 'R').toUpperCase();
  document.getElementById('roomBadge').textContent = frozen ? '■ Congelada' : '● Online';
  // Save the current room before restoring that room's separate examples.
  if (typeof weditor !== 'undefined' && weditor) {
    if (window._wroom && window._wroom !== room) {
      saveWorkspaceForRoom(window._wroom);
      const roomWorkspace = loadWorkspaceForRoom(room);
      workspaceFiles = roomWorkspace.files;
      activeWorkspaceFileId = roomWorkspace.activeFileId;
      weditor.setValue(getActiveWorkspaceFile().code);
      renderWorkspaceFiles();
    } else {
      saveWorkspaceForRoom(room);
    }
  }
  if (taskHistoryRoom !== room) loadTaskHistory(room);
  window._wroom = room;
  tickClock();
  return true;
}
function join() {
  if (!joinUI()) return;
  emitSock('join_room', { roomId: roomInput.value, name: 'Professora', role: 'teacher' });
  emitSock('request_snapshot', { roomId: roomInput.value });
}
document.getElementById('joinBtn').onclick = join;
classroomSelect.addEventListener('change', () => {
  if (!classroomSelect.value) return;
  roomInput.value = classroomSelect.value;
  join();
});
document.getElementById('createClassroomBtn').onclick = async () => {
  const name = document.getElementById('newClassroomNameInput').value.trim();
  const status = document.getElementById('classroomStatus');
  if (!name) { status.textContent = 'Indica um nome.'; return; }
  try {
    const classroom = await classroomRequest('/teacher-classrooms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
    });
    teacherClassrooms.push(classroom);
    document.getElementById('newClassroomNameInput').value = '';
    renderClassroomSelect();
    classroomSelect.value = classroom.id;
    roomInput.value = classroom.id;
    join();
    status.textContent = 'Turma criada.';
  } catch (error) {
    status.textContent = error.message;
  }
};
document.getElementById('renameClassroomBtn').onclick = async () => {
  const room = classroomSelect.value;
  const name = classroomNameInput.value.trim();
  const status = document.getElementById('classroomStatus');
  if (!room || !name) { status.textContent = 'Indica um nome.'; return; }
  try {
    const updated = await classroomRequest('/teacher-classrooms/' + encodeURIComponent(room), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
    });
    teacherClassrooms = teacherClassrooms.map(item => item.id === room ? updated : item);
    renderClassroomSelect();
    joinUI();
    status.textContent = 'Nome atualizado.';
  } catch (error) {
    status.textContent = error.message;
  }
};
async function loadClassrooms() {
  const status = document.getElementById('classroomStatus');
  try {
    teacherClassrooms = await classroomRequest('/teacher-classrooms');
    if (!teacherClassrooms.some(item => item.id === roomInput.value)) {
      const legacyId = roomInput.value.trim();
      if (legacyId) {
        try {
          const migrated = await classroomRequest('/teacher-classrooms', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: legacyId, roomId: legacyId })
          });
          if (!teacherClassrooms.some(item => item.id === migrated.id)) teacherClassrooms.push(migrated);
        } catch (error) {}
      }
    }
    renderClassroomSelect();
    joinUI();
  } catch (error) {
    renderClassroomSelect();
    status.textContent = error.message;
  }
}
loadClassrooms();
document.getElementById('snapshotBtn').onclick = () => {
  if (!socket || !socket.connected) { logEvent('Sem ligação ao servidor — liga o servidor para pedir snapshot.'); return; }
  emitSock('request_snapshot', { roomId: roomInput.value });
};
document.getElementById('settingsBtn').onclick = (e) => { e.stopPropagation(); document.getElementById('settingsMenu').classList.toggle('hidden'); };
const profileBtn = document.getElementById('profileBtn');
const profileMenu = document.getElementById('profileMenu');
const classroomManager = document.getElementById('classroomManager');
const classroomManagerToggle = document.getElementById('classroomManagerToggle');
function closeProfileMenu() {
  profileMenu.classList.add('hidden');
  profileBtn.setAttribute('aria-expanded', 'false');
  classroomManager.classList.add('hidden');
  classroomManagerToggle.setAttribute('aria-expanded', 'false');
}
profileBtn.onclick = event => {
  event.stopPropagation();
  const isOpening = profileMenu.classList.contains('hidden');
  profileMenu.classList.toggle('hidden');
  profileBtn.setAttribute('aria-expanded', String(isOpening));
};
classroomManagerToggle.onclick = () => {
  const isOpening = classroomManager.classList.contains('hidden');
  classroomManager.classList.toggle('hidden');
  classroomManagerToggle.setAttribute('aria-expanded', String(isOpening));
};
document.addEventListener('click', event => {
  if (!profileMenu.contains(event.target) && !profileBtn.contains(event.target)) closeProfileMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeProfileMenu();
});
document.getElementById('roomEditBtn').onclick = () => {
  const r = prompt('Mudar de sala:', roomInput.value);
  if (r && r.trim()) { roomInput.value = r.trim(); join(); }
};
function openInviteModal() {
  const room = roomInput.value.trim();
  const classroomName = classroomNameForRoom(room);
  const invite = location.origin + '/?room=' + encodeURIComponent(room);
  document.getElementById('inviteRoomLabel').textContent = classroomName === room ? room : classroomName + ' (' + room + ')';
  document.getElementById('inviteLink').value = invite;
  document.getElementById('inviteQr').src = '/invite-qr.png?room=' + encodeURIComponent(room) + '&v=' + Date.now();
  document.getElementById('inviteFeedback').textContent = '';
  const modal = document.getElementById('inviteModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}
function closeInviteModal() {
  const modal = document.getElementById('inviteModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}
// Confirmação dentro da página (não usa o confirm() nativo, que o browser
// pode bloquear se o utilizador desativou os diálogos do site).
let confirmResolver = null;
function teacherConfirm({ title, message, okLabel, danger } = {}) {
  if (confirmResolver) { confirmResolver(false); confirmResolver = null; }
  const modal = document.getElementById('confirmModal');
  document.getElementById('confirmTitle').textContent = title || 'Confirmar';
  document.getElementById('confirmMessage').textContent = message || '';
  const okBtn = document.getElementById('confirmOk');
  okBtn.textContent = okLabel || 'Confirmar';
  okBtn.className = danger
    ? 'rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500'
    : 'rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500';
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => { try { document.getElementById('confirmCancel').focus(); } catch (e) {} }, 50);
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}
function settleConfirm(value) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  const modal = document.getElementById('confirmModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  resolve(value);
}
document.getElementById('confirmOk').onclick = () => settleConfirm(true);
document.getElementById('confirmCancel').onclick = () => settleConfirm(false);
document.getElementById('confirmModal').addEventListener('click', event => {
  if (event.target.id === 'confirmModal') settleConfirm(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && confirmResolver) settleConfirm(false);
});
document.getElementById('inviteBtn').onclick = openInviteModal;
document.getElementById('inviteToolbarBtn').onclick = openInviteModal;
document.getElementById('inviteClose').onclick = closeInviteModal;
document.getElementById('inviteModal').addEventListener('click', event => {
  if (event.target.id === 'inviteModal') closeInviteModal();
});
document.getElementById('inviteQr').onerror = () => {
  document.getElementById('inviteFeedback').textContent = 'Não foi possível gerar o QR. Verifica se o servidor está ligado.';
};
document.getElementById('inviteCopy').onclick = async () => {
  const input = document.getElementById('inviteLink');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch (error) {
    input.select();
    if (!document.execCommand('copy')) {
      document.getElementById('inviteFeedback').textContent = 'Copia o link selecionado manualmente.';
      return;
    }
  }
  document.getElementById('inviteFeedback').textContent = 'Link copiado.';
};
document.getElementById('presentationBtn').onclick = () => {
  const enabled = !document.body.classList.contains('presentation-mode');
  document.body.classList.toggle('presentation-mode', enabled);
  document.getElementById('presentationBtn').textContent = enabled ? 'Sair da apresentação' : 'Apresentar';
  if (enabled) setTab('projetor');
  setTimeout(() => {
    try { if (weditor) weditor.layout(); } catch (e) {}
    try { fitTeacherTerminal(); } catch (e) {}
  }, 80);
};
function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}
document.getElementById('backupBtn').onclick = () => {
  if (!socket || !socket.connected) {
    logEvent('Sem ligação ao servidor — não foi possível pedir o backup.');
    return;
  }
  emitSock('request_backup', { roomId: roomInput.value });
};
onSock('backup_data', backup => {
  if (!backup || backup.roomId !== roomInput.value) return;
  const safeRoom = roomInput.value.replace(/[^a-zA-Z0-9_-]/g, '_');
  downloadJson(backup, `backup-${safeRoom}-${new Date().toISOString().slice(0, 10)}.json`);
  logEvent('Backup da turma descarregado.');
});
document.getElementById('restoreBackupBtn').onclick = () => document.getElementById('backupInput').click();
document.getElementById('backupInput').onchange = event => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    logEvent('O backup é demasiado grande (máximo 25 MB).');
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => logEvent('Não foi possível ler o ficheiro de backup.');
  reader.onload = () => {
    let backup;
    try { backup = JSON.parse(String(reader.result || '')); }
    catch (error) { logEvent('O ficheiro selecionado não contém JSON válido.'); return; }
    if (!backup || backup.version !== 1 || backup.roomId !== roomInput.value) {
      logEvent('Este backup não corresponde à turma atual (' + roomInput.value + ').');
      return;
    }
    if (!confirm('Importar este backup vai substituir os alunos, códigos e tarefas guardados desta turma. Continuar?')) return;
    emitSock('restore_backup', backup);
  };
  reader.readAsText(file);
};
onSock('backup_restored', ({ roomId, students: studentCount, tasks: taskCount } = {}) => {
  if (roomId !== roomInput.value) return;
  logEvent('Backup restaurado: ' + studentCount + ' aluno(s), ' + taskCount + ' tarefa(s).');
});
onSock('backup_error', ({ message } = {}) => {
  const exportButton = document.getElementById('exportSubmissionsBtn');
  exportButton.disabled = false;
  exportButton.textContent = 'Descarregar entregas (.zip)';
  logEvent(message || 'Não foi possível processar o backup.');
});
document.getElementById('exportSubmissionsBtn').onclick = () => {
  if (!socket || !socket.connected) { logEvent('Sem ligação ao servidor — não foi possível exportar.'); return; }
  document.getElementById('exportSubmissionsBtn').disabled = true;
  document.getElementById('exportSubmissionsBtn').textContent = 'A preparar ZIP…';
  emitSock('export_submissions', { roomId: roomInput.value });
};
onSock('submissions_zip', ({ roomId, fileName, data } = {}) => {
  const button = document.getElementById('exportSubmissionsBtn');
  button.disabled = false;
  button.textContent = 'Descarregar entregas (.zip)';
  if (roomId !== roomInput.value || !data) return;
  const blob = new Blob([data], { type: 'application/zip' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName || 'entregas.zip';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  logEvent('ZIP das entregas descarregado.');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeInviteModal();
});

// ---------- congelar ----------
function updateFreezeUI() {
  const b = document.getElementById('freezeBtn');
  b.textContent = frozen ? 'Descongelar turma' : 'Congelar turma';
  b.className = frozen
    ? 'w-full bg-red-600 hover:bg-red-500 rounded-lg py-2 text-xs font-semibold'
    : 'w-full bg-violet-600 hover:bg-violet-500 rounded-lg py-2 text-xs font-semibold';
  document.getElementById('roomBadge').textContent = frozen ? '■ Congelada' : '● Online';
  document.getElementById('roomSub').textContent = frozen ? 'Turma congelada — editores só de leitura.' : 'A programar no workspace...';
}
document.getElementById('freezeBtn').onclick = () => {
  if (!socket || !socket.connected) { logEvent('Sem ligação ao servidor — liga o servidor para congelar.'); return; }
  emitSock('freeze', { roomId: roomInput.value, frozen: !frozen });
};
onSock('freeze_state', ({ frozen: f }) => {
  const was = frozen;
  frozen = f === true;
  updateFreezeUI();
  if (frozen !== was) logEvent(frozen ? 'Turma congelada.' : 'Turma descongelada.');
});

// ---- eventos live (roster inclui offline; chave = studentId persistente) ----
function rosterCacheKey() { return 'ccl-roster:' + roomInput.value; }
function saveRosterCache() {
  try { localStorage.setItem(rosterCacheKey(), JSON.stringify([...students.entries()])); } catch (e) {}
}
onSock('room_state', (list) => {
  const activeHelpRequests = new Set(
    list.filter(s => s.progressStatus === 'help').map(s => s.studentId)
  );
  list.filter(s => s.progressStatus === 'help').forEach(s => {
    if (!helpNotifications.has(s.studentId)) {
      logEvent((s.name || 'Um aluno') + ' pediu ajuda.');
    }
  });
  helpNotifications.clear();
  activeHelpRequests.forEach(studentId => helpNotifications.add(studentId));
  const nowOnline = new Set(list.filter(s => s.online !== false).map(s => s.studentId));
  list.filter(s => s.online !== false && !prevOnline.has(s.studentId)).forEach(s => logEvent(s.name + ' entrou na sala.'));
  [...prevOnline].filter(id => !nowOnline.has(id)).forEach(id => {
    const s = students.get(id);
    logEvent((s ? s.name : 'Aluno') + ' saiu.');
  });
  prevOnline = nowOnline;
  students.clear();
  list.forEach(s => students.set(s.studentId, {
    name: s.name, language: s.language, code: s.code || '', online: s.online !== false,
    updatedAt: s.updatedAt || 0, joinedAt: s.joinedAt || 0, lastSeenAt: s.lastSeenAt || 0,
    progressStatus: s.progressStatus || 'not_started', progressUpdatedAt: s.progressUpdatedAt || 0
  }));
  if (!focusId || !students.has(focusId)) focusId = [...students.keys()][0] || null;
  saveRosterCache();
  render();
  renderTaskHistory();
});
onSock('student_removed', ({ studentId, name } = {}) => {
  if (!studentId || !students.has(studentId)) return;
  const removedStudent = students.get(studentId);
  students.delete(studentId);
  prevOnline.delete(studentId);
  if (focusId === studentId) focusId = [...students.keys()][0] || null;
  taskHistory.forEach(task => {
    task.submissions = (task.submissions || []).filter(submission => submission.studentId !== studentId);
  });
  saveRosterCache();
  saveTaskHistory();
  render();
  renderTaskHistory();
  logEvent((name || removedStudent.name) + ' e os respetivos dados foram eliminados desta turma.');
});
onSock('student_remove_error', ({ message } = {}) => {
  if (message) logEvent(message);
});
onSock('code_update', ({ studentId, name, code, language, progressStatus, progressUpdatedAt, joinedAt, lastSeenAt }) => {
  const previous = students.get(studentId) || {};
  if (progressStatus === 'help') {
    if (!helpNotifications.has(studentId)) logEvent((name || 'Um aluno') + ' pediu ajuda.');
    helpNotifications.add(studentId);
  } else {
    helpNotifications.delete(studentId);
  }
  students.set(studentId, {
    ...previous, name, language, code, online: true, updatedAt: Date.now(),
    progressStatus: progressStatus || 'working', progressUpdatedAt: progressUpdatedAt || Date.now(),
    joinedAt: joinedAt || previous.joinedAt || 0, lastSeenAt: lastSeenAt || Date.now()
  });
  if (!focusId) focusId = studentId;
  saveRosterCache();
  render();
});
onSock('student_left', ({ studentId }) => {
  const s = students.get(studentId);
  if (s) { s.online = false; s.lastSeenAt = Date.now(); saveRosterCache(); render(); renderTaskHistory(); }
});
function progressLabel(status) {
  if (status === 'help') return 'Precisa de ajuda';
  if (status === 'working') return 'A trabalhar';
  return 'Ainda não começou';
}
function formatAttendance(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : '—';
}

// ================= render =================
const list = document.getElementById('studentList');
async function removeStudent(studentId) {
  const student = students.get(studentId);
  if (!student) return;
  const confirmed = await teacherConfirm({
    title: 'Eliminar aluno',
    message: 'Eliminar ' + student.name + ' desta turma? O código guardado no servidor e todas as entregas e feedbacks serão apagados permanentemente. A cópia local no dispositivo do aluno não será apagada.',
    okLabel: 'Eliminar',
    danger: true
  });
  if (!confirmed) return;
  if (!socket || !socket.connected) {
    logEvent('Sem ligação ao servidor — o aluno não foi eliminado.');
    return;
  }
  socket.emit('remove_student', { roomId: roomInput.value, studentId });
}
function createRemoveStudentButton(studentId, student) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'remove-student-btn';
  button.textContent = 'Eliminar';
  button.title = 'Eliminar o aluno e apagar permanentemente os dados guardados no servidor';
  button.setAttribute('aria-label', 'Eliminar ' + student.name + ' e os dados da turma');
  button.onclick = (event) => {
    event.stopPropagation();
    removeStudent(studentId);
  };
  return button;
}
function render() {
  const q = document.getElementById('search').value.toLowerCase();
  list.innerHTML = '';
  let totalChars = 0;
  let onlineCount = 0;
  const entries = [...students.entries()].sort((a, b) => ((b[1].online ? 1 : 0) - (a[1].online ? 1 : 0)));
  entries.forEach(([id, s]) => {
    totalChars += (s.code || '').length;
    if (s.online) onlineCount++;
    if (!s.name.toLowerCase().includes(q)) return;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-1';
    const b = document.createElement('button');
    b.className = 'rowitem min-w-0 flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left border ' + (id === focusId ? 'active bg-violet-600/20 border-violet-500/50' : 'border-transparent hover:bg-slate-800');
    b.innerHTML =
      '<span class="w-8 h-8 rounded-full grid place-items-center text-xs font-bold shrink-0" style="background:' + avColor(id) + '">' + escapeHtml((s.name.trim()[0] || 'A').toUpperCase()) + '</span>' +
      '<span class="min-w-0"><span class="block text-xs font-medium truncate">' + escapeHtml(s.name) + '</span>' +
      '<span class="block text-[11px] ' + (s.progressStatus === 'help' ? 'text-amber-300' : (s.online ? 'text-slate-400' : 'text-slate-600')) + '">' +
      (s.online ? '● Online' : '○ Offline') + ' • ' + escapeHtml(progressLabel(s.progressStatus)) + '</span></span>' +
      '<span class="ml-auto text-slate-600">›</span>';
    b.title = 'Entrou: ' + formatAttendance(s.joinedAt) + ' • Última atividade: ' + formatAttendance(s.lastSeenAt);
    b.onclick = () => { focusId = id; render(); };
    const remove = createRemoveStudentButton(id, s);
    row.append(b, remove);
    list.appendChild(row);
  });
  if (students.size === 0) list.innerHTML = '<p class="text-xs text-slate-500 px-1">Nenhum aluno ligado. Alunos: <code class="font-mono">/?room=' + escapeHtml(roomInput.value) + '</code></p>';
  // ---- board da vista Alunos: só cartões ----
  const bg = document.getElementById('boardGrid');
  const qb = document.getElementById('searchBoard').value.toLowerCase();
  bg.innerHTML = '';
  entries.forEach(([id, s]) => {
    if (!s.name.toLowerCase().includes(qb)) return;
    const card = document.createElement('div');
    card.className = 'min-w-0 text-left rounded-xl overflow-hidden border transition cursor-pointer ' + (id === focusId ? 'bg-slate-900 border-violet-500' : 'bg-slate-900 border-slate-800 hover:border-violet-500');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', 'Ver código de ' + s.name);
    card.innerHTML =
      '<div class="flex items-center gap-2 px-3 py-2 border-b border-slate-800">' +
        '<span class="w-8 h-8 rounded-full grid place-items-center text-xs font-bold shrink-0" style="background:' + avColor(id) + '">' + escapeHtml((s.name.trim()[0] || 'A').toUpperCase()) + '</span>' +
        '<span class="min-w-0"><span class="block text-xs font-medium truncate">' + escapeHtml(s.name) + (s.online === false ? ' <span class="text-[10px] text-slate-500">(offline)</span>' : '') + '</span>' +
        '<span class="block text-[11px] ' + (s.progressStatus === 'help' ? 'text-amber-300' : (s.online ? 'text-slate-500' : 'text-slate-600')) + '">' +
        (s.online ? '● Online' : '○ Offline') + ' • ' + escapeHtml(progressLabel(s.progressStatus)) + '</span></span>' +
        '<span class="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">' + escapeHtml(s.language) + '</span>' +
      '</div>' +
      '<div class="mini-code p-3 h-28 text-slate-300">' + (escapeHtml((s.code || '').slice(0, 220)) || '<span class="text-slate-600">a aguardar código...</span>') + '</div>' +
      '<div class="px-3 py-1.5 text-[11px] text-slate-500 border-t border-slate-800">' +
      escapeHtml(progressLabel(s.progressStatus)) + ' • Entrou ' + escapeHtml(formatAttendance(s.joinedAt)) +
      ' • Última atividade ' + escapeHtml(formatAttendance(s.lastSeenAt)) + ' • ' + (s.code || '').length + ' chars</div>';
    const openFocus = () => {
      focusId = id;
      document.getElementById('boardFocus').classList.remove('hidden');
      render();
      document.getElementById('boardFocus').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    card.onclick = openFocus;
    card.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFocus(); }
    };
    const remove = createRemoveStudentButton(id, s);
    card.querySelector('div').appendChild(remove);
    bg.appendChild(card);
  });
  if (students.size === 0) bg.innerHTML = '<p class="text-sm text-slate-500 col-span-full">Nenhum aluno ainda. Partilha o link com a turma.</p>';
  document.getElementById('boardCount').textContent = students.size + (students.size === 1 ? ' aluno' : ' alunos');
  document.getElementById('boardInvite').textContent = location.origin + '/?room=' + roomInput.value;
  document.getElementById('rosterCount').textContent = students.size;
  document.getElementById('sessCount').textContent = onlineCount + (onlineCount === 1 ? ' aluno conectado' : ' alunos conectados');
  document.getElementById('infoTotal').textContent = students.size;
  // cartão de info (lateral)
  const f = students.get(focusId);
  const av = document.getElementById('infoAvatar');
  av.textContent = f ? (f.name.trim()[0] || 'A').toUpperCase() : (roomInput.value.trim()[0] || 'R').toUpperCase();
  av.style.background = f ? avColor(focusId) : '#7c3aed';
  document.getElementById('infoName').textContent = f ? f.name : roomInput.value;
  const st = document.getElementById('infoStatus');
  st.textContent = f ? (f.online === false ? '○ Offline' : '● Online') : '● Online';
  st.className = 'text-[11px] ' + ((f && f.online === false) ? 'text-slate-500' : 'text-emerald-300');
  // foco do board (vista Alunos)
  document.getElementById('boardFocusName').textContent = f ? f.name : '—';
  document.getElementById('boardFocusMeta').textContent = f ? (f.language + ' • ' + f.code.length + ' chars' + (f.online === false ? ' • OFFLINE' : '')) : '';
  if (!f) document.getElementById('boardFocus').classList.add('hidden');
  if (boardEditor && f) {
    if (boardEditor.getValue() !== f.code) boardEditor.setValue(f.code);
    if (window.monaco) monaco.editor.setModelLanguage(boardEditor.getModel(), f.language || 'python');
  }
}
document.getElementById('search').oninput = render;
document.getElementById('searchBoard').oninput = render;
document.getElementById('boardFocusClose').onclick = () => document.getElementById('boardFocus').classList.add('hidden');
// Mostra o último roster guardado neste PC (inclui offline) até chegar o estado live
try {
  const cached = JSON.parse(localStorage.getItem('ccl-roster:' + roomInput.value) || '[]');
  cached.forEach(([id, s]) => students.set(id, {
    name: s.name, language: s.language, code: s.code || '', online: false,
    updatedAt: s.updatedAt || 0, joinedAt: s.joinedAt || 0, lastSeenAt: s.lastSeenAt || 0,
    progressStatus: s.progressStatus || 'not_started', progressUpdatedAt: s.progressUpdatedAt || 0
  }));
  if (cached.length) { focusId = cached[0][0]; render(); }
} catch (e) {}

// ================= workspace da professora (local, para projetar) =================
let weditor = null;
let wpy = null;
let workspaceFiles = [];
let activeWorkspaceFileId = 'workspace';
function workspaceFilesKey(room) { return 'ccl-teacher-files:' + room; }
function isOldWorkspaceStarter(code) {
  const normalized = code.replace(/\r\n/g, '\n').trim();
  return normalized === '# Workspace da professora — para programar com o projetor.' ||
    normalized === '# Workspace da professora — para programar com o projetor.\n\ndef soma(a, b):\n    return a + b\n\nprint(soma(2, 3))';
}
function defaultWorkspaceCode() {
  return '';
}
function normalizeWorkspaceFiles(files) {
  return files.map(file => ({
    ...file,
    code: isOldWorkspaceStarter(file.code) ? '' : file.code
  }));
}
function loadWorkspaceForRoom(room) {
  try {
    const saved = JSON.parse(localStorage.getItem(workspaceFilesKey(room)) || 'null');
    if (saved && Array.isArray(saved.files)) {
      const files = normalizeWorkspaceFiles(saved.files.filter(file => file && typeof file.id === 'string' && typeof file.name === 'string' && typeof file.code === 'string'));
      if (files.length) {
        const activeFileId = files.some(file => file.id === saved.activeFileId)
          ? saved.activeFileId
          : files[0].id;
        return { files, activeFileId };
      }
    }
    const legacyCode = localStorage.getItem('ccl-teacher:' + room);
    return {
      files: [{ id: 'workspace', name: 'workspace.py', code: legacyCode && !isOldWorkspaceStarter(legacyCode) ? legacyCode : defaultWorkspaceCode() }],
      activeFileId: 'workspace'
    };
  } catch (error) {
    return { files: [{ id: 'workspace', name: 'workspace.py', code: defaultWorkspaceCode() }], activeFileId: 'workspace' };
  }
}
function getActiveWorkspaceFile() {
  return workspaceFiles.find(file => file.id === activeWorkspaceFileId) || workspaceFiles[0];
}
function saveWorkspaceForRoom(room) {
  const activeFile = getActiveWorkspaceFile();
  if (!activeFile) return;
  if (weditor && window._wroom === room) activeFile.code = weditor.getValue();
  try {
    localStorage.setItem(workspaceFilesKey(room), JSON.stringify({ files: workspaceFiles, activeFileId: activeFile.id }));
    const legacyWorkspace = workspaceFiles.find(file => file.id === 'workspace');
    if (legacyWorkspace) localStorage.setItem('ccl-teacher:' + room, legacyWorkspace.code);
  } catch (error) {}
}
function renderWorkspaceFiles() {
  const tabs = document.getElementById('wfileTabs');
  tabs.textContent = '';
  workspaceFiles.forEach(file => {
    const tab = document.createElement('div');
    tab.className = 'flex items-center border rounded-t-lg ' + (file.id === activeWorkspaceFileId ? 'bg-slate-900 border-slate-800 border-b-0' : 'border-transparent');
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'wfile-tab ' + (file.id === activeWorkspaceFileId ? 'active' : '');
    select.setAttribute('aria-pressed', String(file.id === activeWorkspaceFileId));
    select.title = 'Abrir ' + file.name + ' (duplo clique para renomear)';
    const icon = document.createElement('span');
    icon.className = 'text-slate-500';
    icon.textContent = '🐍';
    const name = document.createElement('span');
    name.className = 'wfile-tab-name font-mono';
    name.textContent = file.name;
    select.append(icon, name);
    select.onclick = () => switchWorkspaceFile(file.id);
    select.ondblclick = (event) => {
      event.preventDefault();
      renameWorkspaceFile(file.id);
    };
    tab.appendChild(select);
    if (workspaceFiles.length > 1) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'wfile-close mr-1';
      close.setAttribute('aria-label', 'Fechar ' + file.name);
      close.title = 'Fechar ficheiro';
      close.textContent = '×';
      close.onclick = () => closeWorkspaceFile(file.id);
      tab.appendChild(close);
    }
    tabs.appendChild(tab);
  });
  const active = getActiveWorkspaceFile();
  if (active) {
    document.getElementById('wdlBtn').title = 'Descarregar ' + active.name;
    document.getElementById('wnewBtn').title = 'Criar um ficheiro vazio';
  }
}
function switchWorkspaceFile(fileId) {
  if (!weditor || fileId === activeWorkspaceFileId) return;
  const next = workspaceFiles.find(file => file.id === fileId);
  if (!next) return;
  const current = getActiveWorkspaceFile();
  if (current) current.code = weditor.getValue();
  activeWorkspaceFileId = next.id;
  weditor.setValue(next.code);
  renderWorkspaceFiles();
  saveWorkspaceForRoom(roomInput.value);
  weditor.focus();
}
function createWorkspaceFile() {
  if (!weditor) return;
  let fileNumber = workspaceFiles.length + 1;
  while (workspaceFiles.some(file => file.name.toLowerCase() === 'ficheiro-' + fileNumber + '.py')) fileNumber++;
  const file = {
    id: 'file-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    name: 'ficheiro-' + fileNumber + '.py',
    code: ''
  };
  const current = getActiveWorkspaceFile();
  if (current) current.code = weditor.getValue();
  workspaceFiles.push(file);
  activeWorkspaceFileId = file.id;
  weditor.setValue(file.code);
  renderWorkspaceFiles();
  saveWorkspaceForRoom(roomInput.value);
  weditor.focus();
}
function renameWorkspaceFile(fileId) {
  const file = workspaceFiles.find(entry => entry.id === fileId);
  if (!file) return;
  const input = prompt('Nome do ficheiro:', file.name);
  if (input === null || !input.trim()) return;
  let name = input.trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!/\.py$/i.test(name)) name += '.py';
  if (workspaceFiles.some(entry => entry.id !== fileId && entry.name.toLowerCase() === name.toLowerCase())) {
    alert('Já existe um ficheiro com esse nome.');
    return;
  }
  file.name = name;
  renderWorkspaceFiles();
  saveWorkspaceForRoom(roomInput.value);
}
function downloadWorkspaceFile(file) {
  if (!file) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([file.code || ''], { type: 'text/x-python;charset=utf-8' }));
  a.download = file.name || 'workspace.py';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function closeWorkspaceFile(fileId) {
  if (workspaceFiles.length < 2) return;
  const index = workspaceFiles.findIndex(file => file.id === fileId);
  if (index < 0) return;
  const file = workspaceFiles[index];
  if (fileId === activeWorkspaceFileId && weditor) file.code = weditor.getValue();
  if (confirm('Descarregar uma cópia de "' + file.name + '" antes de o fechar? OK descarrega; Cancelar fecha sem descarregar.')) {
    downloadWorkspaceFile(file);
  }
  workspaceFiles.splice(index, 1);
  if (fileId === activeWorkspaceFileId) {
    const next = workspaceFiles[Math.min(index, workspaceFiles.length - 1)];
    activeWorkspaceFileId = next.id;
    try { weditor.setValue(next.code); } catch (e) {}
  }
  renderWorkspaceFiles();
  saveWorkspaceForRoom(roomInput.value);
}
const wgetPy = () => { if (!wpy) wpy = loadPyodide(); return wpy; };
let terminal = null;
let terminalFitAddon = null;
let pendingConsoleInput = null;
let terminalCommandBuffer = '';
let terminalInputBuffer = '';
let wbusy = false;

function fitTeacherTerminal() {
  try { if (terminal && terminalFitAddon) terminalFitAddon.fit(); } catch (e) {}
}

function setWtime(text) {
  const el = document.getElementById('wtime');
  if (el) el.textContent = text;
}

function initTeacherTerminal() {
  if (terminal) return;
  const container = document.getElementById('terminal-container');
  if (!container || typeof Terminal === 'undefined') return;
  const isProjector = document.body.classList.contains('projector-mode');
  terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    scrollback: 2000,
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: isProjector ? 16 : 13,
    theme: {
      background: '#012456',
      foreground: '#f2f2f2',
      cursor: '#7dd3fc',
      selectionBackground: '#1b4e85'
    }
  });
  try {
    if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
      terminalFitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(terminalFitAddon);
    }
  } catch (e) { terminalFitAddon = null; }
  terminal.open(container);
  window._terminal = terminal;
  window._terminalFitAddon = terminalFitAddon;

  terminal.onData(data => {
    const input = String(data || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
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
        if (character === '\x7f') {
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
      if (wbusy) return;
      if (character === '\r' || character === '\n') {
        terminal.write('\r\n');
        submitTeacherTerminalCommand();
        return;
      }
      if (character === '\x7f') {
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
  termReset();
  fitTeacherTerminal();
  try {
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => fitTeacherTerminal()).observe(container);
    }
  } catch (e) {}
  window.addEventListener('resize', fitTeacherTerminal);
}

function submitTeacherTerminalCommand() {
  const command = terminalCommandBuffer.trim();
  terminalCommandBuffer = '';
  if (!command) {
    terminal.write('PS C:\\classroom> ');
  } else if (/^(clear|cls)$/i.test(command)) {
    termReset();
  } else if (/^help$/i.test(command)) {
    terminal.writeln('Comandos: python <ficheiro.py>, clear, help');
    terminal.write('PS C:\\classroom> ');
  } else if (/^py(thon)?\s+(.+)$/i.test(command)) {
    const match = command.match(/^py(thon)?\s+(.+)$/i);
    const fileName = (match[2] || '').trim().replace(/^["']|["']$/g, '');
    const file = workspaceFiles.find(entry => entry.name === fileName) ||
      workspaceFiles.find(entry => entry.name.toLowerCase() === fileName.toLowerCase());
    if (file) runWorkspaceFile(file);
    else {
      terminal.writeln('\x1b[31mFicheiro não encontrado: ' + fileName + '\x1b[0m');
      terminal.write('PS C:\\classroom> ');
    }
  } else if (/^py(thon)?\s*$/i.test(command) || /^python\s+workspace\.py$/i.test(command)) {
    runWorkspaceFile();
  } else {
    terminal.write('\x1b[31mComando não reconhecido. Usa "python <ficheiro.py>" ou "help".\x1b[0m\r\nPS C:\\classroom> ');
  }
}

function submitPendingConsoleInput(value) {
  if (!pendingConsoleInput) return;
  const pending = pendingConsoleInput;
  pending.answers.push(value);
  pendingConsoleInput = null;
  terminalInputBuffer = '';
  executeTeacherPython(pending.code, pending.answers, true, pending.printedLogCount, (pending.prompt || '') + value, pending.fileName);
}

function showTeacherConsoleInput(prompt) {
  terminalInputBuffer = '';
  if (prompt) terminal.write(prompt);
  try { terminal.focus(); } catch (e) {}
}

function cancelConsoleInput() {
  pendingConsoleInput = null;
  terminalInputBuffer = '';
  wbusy = false;
  setWtime('');
  const runBtn = document.getElementById('wrunBtn');
  if (runBtn) { runBtn.disabled = false; }
}

function termPrint(lines, isErr = false) {
  if (!terminal || lines === undefined || lines === null) return;
  if (Array.isArray(lines)) {
    if (!lines.length) {
      terminal.writeln('(sem output — o programa correu sem print)');
      return;
    }
    const colorStart = isErr ? '\x1b[31m' : '';
    const colorEnd = isErr ? '\x1b[0m' : '';
    terminal.write(lines.map(line => colorStart + String(line) + colorEnd).join('\r\n') + '\r\n');
  } else {
    if (isErr) terminal.writeln('\x1b[31m' + lines + '\x1b[0m');
    else terminal.writeln(lines);
  }
}
function termReset() {
  terminalCommandBuffer = '';
  terminalInputBuffer = '';
  if (terminal) {
    try { terminal.clear(); } catch (e) {}
    terminal.write('PS C:\\classroom> ');
  }
}
const wspaceResize = document.getElementById('wspaceResize');
const wcols = document.getElementById('wcols');
const weditorElement = document.getElementById('weditor');
function isWorkspaceFullscreen() { return document.fullscreenElement === document.getElementById('wspace'); }
function setWorkspaceEditorExtent(value, save) {
  const fullscreen = isWorkspaceFullscreen();
  const styles = getComputedStyle(wcols);
  const gap = parseFloat(styles.rowGap) || 0;
  if (fullscreen) {
    const available = wcols.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
    const maxWidth = Math.max(240, available - wspaceResize.offsetWidth - gap - 220);
    const width = Math.round(Math.max(240, Math.min(maxWidth, value)));
    wcols.style.setProperty('--weditor-width', width + 'px');
    wspaceResize.setAttribute('aria-valuenow', String(width));
    if (save) {
      try { localStorage.setItem('ccl-teacher-editor-width', String(width / Math.max(1, available))); } catch (e) {}
    }
  } else {
    const available = wcols.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
    const maxHeight = Math.max(120, available - wspaceResize.offsetHeight - gap - 144);
    const height = Math.round(Math.max(120, Math.min(maxHeight, value)));
    wcols.style.setProperty('--weditor-height', height + 'px');
    wspaceResize.setAttribute('aria-valuenow', String(height));
    if (save) {
      try { localStorage.setItem('ccl-teacher-editor-height', String(height)); } catch (e) {}
    }
  }
  if (weditor) weditor.layout();
}
try {
  const savedEditorHeight = Number(localStorage.getItem('ccl-teacher-editor-height'));
  if (Number.isFinite(savedEditorHeight) && savedEditorHeight >= 120) setWorkspaceEditorExtent(savedEditorHeight, false);
  const savedEditorWidth = Number(localStorage.getItem('ccl-teacher-editor-width'));
  if (Number.isFinite(savedEditorWidth) && savedEditorWidth > 0 && isWorkspaceFullscreen()) {
    setWorkspaceEditorExtent(wcols.clientWidth * savedEditorWidth, false);
  }
} catch (e) {}
wspaceResize.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  wspaceResize.setPointerCapture(event.pointerId);
  wspaceResize.classList.add('is-resizing');
  const fullscreen = isWorkspaceFullscreen();
  const start = fullscreen ? event.clientX : event.clientY;
  const startExtent = fullscreen ? weditorElement.getBoundingClientRect().width : weditorElement.getBoundingClientRect().height;
  const resize = (moveEvent) => {
    const position = fullscreen ? moveEvent.clientX : moveEvent.clientY;
    setWorkspaceEditorExtent(startExtent + position - start, true);
  };
  const stop = () => {
    wspaceResize.classList.remove('is-resizing');
    wspaceResize.removeEventListener('pointermove', resize);
    wspaceResize.removeEventListener('pointerup', stop);
    wspaceResize.removeEventListener('pointercancel', stop);
  };
  wspaceResize.addEventListener('pointermove', resize);
  wspaceResize.addEventListener('pointerup', stop);
  wspaceResize.addEventListener('pointercancel', stop);
});
wspaceResize.addEventListener('keydown', (event) => {
  const fullscreen = isWorkspaceFullscreen();
  const decrease = fullscreen ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
  const increase = fullscreen ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
  if (!decrease && !increase) return;
  event.preventDefault();
  const current = fullscreen ? weditorElement.getBoundingClientRect().width : weditorElement.getBoundingClientRect().height;
  setWorkspaceEditorExtent(current + (increase ? 16 : -16), true);
});
window.addEventListener('resize', () => {
  if (document.body.classList.contains('projector-mode')) {
    try { if (weditor) weditor.layout(); } catch (e) {}
    fitTeacherTerminal();
    return;
  }
  // Sem altura guardada/ajustada, editor e terminal dividem 50/50 via flex:
  // basta refazer o layout, sem fixar px (senão o 50/50 virava altura fixa).
  const hasCustomHeight = (wcols.style.getPropertyValue('--weditor-height') || '').trim() !== '';
  let hasSavedHeight = false;
  try { hasSavedHeight = Number(localStorage.getItem('ccl-teacher-editor-height')) >= 120; } catch (e) {}
  if (!hasCustomHeight && !hasSavedHeight && !isWorkspaceFullscreen()) {
    try { if (weditor) weditor.layout(); } catch (e) {}
    fitTeacherTerminal();
    return;
  }
  if (isWorkspaceFullscreen()) setWorkspaceEditorExtent(weditorElement.getBoundingClientRect().width, false);
  else setWorkspaceEditorExtent(weditorElement.getBoundingClientRect().height, false);
});
document.getElementById('qClear').onclick = termReset;
function runWorkspace() { document.getElementById('wrunBtn').click(); }
document.getElementById('qRun').onclick = runWorkspace;
document.getElementById('qFull').onclick = () => document.getElementById('wfullBtn').click();
// ---- motor Python da professora (igual ao do aluno): corre no browser, input() no terminal ----
async function runTeacherPython(code, answers) {
  const py = await wgetPy();
  const logs = [];
  py.setStdout({ batched: (s) => logs.push(s) });
  py.setStderr({ batched: (s) => logs.push('[erro] ' + s) });
  const wrapper = [
    'import json as _ccl_json',
    '_ccl_answers = ' + JSON.stringify(answers || []),
    'class _CCLNeedInput(BaseException): pass',
    'def _ccl_input(prompt=""):',
    '    if not _ccl_answers: raise _CCLNeedInput(str(prompt))',
    '    answer = _ccl_answers.pop(0)',
    '    print(str(prompt) + answer)',
    '    return answer',
    "_ccl_namespace = {'__name__': '__main__', 'input': _ccl_input}",
    'try:',
    '    exec(compile(' + JSON.stringify(code) + ', "<teacher>", "exec"), _ccl_namespace, _ccl_namespace)',
    'except _CCLNeedInput as _ccl_error:',
    '    _ccl_result = {"waiting": True, "prompt": str(_ccl_error)}',
    'else:',
    '    _ccl_result = {"waiting": False}',
    '_ccl_json.dumps(_ccl_result)'
  ].join('\n');
  const result = await py.runPythonAsync(wrapper);
  return { ...JSON.parse(result), logs };
}

async function executeTeacherPython(code, answers, commandAlreadyWritten, printedLogCount, echoedInput, fileName) {
  const t0 = performance.now();
  const label = fileName || (getActiveWorkspaceFile() && getActiveWorkspaceFile().name) || 'workspace.py';
  let waitingForInput = false;
  wbusy = true;
  setWtime('a correr…');
  const runBtn = document.getElementById('wrunBtn');
  if (runBtn) runBtn.disabled = true;
  try {
    if (!terminal) return;
    if (!commandAlreadyWritten && !(answers && answers.length)) terminal.write('$ python ' + label + '\r\n');
    const result = await runTeacherPython(code, answers || []);
    const newLogs = result.logs.slice(printedLogCount || 0);
    if (echoedInput) {
      const echoedLogIndex = newLogs.findIndex(line => String(line).replace(/\r?\n$/, '') === echoedInput);
      if (echoedLogIndex >= 0) newLogs.splice(echoedLogIndex, 1);
    }
    if (result.waiting) {
      pendingConsoleInput = { code, answers: answers || [], printedLogCount: result.logs.length, prompt: result.prompt, fileName: label };
      if (newLogs.length) termPrint(newLogs, false);
      showTeacherConsoleInput(result.prompt);
      setWtime('a pedir input…');
      waitingForInput = true;
      return;
    }
    pendingConsoleInput = null;
    if (newLogs.length) termPrint(newLogs, false);
    else if (!result.logs.length && !(printedLogCount || 0)) termPrint([]);
    terminal.write('PS C:\\classroom> ');
    setWtime(Math.round(performance.now() - t0) + 'ms');
    try { saveWorkspaceForRoom(roomInput.value); } catch (e) {}
  } catch (err) {
    pendingConsoleInput = null;
    termPrint(['⛔ ' + String((err && err.message) || err)], true);
    if (terminal) terminal.write('PS C:\\classroom> ');
    setWtime('');
  } finally {
    wbusy = false;
    if (!waitingForInput && runBtn) runBtn.disabled = false;
  }
}

function runWorkspaceFile(fileOverride) {
  if (!weditor || wbusy || pendingConsoleInput) {
    if (pendingConsoleInput) termPrint('[termina a resposta ao input() primeiro — Ctrl+C cancela]');
    return;
  }
  const activeFile = fileOverride || getActiveWorkspaceFile();
  if (!activeFile) return;
  activeFile.code = weditor.getValue();
  try { saveWorkspaceForRoom(roomInput.value); } catch (e) {}
  executeTeacherPython(activeFile.code, [], false, 0, '', activeFile.name);
  try { if (terminal) terminal.focus(); } catch (e) {}
}

document.getElementById('wrunBtn').onclick = () => runWorkspaceFile();
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pendingConsoleInput) {
    termPrint('[cancelado]');
    cancelConsoleInput();
    if (terminal) terminal.write('PS C:\\classroom> ');
  }
});
document.getElementById('wnewBtn').onclick = createWorkspaceFile;
document.getElementById('wdlBtn').onclick = () => {
  if (!weditor) return;
  const activeFile = getActiveWorkspaceFile();
  if (!activeFile) return;
  activeFile.code = weditor.getValue();
  saveWorkspaceForRoom(roomInput.value);
  downloadWorkspaceFile(activeFile);
};
document.getElementById('wcopyBtn').onclick = async () => {
  if (!weditor) return;
  try { await navigator.clipboard.writeText(weditor.getValue()); termPrint('[código copiado]'); } catch (e) { termPrint('[falha a copiar]'); }
};
// Ecrã inteiro no workspace (para projetar): fonte maior, Esc sai
document.getElementById('wfullBtn').onclick = async () => {
  const el = document.getElementById('wspace');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el.requestFullscreen();
  } catch (e) {}
};
document.addEventListener('fullscreenchange', () => {
  const workspaceFullscreen = isWorkspaceFullscreen();
  wspaceResize.setAttribute('aria-orientation', workspaceFullscreen ? 'vertical' : 'horizontal');
  wspaceResize.setAttribute('aria-label', workspaceFullscreen ? 'Redimensionar editor e painel de tarefas lado a lado' : 'Redimensionar editor e painel de tarefas');
  if (workspaceFullscreen) {
    try {
      const savedWidth = Number(localStorage.getItem('ccl-teacher-editor-width'));
      if (Number.isFinite(savedWidth) && savedWidth > 0) setWorkspaceEditorExtent(wcols.clientWidth * savedWidth, false);
      else setWorkspaceEditorExtent(wcols.clientWidth * 0.6, false);
    } catch (e) { setWorkspaceEditorExtent(wcols.clientWidth * 0.6, false); }
  } else if (!document.body.classList.contains('projector-mode')) {
    const hasCustomHeight = (wcols.style.getPropertyValue('--weditor-height') || '').trim() !== '';
    let hasSavedHeight = false;
    try { hasSavedHeight = Number(localStorage.getItem('ccl-teacher-editor-height')) >= 120; } catch (e) {}
    if (hasCustomHeight || hasSavedHeight) {
      try { setWorkspaceEditorExtent(weditorElement.getBoundingClientRect().height, false); } catch (e) {}
    } else {
      try { if (weditor) weditor.layout(); } catch (e) {}
      try { fitTeacherTerminal(); } catch (e) {}
    }
  }
  const isProjector = document.body.classList.contains('projector-mode');
  if (weditor && window.monaco) {
    weditor.updateOptions({ fontSize: isProjector ? 20 : (workspaceFullscreen ? 17 : 13) });
    try { weditor.layout(); } catch (e) {}
  }
  if (terminal && terminalFitAddon) {
    try { terminal.options.fontSize = isProjector ? 16 : 13; } catch (e) {}
    setTimeout(fitTeacherTerminal, 80);
  }
});
// Terminal funciona mesmo que o Monaco falhe: inicializa já.
try { initTeacherTerminal(); } catch (e) {}

require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
require(['vs/editor/editor.main'], function () {
  boardEditor = monaco.editor.create(document.getElementById('boardEditor'), {
    value: '// Seleciona um aluno no board para ver o código em direto...',
    language: 'python', theme: document.body.classList.contains('light') ? 'vs' : 'vs-dark', readOnly: true,
    automaticLayout: true, fontSize: 13, minimap: { enabled: false }
  });
  const initialWorkspace = loadWorkspaceForRoom(roomInput.value);
  workspaceFiles = initialWorkspace.files;
  activeWorkspaceFileId = initialWorkspace.activeFileId;
  const projectorFont = document.body.classList.contains('projector-mode') ? 20 : 13;
  weditor = monaco.editor.create(document.getElementById('weditor'), {
    value: getActiveWorkspaceFile().code,
    language: 'python', theme: document.body.classList.contains('light') ? 'vs' : 'vs-dark',
    automaticLayout: true, fontSize: projectorFont, minimap: { enabled: true }
  });
  renderWorkspaceFiles();
  window._wroom = roomInput.value;
  saveWorkspaceForRoom(roomInput.value);
  let wt;
  weditor.onDidChangeModelContent(() => {
    clearTimeout(wt);
    wt = setTimeout(() => {
      const activeFile = getActiveWorkspaceFile();
      if (activeFile) activeFile.code = weditor.getValue();
      saveWorkspaceForRoom(roomInput.value);
    }, 800);
  });
  weditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runWorkspace);
  initTeacherTerminal();
  render();
});
// Sem servidor: inicializa a UI na mesma para programar/projetar offline
if (!socket) {
  try {
    document.getElementById('roomSub').textContent = 'Servidor desligado — workspace local funciona na mesma.';
    joinUI();
  } catch (e) {}
}
// Repõe a última vista (por defeito: Início = dashboard completo)
try {
  const _t = localStorage.getItem('ccl-teacher-tab');
  setTab(_t === 'terminal' ? 'tarefas' : (_t && ['inicio', 'alunos', 'projetor', 'tarefas'].includes(_t) ? _t : 'inicio'));
} catch (e) { try { setTab('inicio'); } catch (e2) {} }
