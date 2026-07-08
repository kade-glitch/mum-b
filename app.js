// Mum-B — slice 1: calendar, tasks, roster
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://jebuvipxgypgdwtsjduk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_az8z_7yQd-pl6nbppyk6zw_WmtVwLff';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SLOTS = ['morning', 'afternoon', 'evening', 'overnight'];
const SLOT_LABELS = { morning: 'Morning', afternoon: 'Arvo', evening: 'Evening', overnight: 'Overnight' };

// ---------- state ----------
const S = {
  session: null,
  me: null,          // family_members row for logged-in user
  members: [],
  events: [],
  shifts: [],
  tasks: [],
  tab: 'today',
  rosterWeekStart: startOfWeek(new Date()),
  editingEventId: null,
  editingShift: null, // {date, slot}
  showDoneTasks: false,
};

const $ = (sel) => document.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- date helpers ----------
function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; } // Monday
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dayKey(d) { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }
function todayKey() { return dayKey(new Date()); }
function fmtDay(d) { return new Date(d).toLocaleDateString('en-AU', { weekday: 'long' }); }
function fmtDate(d) { return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(' ', ''); }
function isToday(d) { return dayKey(d) === todayKey(); }
function relDay(d) {
  const k = dayKey(d);
  if (k === todayKey()) return 'Today';
  if (k === dayKey(addDays(new Date(), 1))) return 'Tomorrow';
  return fmtDay(d);
}

// ---------- auth ----------
function surfaceAuthError() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('error')) {
    $('#login-msg').textContent = h.get('error_code') === 'otp_expired'
      ? 'That link had already expired or been used. Request a fresh one and tap the newest email.'
      : `Sign-in problem: ${h.get('error_description') || h.get('error')}`;
    history.replaceState(null, '', location.pathname);
  }
}

async function init() {
  surfaceAuthError();
  const { data: { session } } = await supabase.auth.getSession();
  S.session = session;
  supabase.auth.onAuthStateChange((_e, sess) => {
    const had = !!S.session;
    S.session = sess;
    if (!!sess !== had) boot();
  });
  boot();
}

async function boot() {
  if (!S.session) { show('login'); return; }
  const email = S.session.user.email;
  const { data, error } = await supabase.from('family_members').select('*').ilike('email', email).maybeSingle();
  if (error || !data) { show('noaccess'); return; }
  S.me = data;
  show('main');
  await loadAll();
  subscribeRealtime();
  render();
}

function show(which) {
  $('#screen-login').classList.toggle('hidden', which !== 'login');
  $('#screen-noaccess').classList.toggle('hidden', which !== 'noaccess');
  $('#screen-main').classList.toggle('hidden', which !== 'main');
}

let pendingEmail = null;

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  $('#login-msg').textContent = 'Sending…';
  const appUrl = location.origin + location.pathname.replace(/index\.html$/, '');
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: appUrl } });
  if (error) { $('#login-msg').textContent = `Hmm: ${error.message}`; return; }
  pendingEmail = email;
  $('#otp-form').classList.remove('hidden');
  $('#login-msg').textContent = 'Check your email and tap the newest link. If the email shows a 6-digit code, you can type it here instead.';
});

$('#otp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#otp-code').value.trim();
  $('#login-msg').textContent = 'Checking…';
  const { error } = await supabase.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });
  if (error) $('#login-msg').textContent = `Hmm: ${error.message}. Codes expire after a while — resend if needed.`;
});

$('#noaccess-signout').addEventListener('click', () => supabase.auth.signOut());

