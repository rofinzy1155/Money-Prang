const API_URL = '';
const API_TOKEN = '';
const FIRESTORE_COLLECTION = 'records';

function callSheetApi(params) {
  const db = window.moneyPrangDb;
  if (!db) return Promise.reject(new Error('Firebase ยังไม่พร้อมใช้งาน'));
  const ready = window.firebaseReady || Promise.resolve();
  const collection = db.collection(FIRESTORE_COLLECTION);
  return ready.then(() => {
  if (params.action === 'read' || !params.action) {
    return collection.get().then(snapshot => ({ ok: true, records: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) }));
  }
  if (params.action === 'delete') {
    return collection.doc(String(params.id)).delete().then(() => ({ ok: true, deleted: true }));
  }
  if (params.action === 'create' || params.action === 'update') {
    const id = String(params.id || newRecordId());
    const data = {
      id,
      pickupPoint: String(params.pickupPoint || ''),
      date: String(params.date || ''),
      time: String(params.time || ''),
      moneyPerRound: Number(params.moneyPerRound || 0),
      rounds: Number(params.rounds || 1),
      createdAt: String(params.createdAt || new Date().toISOString())
    };
    return collection.doc(id).set(data, { merge: true }).then(() => ({ ok: true, id }));
  }
  return Promise.reject(new Error('ไม่รู้จักคำสั่ง Firebase'));
  });
}

