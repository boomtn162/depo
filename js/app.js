/* สรุปรายการขนส่งจากใบนำมอบสินค้าห่อวัตถุ(รวม)
 * อ่านไฟล์ PDF ทั้งหมดในเบราว์เซอร์ด้วย pdf.js แล้วดึงข้อมูลรายการ/สถานี/ยอดรวม
 */

'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';

// ---------- DOM refs ----------
const fileInput = document.getElementById('fileInput');
const pickFileBtn = document.getElementById('pickFileBtn');
const uploadBox = document.getElementById('uploadBox');
const statusMsg = document.getElementById('statusMsg');
const resultSection = document.getElementById('resultSection');
const printSlipBtn = document.getElementById('printSlipBtn');
const resetBtn = document.getElementById('resetBtn');

pickFileBtn.addEventListener('click', () => fileInput.click());
uploadBox.addEventListener('click', (e) => {
  if (e.target === pickFileBtn) return;
  fileInput.click();
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

['dragenter', 'dragover'].forEach(evt =>
  uploadBox.addEventListener(evt, (e) => {
    e.preventDefault();
    uploadBox.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach(evt =>
  uploadBox.addEventListener(evt, (e) => {
    e.preventDefault();
    uploadBox.classList.remove('dragover');
  })
);
uploadBox.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

resetBtn.addEventListener('click', () => {
  resultSection.hidden = true;
  statusMsg.hidden = true;
  fileInput.value = '';
});

printSlipBtn.addEventListener('click', () => window.print());

// ---------- Status helpers ----------
function setStatus(text, isError) {
  statusMsg.hidden = false;
  statusMsg.textContent = text;
  statusMsg.classList.toggle('error', !!isError);
}
function clearStatus() {
  statusMsg.hidden = true;
  statusMsg.textContent = '';
  statusMsg.classList.remove('error');
}

// ---------- Main entry ----------
async function handleFile(file) {
  resultSection.hidden = true;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    setStatus('กรุณาเลือกไฟล์ .pdf เท่านั้น', true);
    return;
  }
  setStatus('กำลังอ่านไฟล์ PDF ...');
  try {
    const buf = await file.arrayBuffer();
    const lines = await extractLines(buf);
    const data = parseManifest(lines);
    if (data.rows.length === 0) {
      setStatus('อ่านไฟล์ได้ แต่ไม่พบรายการสินค้าตามรูปแบบที่รองรับ (ใบนำมอบสินค้าห่อวัตถุ(รวม))', true);
      return;
    }
    clearStatus();
    renderResult(data);
  } catch (err) {
    console.error(err);
    setStatus('เกิดข้อผิดพลาดขณะประมวลผลไฟล์: ' + (err && err.message ? err.message : err), true);
  }
}

// ---------- PDF text extraction: group text items into lines by page/y ----------
async function extractLines(arrayBuffer) {
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const lines = [];
  const Y_TOLERANCE = 2.5;

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const items = content.items
      .filter(it => it.str !== undefined)
      .map(it => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
      }));

    // sort top-to-bottom (y desc), then left-to-right (x asc)
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x));

    let group = [];
    let groupY = null;
    const flush = () => {
      if (!group.length) return;
      group.sort((a, b) => a.x - b.x);
      const text = group.map(g => g.str).join(' ').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
      group = [];
    };

    for (const it of items) {
      if (!it.str.trim()) continue;
      if (groupY === null || Math.abs(it.y - groupY) <= Y_TOLERANCE) {
        group.push(it);
        if (groupY === null) groupY = it.y;
      } else {
        flush();
        group.push(it);
        groupY = it.y;
      }
    }
    flush();
  }
  return lines;
}

// ---------- Regexes for the manifest format ----------
const RE_TRAIN = /พรร\.\s*ขบวน\s*(\S+)/;
const RE_ORIGIN = /\(สินค้า\s*([^)]+)\)/;
const RE_RIDE_DATE = /วันที่ขึ้นขบวนรถ\s*([^)]+?)$/;
const RE_PRINTED_AT = /วันเวลาที่พิมพ์\s*:\s*([\d\-:. ]+)/;
const RE_GRAND_TOTAL = /ยอดรวมทั้งหมด\s*:\s*(.+?)\s*น้ำหนักรวมทั้งหมด\s*:\s*([\d,]+(?:\.\d+)?)\s*กิโลกรัม/;

// full item row: seq, tracking no, qty, unit, name, freight, weight
const RE_ITEM_FULL = /^(\d{1,3})\s+([A-Za-z][\w\-\/]{3,})\s+(\d+)\s+(\S+)\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)$/;
// continuation row (extra item under the same parcel): qty, unit, name, freight, weight
const RE_ITEM_CONT = /^(\d+)\s+(\S+)\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)$/;
// station header: "1001 กรุงเทพ" — pure Thai/space name after a 3-4 digit code, no digits in the name
const RE_STATION = /^(\d{3,4})\s+([฀-๿()\.\s]+)$/;