// ---------- data ----------
async function loadAll() {
  const from = addDays(new Date(), -7).toISOString();
  const to = addDays(new Date(), 90).toISOString();
  const weekFrom = dayKey(addDays(S.rosterWeekStart, -7));
  const weekTo = dayKey(addDays(S.rosterWeekStart, 21));
  const [members, events, shifts, tasks] = await Promise.all([
    supabase.from('family_members').select('*').order('display_name'),
    supabase.from('events').select('*').gte('starts_at', from).lte('starts_at', to).order('starts_at'),
    supabase.from('shifts').select('*').gte('shift_date', weekFrom).lte('shift_date', weekTo),
    supabase.from('tasks').select('*').order('done').order('due_date', { nullsFirst: false }).order('created_at'),
  ]);
  S.members = members.data ?? [];
  S.events = events.data ?? [];
  S.shifts = shifts.data ?? [];
  S.tasks = tasks.data ?? [];
}

let channel = null;
function subscribeRealtime() {
  if (channel) return;
  channel = supabase
    .channel('mum-b')
    .on('postgres_changes', { event: '*', schema: 'public' }, async () => { await loadAll(); render(); })
    .subscribe();
}

const memberById = (id) => S.members.find((m) => m.id === id);
const memberName = (id) => memberById(id)?.display_name ?? '';
const memberColor = (id) => memberById(id)?.color ?? '#9a93a8';

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => {
    S.tab = b.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    render();
  })
);

$('#btn-add').addEventListener('click', () => {
  if (S.tab === 'tasks') openTaskDialog();
  else if (S.tab === 'family') openMemberDialog();
  else openEventDialog();
});

// ---------- render ----------
function render() {
  const titles = { today: 'Today', calendar: "Mum's calendar", roster: 'Roster', tasks: 'Tasks', family: 'Family' };
  $('#topbar-title').textContent = titles[S.tab];
  $('#btn-add').classList.toggle('hidden', S.tab === 'roster');
  const v = $('#view');
  v.innerHTML = '';
  ({ today: renderToday, calendar: renderCalendar, roster: renderRoster, tasks: renderTasks, family: renderFamily })[S.tab](v);
}

// ----- Today -----
function renderToday(v) {
  const tk = todayKey();
  const todaysEvents = S.events.filter((e) => dayKey(e.starts_at) === tk);
  const todaysShifts = S.shifts.filter((s) => s.shift_date === tk);
  const openTasks = S.tasks.filter((t) => !t.done);
  const dueToday = openTasks.filter((t) => t.due_date && t.due_date <= tk);

  v.appendChild(el(`<div class="section-title">Who's with Mum today</div>`));
  const card1 = el(`<div class="card"></div>`);
  const filled = todaysShifts.filter((s) => s.carer_id);
  const gaps = todaysShifts.filter((s) => !s.carer_id);
  if (!todaysShifts.length) card1.appendChild(el(`<div class="empty">Nothing rostered. Tap Roster to sort it.</div>`));
  filled.forEach((s) => card1.appendChild(el(
    `<div class="event-item" style="cursor:default">
      <div class="event-time">${SLOT_LABELS[s.slot]}</div>
      <div class="event-main"><div class="event-title"><span class="cat-dot" style="background:${memberColor(s.carer_id)}"></span>${esc(memberName(s.carer_id))}</div>
      ${s.note ? `<div class="event-sub">${esc(s.note)}</div>` : ''}</div>
    </div>`)));
  gaps.forEach((s) => card1.appendChild(el(
    `<div class="event-item" style="cursor:default"><div class="event-time">${SLOT_LABELS[s.slot]}</div>
     <div class="event-main"><div class="event-title" style="color:var(--danger)">Needs cover</div></div></div>`)));
  v.appendChild(card1);

  v.appendChild(el(`<div class="section-title">On today</div>`));
  const card2 = el(`<div class="card"></div>`);
  if (!todaysEvents.length) card2.appendChild(el(`<div class="empty">No appointments today.</div>`));
  todaysEvents.forEach((e) => card2.appendChild(eventRow(e)));
  v.appendChild(card2);

  if (dueToday.length) {
    v.appendChild(el(`<div class="section-title">Tasks due</div>`));
    const card3 = el(`<div class="card"></div>`);
    dueToday.forEach((t) => card3.appendChild(taskRow(t)));
    v.appendChild(card3);
  }
}