function newRecordId() {
  return window.crypto?.randomUUID?.() || `mp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function recordSignature(record) {
  return [record.pickupPoint, record.date, record.time, Number(record.moneyPerRound || 0), Number(record.rounds || 1)].join('|');
}

async function saveRecordToSheet(record, action = 'create') {
  return callSheetApi({
    action,
    id: record.id || '',
    pickupPoint: record.pickupPoint || '',
    date: record.date || '',
    time: record.time || '',
    moneyPerRound: String(record.moneyPerRound || 0),
    rounds: String(record.rounds || 1),
    createdAt: record.createdAt || ''
  });
}

async function loadRecordsFromSheet() {
  const result = await callSheetApi({ action: 'read' });
  const cloudRecords = result.records || [];
  const localRecords = JSON.parse(localStorage.getItem('records')) || [];
  const cloudIds = new Set(cloudRecords.map(record => String(record.id || '')).filter(Boolean));
  const cloudSignatures = new Map();
  cloudRecords.forEach(record => {
    const key = recordSignature(record);
    cloudSignatures.set(key, (cloudSignatures.get(key) || 0) + 1);
  });
  const localOnly = [];
  localRecords.forEach(record => {
    if (record.id && cloudIds.has(String(record.id))) return;
    const key = recordSignature(record);
    const matches = cloudSignatures.get(key) || 0;
    if (matches) {
      cloudSignatures.set(key, matches - 1);
      return;
    }
    if (!record.id) record.id = newRecordId();
    localOnly.push(record);
  });
  for (const record of localOnly) await saveRecordToSheet(record, 'create');
  const mergedRecords = cloudRecords.concat(localOnly);
  localStorage.setItem('records', JSON.stringify(mergedRecords));
  renderRecords();
  renderSummary();
  return mergedRecords;
}

// ตั้งค่าเริ่มต้นวันและเวลาให้เป็นค่าปัจจุบัน
const now = new Date();
const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
const timeStr = now.toTimeString().slice(0, 5);
document.getElementById('date').value = dateStr;
document.getElementById('time').value = timeStr;

// จัดการปุ่มเลือกจำนวนเงินต่อรอบ
document.querySelectorAll('.quick-select button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById('money-per-round').value = btn.dataset.value;
    document.querySelectorAll('.quick-select button').forEach((item) => item.classList.toggle('selected', item === btn));
  });
});

// จัดการจุดรับสินค้า: เลือกจากรายการที่บันทึกไว้ / เพิ่มจุดรับใหม่
const pickupPoints = JSON.parse(localStorage.getItem('pickupPoints')) || [];
const pickupPointInput = document.getElementById('pickup-point');
const pickupPointList = document.getElementById('pickup-points');
const pickupChips = document.getElementById('pickup-chips');

function getUsageCounts() {
  const records = JSON.parse(localStorage.getItem('records')) || [];
  const counts = {};
  records.forEach((r) => {
    if (r.pickupPoint) counts[r.pickupPoint] = (counts[r.pickupPoint] || 0) + 1;
  });
  return counts;
}

function refreshPickupPoints() {
  const counts = getUsageCounts();
  const sorted = [...pickupPoints].sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
  pickupPointList.innerHTML = '';
  pickupChips.innerHTML = '';
  sorted.forEach((p) => {
    const option = document.createElement('option');
    option.value = p;
    pickupPointList.appendChild(option);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pickup-chip';
    chip.textContent = p;
    chip.addEventListener('click', () => {
      pickupPointInput.value = p;
      pickupChips.querySelectorAll('.pickup-chip').forEach((item) => item.classList.toggle('selected', item === chip));
    });
    pickupChips.appendChild(chip);
  });
}

refreshPickupPoints();

document.getElementById('add-point-btn').addEventListener('click', () => {
  const value = pickupPointInput.value.trim();
  if (!value) return;
  if (!pickupPoints.includes(value)) {
    pickupPoints.push(value);
    localStorage.setItem('pickupPoints', JSON.stringify(pickupPoints));
  }
  refreshPickupPoints();
});

let editingIndex = null;
let summaryRangeMode = 'custom';
let dailyIncomeChart = null;
let pickupIncomeChart = null;

// บันทึกข้อมูลรอบส่งสินค้าและแสดงรายการที่เพิ่งบันทึก
document.getElementById('record-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const record = {
    id: '',
    pickupPoint: pickupPointInput.value.trim(),
    date: document.getElementById('date').value,
    time: document.getElementById('time').value,
    moneyPerRound: document.getElementById('money-per-round').value,
    rounds: 1,
  };

  if (record.pickupPoint && !pickupPoints.includes(record.pickupPoint)) {
    pickupPoints.push(record.pickupPoint);
    localStorage.setItem('pickupPoints', JSON.stringify(pickupPoints));
  }
  refreshPickupPoints();

  const records = JSON.parse(localStorage.getItem('records')) || [];
  const isEditing = editingIndex !== null && Boolean(records[editingIndex]);
  if (isEditing) {
    record.id = records[editingIndex].id || newRecordId();
    record.createdAt = records[editingIndex].createdAt || new Date().toISOString();
    records[editingIndex] = record;
  } else {
    record.id = newRecordId();
    record.createdAt = new Date().toISOString();
    records.push(record);
  }
  localStorage.setItem('records', JSON.stringify(records));
  const toast = document.getElementById('save-toast');
  toast.textContent = 'บันทึกในเครื่องแล้ว กำลังซิงก์ฐานข้อมูล…';
  toast.classList.remove('save-toast-error');
  saveRecordToSheet(record, isEditing ? 'update' : 'create').catch((error) => {
    console.error('ส่งข้อมูลไป Firebase ไม่สำเร็จ:', error);
    toast.textContent = 'บันทึกในเครื่องแล้ว แต่ส่งไปฐานข้อมูลไม่สำเร็จ';
    toast.classList.add('save-toast-error');
    toast.hidden = false;
  }).then((result) => {
    if (result) toast.textContent = 'บันทึกและซิงก์ฐานข้อมูลแล้ว ✓';
  });
  editingIndex = null;
  renderSummary();

  const last = records[records.length - 1];
  document.getElementById('last-record').innerHTML = `
    <h3>รายการล่าสุด</h3>
    <p>จุดรับสินค้า: ${last.pickupPoint}</p>
    <p>วันที่: ${last.date} เวลา: ${last.time}</p>
    <p>เงินต่อรอบ: ${last.moneyPerRound} จำนวนรอบ: ${last.rounds}</p>
  `;
  toast.hidden = false;
  window.clearTimeout(window.saveToastTimer);
  window.saveToastTimer = window.setTimeout(() => { toast.hidden = true; }, 13000);
});

function renderRecords() {
  const records = JSON.parse(localStorage.getItem('records')) || [];
  const tbody = document.getElementById('records-tbody');
  tbody.innerHTML = '';
  records.forEach((r, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${r.date}</td>
      <td>${r.time}</td>
      <td>${r.pickupPoint}</td>
      <td>฿${Number(r.moneyPerRound || 0).toFixed(2)}</td>
      <td>฿${Number(r.moneyPerRound * Number(r.rounds || 1) || 0).toFixed(2)}</td>
      <td>
        <button type="button" class="edit-btn" data-id="${idx}">แก้ไข</button>
        <button type="button" class="delete-btn" data-id="${idx}">ลบ</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('records-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const idx = Number(btn.dataset.id);
  const records = JSON.parse(localStorage.getItem('records')) || [];
  if (btn.classList.contains('delete-btn')) {
    const [deletedRecord] = records.splice(idx, 1);
    localStorage.setItem('records', JSON.stringify(records));
    renderRecords();
    renderSummary();
    callSheetApi({
      action: 'delete',
      id: deletedRecord.id || '',
      pickupPoint: deletedRecord.pickupPoint || '',
      date: deletedRecord.date || '',
      time: deletedRecord.time || '',
      moneyPerRound: String(deletedRecord.moneyPerRound || 0),
      rounds: String(deletedRecord.rounds || 1)
    }).catch((error) => console.error('ลบข้อมูลจาก Firebase ไม่สำเร็จ:', error));
  } else if (btn.classList.contains('edit-btn')) {
    const r = records[idx];
    document.getElementById('pickup-point').value = r.pickupPoint || '';
    document.getElementById('date').value = r.date || '';
    document.getElementById('time').value = r.time || '';
    document.getElementById('money-per-round').value = r.moneyPerRound || '';
    editingIndex = idx;
  }
});

renderRecords();

// ===== Task สรุปยอด =====
function formatMoney(value) {
  return '฿' + Number(value || 0).toFixed(2);
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dayNum = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dayNum}`;
}