function toNum(s) {
  return parseFloat(String(s).replace(/,/g, ''));
}

// หน่วยนับที่ถือว่าเป็น "ยานพาหนะ" (แยกออกจากจำนวนสินค้าทั่วไป)
const VEHICLE_UNITS = new Set(['คัน']);

function parseManifest(lines) {
  const meta = { train: '', origin: '', rideDate: '', printedAt: '' };
  const stations = [];
  const rows = [];
  let currentStation = null;
  let printedTotal = null; // { weight, breakdown: [{unit,count}] }

  const ensureStation = (code, name) => {
    const st = { code, name, rows: [] };
    stations.push(st);
    currentStation = st;
    return st;
  };
  // fallback bucket for item rows that appear before any station header
  const unassigned = () => {
    if (!currentStation) ensureStation('', 'ไม่ระบุสถานี');
    return currentStation;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (!meta.train && RE_TRAIN.test(line)) meta.train = line.match(RE_TRAIN)[1];
    if (!meta.origin && RE_ORIGIN.test(line)) meta.origin = line.match(RE_ORIGIN)[1].trim();
    if (!meta.rideDate && RE_RIDE_DATE.test(line)) meta.rideDate = line.match(RE_RIDE_DATE)[1].trim();
    if (!meta.printedAt && RE_PRINTED_AT.test(line)) meta.printedAt = line.match(RE_PRINTED_AT)[1].trim();

    const gt = line.match(RE_GRAND_TOTAL);
    if (gt) {
      const breakdown = [];
      const partRe = /(\d+)\s*([^\s,]+)/g;
      let m;
      while ((m = partRe.exec(gt[1])) !== null) {
        breakdown.push({ unit: m[2], count: parseInt(m[1], 10) });
      }
      printedTotal = { weight: toNum(gt[2]), breakdown };
      continue;
    }

    const st = line.match(RE_STATION);
    if (st) {
      ensureStation(st[1], st[2].trim());
      continue;
    }

    const full = line.match(RE_ITEM_FULL);
    if (full) {
      const row = {
        seq: full[1],
        trackingNo: full[2],
        qty: parseInt(full[3], 10),
        unit: full[4],
        name: full[5].trim(),
        freight: toNum(full[6]),
        weight: toNum(full[7]),
        stationCode: unassigned().code,
        stationName: unassigned().name,
      };
      currentStation.rows.push(row);
      rows.push(row);
      continue;
    }

    const cont = line.match(RE_ITEM_CONT);
    if (cont) {
      const row = {
        seq: '',
        trackingNo: '',
        qty: parseInt(cont[1], 10),
        unit: cont[2],
        name: cont[3].trim(),
        freight: toNum(cont[4]),
        weight: toNum(cont[5]),
        stationCode: unassigned().code,
        stationName: unassigned().name,
      };
      currentStation.rows.push(row);
      rows.push(row);
      continue;
    }
    // otherwise: header/footer/signature/table-header line — ignore
  }

  // totals
  const totalWeight = rows.reduce((s, r) => s + r.weight, 0);
  const totalFreight = rows.reduce((s, r) => s + r.freight, 0);
  const unitCounts = {};
  for (const r of rows) unitCounts[r.unit] = (unitCounts[r.unit] || 0) + r.qty;

  // แยก "คัน" (ยานพาหนะ เช่น รถจักรยานยนต์/รถยนต์) ออกจากจำนวนสินค้าทั่วไป
  const goodsUnitCounts = {};
  let vehicleCount = 0;
  for (const [unit, count] of Object.entries(unitCounts)) {
    if (VEHICLE_UNITS.has(unit)) vehicleCount += count;
    else goodsUnitCounts[unit] = count;
  }
  const totalGoodsPieces = Object.values(goodsUnitCounts).reduce((s, v) => s + v, 0);
  const totalPieces = Object.values(unitCounts).reduce((s, v) => s + v, 0);
  const parcelCount = rows.filter(r => r.trackingNo).length;

  const stationSummaries = stations
    .filter(st => st.rows.length > 0)
    .map(st => ({
      code: st.code,
      name: st.name,
      parcelCount: st.rows.filter(r => r.trackingNo).length,
      weight: st.rows.reduce((s, r) => s + r.weight, 0),
      freight: st.rows.reduce((s, r) => s + r.freight, 0),
    }));

  return {
    meta, rows, stations: stationSummaries,
    totals: {
      weight: totalWeight, freight: totalFreight, unitCounts, totalPieces, parcelCount,
      goodsUnitCounts, totalGoodsPieces, vehicleCount,
    },
    printedTotal,
  };
}

// ---------- Rendering ----------
const fmtInt = n => Number(n).toLocaleString('th-TH');
const fmtNum = n => Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });

function breakdownText(unitCounts) {
  return Object.entries(unitCounts).map(([u, c]) => `${fmtInt(c)} ${u}`).join(', ');
}