// ----- Calendar -----
function renderCalendar(v) {
  const upcoming = S.events.filter((e) => dayKey(e.starts_at) >= todayKey());
  if (!upcoming.length) { v.appendChild(el(`<div class="empty">Nothing coming up. Tap ＋ to add Mum's first appointment.</div>`)); return; }
  const byDay = {};
  upcoming.forEach((e) => { (byDay[dayKey(e.starts_at)] ??= []).push(e); });
  Object.keys(byDay).sort().forEach((k) => {
    const d = new Date(k + 'T00:00');
    v.appendChild(el(`<div class="day-head">${relDay(d)}<span class="sub">${fmtDate(d)}</span></div>`));
    const card = el(`<div class="card"></div>`);
    byDay[k].forEach((e) => card.appendChild(eventRow(e)));
    v.appendChild(card);
  });
}

function eventRow(e) {
  const row = el(
    `<div class="event-item">
      <div class="event-time">${fmtTime(e.starts_at)}${e.ends_at ? `<span class="end">– ${fmtTime(e.ends_at)}</span>` : ''}</div>
      <div class="event-main">
        <div class="event-title"><span class="cat-dot cat-${e.category}"></span>${esc(e.title)}</div>
        ${e.location || e.description ? `<div class="event-sub">${esc([e.location, e.description].filter(Boolean).join(' · '))}</div>` : ''}
      </div>
    </div>`);
  row.addEventListener('click', () => openEventDialog(e));
  return row;
}

// ----- Roster -----
function renderRoster(v) {
  const ws = S.rosterWeekStart;
  const nav = el(
    `<div class="week-nav">
      <button id="wk-prev">‹</button>
      <strong>${fmtDate(ws)} – ${fmtDate(addDays(ws, 6))}</strong>
      <button id="wk-next">›</button>
    </div>`);
  v.appendChild(nav);
  nav.querySelector('#wk-prev').addEventListener('click', async () => { S.rosterWeekStart = addDays(ws, -7); await loadAll(); render(); });
  nav.querySelector('#wk-next').addEventListener('click', async () => { S.rosterWeekStart = addDays(ws, 7); await loadAll(); render(); });

  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const k = dayKey(d);
    const day = el(`<div class="roster-day card ${isToday(d) ? 'today' : ''}">
      <strong>${relDay(d)}</strong> <span class="muted small">${fmtDate(d)}</span>
      <div class="slot-row"></div></div>`);
    const rowEl = day.querySelector('.slot-row');
    SLOTS.forEach((slot) => {
      const s = S.shifts.find((x) => x.shift_date === k && x.slot === slot);
      let cls = 'slot', body = '<span>—</span>';
      if (s && s.carer_id) {
        cls += ' filled';
        body = `<span style="color:${memberColor(s.carer_id)}">● ${esc(memberName(s.carer_id))}</span>`;
      } else if (s) {
        cls += ' gap';
        body = '<span>Needs cover</span>';
      }
      const btn = el(`<button class="${cls}"><span class="slot-label">${SLOT_LABELS[slot]}</span>${body}</button>`);
      btn.addEventListener('click', () => openShiftDialog(k, slot, s));
      rowEl.appendChild(btn);
    });
    v.appendChild(day);
  }
  v.appendChild(el(`<p class="muted small">Tap a slot to say who's with Mum, or mark it "needs cover" so it shows red for everyone.</p>`));
}