function computeDaily(records) {
  const map = {};
  records.forEach((r) => {
    const key = r.date;
    if (!map[key]) map[key] = { money: 0, rounds: 0 };
    map[key].money += Number(r.moneyPerRound) * Number(r.rounds);
    map[key].rounds += Number(r.rounds);
  });
  return Object.keys(map).sort().map((k) => ({ date: k, money: map[k].money, rounds: map[k].rounds }));
}

function computeWeekly(records) {
  const map = {};
  records.forEach((r) => {
    const key = getWeekStart(r.date);
    if (!map[key]) map[key] = { money: 0, rounds: 0 };
    map[key].money += Number(r.moneyPerRound) * Number(r.rounds);
    map[key].rounds += Number(r.rounds);
  });
  return Object.keys(map).sort().map((k) => ({ week: k, money: map[k].money, rounds: map[k].rounds }));
}

function computeMonthly(records) {
  const map = {};
  records.forEach((r) => {
    const key = r.date.slice(0, 7);
    if (!map[key]) map[key] = { money: 0, rounds: 0 };
    map[key].money += Number(r.moneyPerRound) * Number(r.rounds);
    map[key].rounds += Number(r.rounds);
  });
  return Object.keys(map).sort().map((k) => ({ month: k, money: map[k].money, rounds: map[k].rounds }));
}

function computeYearly(records) {
  const map = {};
  records.forEach((r) => {
    const key = r.date.slice(0, 4);
    if (!map[key]) map[key] = { money: 0, rounds: 0 };
    map[key].money += Number(r.moneyPerRound) * Number(r.rounds);
    map[key].rounds += Number(r.rounds);
  });
  return Object.keys(map).sort().map((k) => ({ year: k, money: map[k].money, rounds: map[k].rounds }));
}

function renderSummary() {
  const start = document.getElementById('summary-start').value;
  const end = document.getElementById('summary-end').value;
  const records = JSON.parse(localStorage.getItem('records')) || [];
  const inRange = records.filter((r) => start && end ? (r.date >= start && r.date <= end) : false);
  const totalRounds = inRange.reduce((sum, r) => sum + Number(r.rounds || 1), 0);
  const totalMoney = inRange.reduce((sum, r) => sum + Number(r.moneyPerRound || 0) * Number(r.rounds || 1), 0);
  document.getElementById('card-total-money').textContent = formatMoney(totalMoney);
  document.getElementById('card-total-rounds').textContent = totalRounds.toLocaleString('th-TH');
  document.getElementById('card-avg').textContent = formatMoney(totalRounds ? totalMoney / totalRounds : 0);
  document.getElementById('no-data-message').hidden = inRange.length > 0;
  document.getElementById('summary-period').textContent = start && end ? `ช่วงวันที่ ${start} ถึง ${end}` : 'ยังไม่ได้เลือกช่วงเวลา';
  document.getElementById('no-data-message').innerHTML = inRange.length ? '' : '<strong>ยังไม่มีข้อมูลในช่วงเวลานี้</strong><span>เริ่มบันทึกรอบแรกเพื่อดูภาพรวมรายได้ของคุณ</span>';
  document.getElementById('summary-result').hidden = inRange.length === 0;
  renderDailyIncomeChart(inRange);
  renderPickupIncomeChart(inRange);
  renderLatestRecords(inRange);

  const daily = computeDaily(inRange);
  const weekly = computeWeekly(inRange);
  const monthly = computeMonthly(inRange);
  const yearly = computeYearly(inRange);

  document.getElementById('daily-summary').innerHTML = daily.length
    ? daily.map((d) => `<div>วันที่ ${d.date} — ยอดเงินรวม ${formatMoney(d.money)} — จำนวนรอบ ${d.rounds}</div>`).join('')
    : '<div>ไม่มีข้อมูล</div>';

  document.getElementById('weekly-summary').innerHTML = weekly.length
    ? weekly.map((w) => `<div>สัปดาห์ที่เริ่ม ${w.week} — ยอดเงินรวม ${formatMoney(w.money)} — จำนวนรอบ ${w.rounds}</div>`).join('')
    : '<div>ไม่มีข้อมูล</div>';

  document.getElementById('monthly-summary').innerHTML = monthly.length
    ? monthly.map((m) => `<div>เดือน ${m.month} — ยอดเงินรวม ${formatMoney(m.money)} — จำนวนรอบ ${m.rounds}</div>`).join('')
    : '<div>ไม่มีข้อมูล</div>';

  document.getElementById('yearly-summary').innerHTML = yearly.length
    ? yearly.map((y) => `<div>ปี ${y.year} — ยอดเงินรวม ${formatMoney(y.money)} — จำนวนรอบ ${y.rounds}</div>`).join('')
    : '<div>ไม่มีข้อมูล</div>';
}