function renderResult(data) {
  const { meta, totals, stations, rows, printedTotal } = data;

  document.getElementById('docMeta').innerHTML =
    `ขบวน <strong>${escapeHtml(meta.train || '-')}</strong>` +
    (meta.origin ? ` &nbsp;·&nbsp; ต้นทาง <strong>${escapeHtml(meta.origin)}</strong>` : '') +
    (meta.rideDate ? ` &nbsp;·&nbsp; วันที่ขึ้นขบวนรถ <strong>${escapeHtml(meta.rideDate)}</strong>` : '') +
    (meta.printedAt ? ` &nbsp;·&nbsp; พิมพ์เอกสารเมื่อ <strong>${escapeHtml(meta.printedAt)}</strong>` : '');

  document.getElementById('totalWeight').textContent = fmtNum(totals.weight);
  document.getElementById('totalFreight').textContent = fmtNum(totals.freight);
  document.getElementById('totalPieces').textContent = fmtInt(totals.totalGoodsPieces);
  document.getElementById('pieceBreakdown').textContent = breakdownText(totals.goodsUnitCounts) || '-';
  document.getElementById('totalVehicles').textContent = fmtInt(totals.vehicleCount);

  // cross-check against the document's own printed grand-total line, if found
  const verifyEl = document.getElementById('verifyMsg');
  if (printedTotal) {
    const weightMatches = Math.abs(printedTotal.weight - totals.weight) < 0.05;
    const printedMap = {};
    printedTotal.breakdown.forEach(b => { printedMap[b.unit] = b.count; });
    const unitsMatch = Object.keys(printedMap).length === Object.keys(totals.unitCounts).length &&
      Object.entries(printedMap).every(([u, c]) => totals.unitCounts[u] === c);
    verifyEl.hidden = false;
    if (weightMatches && unitsMatch) {
      verifyEl.className = 'verify-msg ok';
      verifyEl.textContent = '✓ ยอดรวมที่คำนวณตรงกับ "ยอดรวมทั้งหมด" ที่พิมพ์ไว้ในเอกสาร';
    } else {
      verifyEl.className = 'verify-msg warn';
      verifyEl.textContent = `⚠ ยอดที่คำนวณไม่ตรงกับเอกสาร (เอกสารระบุ: ${fmtNum(printedTotal.weight)} กก., ${breakdownText(printedMap)}) — โปรดตรวจสอบไฟล์ต้นฉบับ`;
    }
  } else {
    verifyEl.hidden = true;
  }

  // station table
  const stBody = document.getElementById('stationTableBody');
  stBody.innerHTML = stations.map(s => `
    <tr>
      <td>${escapeHtml(s.code)}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${fmtInt(s.parcelCount)}</td>
      <td>${fmtNum(s.weight)}</td>
      <td>${fmtNum(s.freight)}</td>
    </tr>`).join('');

  // item table
  const itBody = document.getElementById('itemTableBody');
  itBody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.seq)}</td>
      <td>${escapeHtml(r.trackingNo)}</td>
      <td>${escapeHtml(r.stationName)}</td>
      <td>${fmtInt(r.qty)} ${escapeHtml(r.unit)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${fmtNum(r.freight)}</td>
      <td>${fmtNum(r.weight)}</td>
    </tr>`).join('');

  fillSlip(data);
  resultSection.hidden = false;
}

function fillSlip(data) {
  const { meta, totals, stations } = data;
  document.getElementById('slipTrain').textContent =
    `ขบวน ${meta.train || '-'}${meta.origin ? ' (' + meta.origin + ')' : ''}`;
  document.getElementById('slipDate').textContent =
    meta.rideDate ? `วันที่ขึ้นขบวนรถ ${meta.rideDate}` : '';
  document.getElementById('slipWeight').textContent = `${fmtNum(totals.weight)} กก.`;
  document.getElementById('slipFreight').textContent = `${fmtNum(totals.freight)} บาท`;
  document.getElementById('slipPieces').textContent = `${fmtInt(totals.totalGoodsPieces)} ชิ้น/หน่วย`;
  document.getElementById('slipBreakdown').textContent = breakdownText(totals.goodsUnitCounts);
  document.getElementById('slipVehicles').textContent = `${fmtInt(totals.vehicleCount)} คัน`;
  document.getElementById('slipParcelCount').textContent = fmtInt(totals.parcelCount);

  const table = document.getElementById('slipStationTable');
  const rowsHtml = stations.map(s => `
    <tr>
      <td class="code">${escapeHtml(s.code)}</td>
      <td class="name">${escapeHtml(s.name)}</td>
      <td class="num">${fmtNum(s.weight)}</td>
      <td class="num">${fmtNum(s.freight)}</td>
    </tr>`).join('');
  table.innerHTML = `
    <thead><tr><th class="code">รหัส</th><th class="name">สถานี</th><th class="num">กก.</th><th class="num">บาท</th></tr></thead>
    <tbody>${rowsHtml}</tbody>`;

  document.getElementById('slipFooter').textContent =
    'พิมพ์เมื่อ ' + new Date().toLocaleString('th-TH');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