// ----- Tasks -----
function renderTasks(v) {
  const open = S.tasks.filter((t) => !t.done);
  const done = S.tasks.filter((t) => t.done).slice(0, 20);

  v.appendChild(el(`<div class="section-title">To do</div>`));
  const card = el(`<div class="card"></div>`);
  if (!open.length) card.appendChild(el(`<div class="empty">All clear. Nice.</div>`));
  open.forEach((t) => card.appendChild(taskRow(t)));
  v.appendChild(card);

  if (done.length) {
    const toggle = el(`<button class="btn full">${S.showDoneTasks ? 'Hide' : 'Show'} recently done (${done.length})</button>`);
    toggle.addEventListener('click', () => { S.showDoneTasks = !S.showDoneTasks; render(); });
    v.appendChild(toggle);
    if (S.showDoneTasks) {
      const dc = el(`<div class="card" style="margin-top:12px"></div>`);
      done.forEach((t) => dc.appendChild(taskRow(t)));
      v.appendChild(dc);
    }
  }
}

function taskRow(t) {
  const overdue = !t.done && t.due_date && t.due_date < todayKey();
  const bits = [];
  if (t.due_date) bits.push(`<span class="${overdue ? 'overdue' : ''}">${overdue ? 'Overdue · ' : 'Due '}${fmtDate(t.due_date + 'T00:00')}</span>`);
  if (t.details) bits.push(esc(t.details));
  if (t.done && t.done_by) bits.push(`Done by ${esc(memberName(t.done_by))}`);
  const row = el(
    `<div class="task-item ${t.done ? 'done' : ''}">
      <button class="task-check">${t.done ? '✓' : ''}</button>
      <div>
        <div class="task-title">${esc(t.title)}${t.assigned_to ? `<span class="pill" style="background:${memberColor(t.assigned_to)}">${esc(memberName(t.assigned_to))}</span>` : ''}</div>
        ${bits.length ? `<div class="task-sub">${bits.join(' · ')}</div>` : ''}
      </div>
    </div>`);
  row.querySelector('.task-check').addEventListener('click', async () => {
    const done = !t.done;
    await supabase.from('tasks').update({ done, done_by: done ? S.me.id : null, done_at: done ? new Date().toISOString() : null }).eq('id', t.id);
    await loadAll(); render();
  });
  return row;
}

// ----- Family -----
function renderFamily(v) {
  v.appendChild(el(`<div class="section-title">The team</div>`));
  const card = el(`<div class="card"></div>`);
  S.members.forEach((m) => {
    card.appendChild(el(
      `<div class="member-row">
        <div class="avatar" style="background:${m.color}">${esc(m.display_name.slice(0, 1).toUpperCase())}</div>
        <div><div class="member-name">${esc(m.display_name)}${m.id === S.me.id ? ' (you)' : ''}</div>
        <div class="member-email">${esc(m.email)}</div></div>
      </div>`));
  });
  v.appendChild(card);
  v.appendChild(el(`<p class="muted small">Anyone listed here can log in with a magic link to their email. Tap ＋ to add a sibling.</p>`));
  const out = el(`<button class="btn full">Sign out</button>`);
  out.addEventListener('click', () => supabase.auth.signOut());
  v.appendChild(out);
}

// ---------- dialogs ----------
function wireDialog(dlg) {
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
}
['#dlg-event', '#dlg-task', '#dlg-shift', '#dlg-member'].forEach((s) => wireDialog($(s)));

function openEventDialog(e = null) {
  S.editingEventId = e?.id ?? null;
  $('#dlg-event-title').textContent = e ? 'Edit' : "Add to Mum's calendar";
  $('#ev-title').value = e?.title ?? '';
  $('#ev-category').value = e?.category ?? 'other';
  $('#ev-date').value = e ? dayKey(e.starts_at) : todayKey();
  $('#ev-start').value = e ? new Date(e.starts_at).toTimeString().slice(0, 5) : '10:00';
  $('#ev-end').value = e?.ends_at ? new Date(e.ends_at).toTimeString().slice(0, 5) : '';
  $('#ev-location').value = e?.location ?? '';
  $('#ev-notes').value = e?.description ?? '';
  $('#ev-delete').classList.toggle('hidden', !e);
  $('#dlg-event').showModal();
}