function renderLatestRecords(records) {
  const list = document.getElementById('latest-records-list');
  const latest = [...records].sort((a, b) => `${b.date} ${b.time || ''}`.localeCompare(`${a.date} ${a.time || ''}`)).slice(0, 5);
  list.innerHTML = latest.length ? latest.map((r) => `<div class="latest-record"><span>${r.date}${r.time ? ` ${r.time}` : ''}</span><span>${r.pickupPoint || 'ไม่ระบุจุดรับ'}</span><strong>${formatMoney(Number(r.moneyPerRound || 0) * Number(r.rounds || 1))}</strong></div>`).join('') : '<p class="latest-empty">ยังไม่มีรายการในช่วงเวลานี้</p>';
}

function formatChartDate(date) {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getDailyChartSeries(records, start, end) {
  const totals = {};
  records.forEach((r) => {
    totals[r.date] = (totals[r.date] || 0) + Number(r.moneyPerRound || 0) * Number(r.rounds || 1);
  });
  const labels = [];
  const values = [];
  if (summaryRangeMode === 'year') {
    const year = Number(start.slice(0, 4));
    for (let month = 0; month < 12; month += 1) {
      labels.push(new Intl.DateTimeFormat('th-TH', { month: 'short' }).format(new Date(year, month, 1)));
      values.push(Object.keys(totals).filter((key) => key.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`)).reduce((sum, key) => sum + totals[key], 0));
    }
  } else {
    const cursor = new Date(`${start}T00:00:00`);
    const last = new Date(`${end}T00:00:00`);
    while (cursor <= last) {
      const key = dateKey(cursor);
      labels.push(formatChartDate(cursor));
      values.push(totals[key] || 0);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return { labels, values };
}

function renderDailyIncomeChart(records) {
  const panel = document.getElementById('daily-chart-panel');
  const empty = document.getElementById('daily-chart-empty');
  const canvas = document.getElementById('daily-income-chart');
  const hasData = records.length > 0;
  panel.hidden = false;
  canvas.parentElement.hidden = !hasData;
  empty.hidden = hasData;
  if (!hasData) {
    if (dailyIncomeChart) { dailyIncomeChart.destroy(); dailyIncomeChart = null; }
    return;
  }
  const series = getDailyChartSeries(records, document.getElementById('summary-start').value, document.getElementById('summary-end').value);
  if (dailyIncomeChart) dailyIncomeChart.destroy();
  dailyIncomeChart = new Chart(canvas, {
    type: 'bar',
    data: { labels: series.labels, datasets: [{ label: 'รายได้ (บาท)', data: series.values, backgroundColor: '#25827c', borderRadius: 4, maxBarThickness: 34 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `฿${Number(ctx.raw).toFixed(2)}` } } },
      scales: { x: { title: { display: true, text: summaryRangeMode === 'year' ? 'เดือน' : 'วันที่' }, ticks: { maxRotation: 45, minRotation: 0, autoSkip: summaryRangeMode !== 'week' } }, y: { beginAtZero: true, title: { display: true, text: 'บาท' }, ticks: { callback: (value) => `฿${value}` } } }
    }
  });
}

function renderPickupIncomeChart(records) {
  const canvas = document.getElementById('pickup-income-chart');
  const wrap = canvas.parentElement;
  const empty = document.getElementById('pickup-chart-empty');
  const totals = {};
  records.forEach((r) => {
    const name = (r.pickupPoint || 'ไม่ระบุจุดรับ').trim() || 'ไม่ระบุจุดรับ';
    totals[name] = (totals[name] || 0) + Number(r.moneyPerRound || 0) * Number(r.rounds || 1);
  });
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 6);
  const remainder = sorted.slice(6).reduce((sum, [, value]) => sum + value, 0);
  if (remainder > 0) top.push(['อื่น ๆ', remainder]);
  const hasData = top.length > 0 && top.some(([, value]) => value > 0);
  wrap.hidden = !hasData;
  empty.hidden = hasData;
  if (pickupIncomeChart) { pickupIncomeChart.destroy(); pickupIncomeChart = null; }
  if (!hasData) return;
  const total = top.reduce((sum, [, value]) => sum + value, 0);
  const colors = ['#25827c', '#4d9f8f', '#78b9a8', '#a4d0c2', '#d0e5dc', '#e5b95c', '#9aa6a3'];
  pickupIncomeChart = new Chart(canvas, {
    type: 'pie',
    data: { labels: top.map(([name]) => name), datasets: [{ data: top.map(([, value]) => value), backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 14, padding: 12 } },
        tooltip: { callbacks: {
          label: (ctx) => { const value = Number(ctx.raw); const percent = total ? (value / total * 100).toFixed(1) : '0.0'; return ` ${ctx.label}: ฿${value.toFixed(2)} (${percent}%)`; }
        } }
      }
    }
  });
}

document.getElementById('summary-btn').addEventListener('click', renderSummary);

function setSummaryRange(start, end) {
  document.getElementById('summary-start').value = start;
  document.getElementById('summary-end').value = end;
  document.getElementById('summary-month').value = '';
  document.getElementById('summary-year').value = '';
  renderSummary();
}

function getLocalDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

document.getElementById('range-today').addEventListener('click', () => { summaryRangeMode = 'today'; setSummaryRange(dateStr, dateStr); });
document.getElementById('range-week').addEventListener('click', () => {
  summaryRangeMode = 'week';
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  setSummaryRange(getLocalDateString(monday), getLocalDateString(sunday));
});
document.getElementById('range-month').addEventListener('click', () => {
  summaryRangeMode = 'month';
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  setSummaryRange(getLocalDateString(start), getLocalDateString(end));
});
document.getElementById('range-year').addEventListener('click', () => { summaryRangeMode = 'year'; setSummaryRange(`${now.getFullYear()}-01-01`, `${now.getFullYear()}-12-31`); });
document.getElementById('range-custom').addEventListener('click', () => document.getElementById('summary-start').focus());
document.getElementById('summary-start').addEventListener('change', renderSummary);
document.getElementById('summary-end').addEventListener('change', renderSummary);

document.getElementById('summary-month').addEventListener('change', (e) => {
  const v = e.target.value;
  if (!v) return;
  const [y, m] = v.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  document.getElementById('summary-start').value = `${y}-${String(m).padStart(2, '0')}-01`;
  document.getElementById('summary-end').value = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  renderSummary();
});

document.getElementById('summary-year').addEventListener('change', (e) => {
  const v = e.target.value;
  if (!v) return;
  document.getElementById('summary-start').value = `${v}-01-01`;
  document.getElementById('summary-end').value = `${v}-12-31`;
  renderSummary();
});

const today = dateStr;
const recordsNow = JSON.parse(localStorage.getItem('records')) || [];
let earliest = today;
recordsNow.forEach((r) => { if (r.date < earliest) earliest = r.date; });
document.getElementById('summary-start').value = earliest;
document.getElementById('summary-end').value = today;
renderSummary();

function showView(viewId) {
  document.getElementById('view-record').style.display = viewId === 'record' ? 'block' : 'none';
  document.getElementById('summary').style.display = viewId === 'summary' ? 'block' : 'none';
  document.getElementById('records').style.display = viewId === 'summary' ? 'block' : 'none';
  document.getElementById('nav-record').classList.toggle('active', viewId === 'record');
  document.getElementById('nav-summary').classList.toggle('active', viewId === 'summary');
}

document.getElementById('nav-record').addEventListener('click', () => showView('record'));
document.getElementById('nav-summary').addEventListener('click', () => {
  showView('summary');
  renderSummary();
});

showView('record');

// ใช้ Firebase Firestore เป็นฐานข้อมูลออนไลน์ และคง localStorage เป็นสำเนาในเครื่อง
loadRecordsFromSheet().catch((error) => {
  console.error('โหลดข้อมูลจาก Firebase ไม่สำเร็จ:', error);
});