$('#form-event').addEventListener('submit', async () => {
  const date = $('#ev-date').value;
  const starts = new Date(`${date}T${$('#ev-start').value}`);
  const endV = $('#ev-end').value;
  const row = {
    title: $('#ev-title').value.trim(),
    category: $('#ev-category').value,
    starts_at: starts.toISOString(),
    ends_at: endV ? new Date(`${date}T${endV}`).toISOString() : null,
    location: $('#ev-location').value.trim() || null,
    description: $('#ev-notes').value.trim() || null,
  };
  if (S.editingEventId) await supabase.from('events').update({ ...row, updated_at: new Date().toISOString() }).eq('id', S.editingEventId);
  else await supabase.from('events').insert({ ...row, created_by: S.me.id });
  await loadAll(); render();
});

$('#ev-delete').addEventListener('click', async () => {
  if (!confirm('Delete this from the calendar?')) return;
  await supabase.from('events').delete().eq('id', S.editingEventId);
  $('#dlg-event').close();
  await loadAll(); render();
});

function openTaskDialog() {
  const sel = $('#tk-assignee');
  sel.innerHTML = '<option value="">Anyone</option>' + S.members.map((m) => `<option value="${m.id}">${esc(m.display_name)}</option>`).join('');
  $('#tk-title').value = ''; $('#tk-due').value = ''; $('#tk-details').value = '';
  $('#dlg-task').showModal();
}

$('#form-task').addEventListener('submit', async () => {
  await supabase.from('tasks').insert({
    title: $('#tk-title').value.trim(),
    assigned_to: $('#tk-assignee').value || null,
    due_date: $('#tk-due').value || null,
    details: $('#tk-details').value.trim() || null,
    created_by: S.me.id,
  });
  await loadAll(); render();
});

function openShiftDialog(date, slot, existing) {
  S.editingShift = { date, slot, existing };
  $('#dlg-shift-title').textContent = `${relDay(new Date(date + 'T00:00'))} ${SLOT_LABELS[slot].toLowerCase()} — who's with Mum?`;
  $('#sh-note').value = existing?.note ?? '';
  const wrap = $('#shift-people');
  wrap.innerHTML = '';
  S.members.forEach((m) => {
    const chip = el(`<button type="button" class="person-chip" style="border-color:${m.color}">${esc(m.display_name)}</button>`);
    chip.addEventListener('click', () => saveShift(m.id));
    wrap.appendChild(chip);
  });
  const gap = el(`<button type="button" class="person-chip needscover">Needs cover</button>`);
  gap.addEventListener('click', () => saveShift(null));
  wrap.appendChild(gap);
  $('#sh-clear').classList.toggle('hidden', !existing);
  $('#dlg-shift').showModal();
}

async function saveShift(carerId) {
  const { date, slot, existing } = S.editingShift;
  const note = $('#sh-note').value.trim() || null;
  if (existing) await supabase.from('shifts').update({ carer_id: carerId, note }).eq('id', existing.id);
  else await supabase.from('shifts').insert({ shift_date: date, slot, carer_id: carerId, note });
  $('#dlg-shift').close();
  await loadAll(); render();
}

$('#sh-clear').addEventListener('click', async () => {
  await supabase.from('shifts').delete().eq('id', S.editingShift.existing.id);
  $('#dlg-shift').close();
  await loadAll(); render();
});

function openMemberDialog() {
  $('#mb-name').value = ''; $('#mb-email').value = '';
  $('#dlg-member').showModal();
}

$('#form-member').addEventListener('submit', async () => {
  const { error } = await supabase.from('family_members').insert({
    display_name: $('#mb-name').value.trim(),
    email: $('#mb-email').value.trim().toLowerCase(),
    color: $('#mb-color').value,
  });
  if (error) alert(`Couldn't add: ${error.message}`);
  await loadAll(); render();
});

// ---------- service worker ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

init();
