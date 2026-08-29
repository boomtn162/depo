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
  ocrState = null;
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
const IS_PDF = f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
const IS_IMAGE = f => /\.(png|jpe?g)$/i.test(f.name) || /^image\/(png|jpe?g)$/.test(f.type);

async function handleFile(file) {
  resultSection.hidden = true;

  if (IS_PDF(file)) {
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
      setStatus('เกิดข้อผิดพลาดขณะประมวลผลไฟล์ PDF: ' + (err && err.message ? err.message : err), true);
    }
    return;
  }

  if (IS_IMAGE(file)) {
    setStatus('กำลังเตรียมระบบอ่านข้อความจากภาพ (OCR) ...');
    try {
      const lines = await extractLinesFromImage(file, pct =>
        setStatus(`กำลังอ่านข้อความจากภาพด้วย OCR ... ${pct}%`)
      );
      const data = parseDashboardOcr(lines);
      if (data.rows.length === 0) {
        setStatus('อ่านภาพได้ แต่ไม่พบรายการที่ตรงรูปแบบที่รองรับ (ตารางรายการใบนำมอบสินค้าห่อวัตถุ) ลองใช้ภาพที่คมชัดกว่านี้', true);
        return;
      }
      clearStatus();
      renderResult(data);
    } catch (err) {
      console.error(err);
      setStatus('เกิดข้อผิดพลาดขณะอ่านภาพด้วย OCR: ' + (err && err.message ? err.message : err), true);
    }
    return;
  }

  setStatus('กรุณาเลือกไฟล์ .pdf หรือรูปภาพ .png/.jpg เท่านั้น', true);
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

// ---------- Image OCR extraction (client-side, fully offline via vendored tesseract.js) ----------
async function extractLinesFromImage(file, onProgress) {
  const worker = await Tesseract.createWorker('tha+eng', 1, {
    workerPath: 'vendor/tesseract/worker.min.js',
    corePath: 'vendor/tesseract/tesseract-core-simd-lstm.js',
    langPath: 'vendor/tesseract/lang-data',
    gzip: true,
    workerBlobURL: false, // required: a blob-URL worker can't resolve the relative .wasm path
    logger: (m) => {
      if (m.status === 'recognizing text' && onProgress) {
        onProgress(Math.round((m.progress || 0) * 100));
      }
    },
  });
  try {
    const { data } = await worker.recognize(file);
    return (data.text || '')
      .split('\n')
      .map(normalizeOcrLine)
      .filter(Boolean);
  } finally {
    await worker.terminate();
  }
}

// Thai OCR often reads สระอำ as the decomposed nikhahit+aa sequence — recompose it.
function normalizeOcrLine(s) {
  return s.replace(/ํา/g, 'ำ').replace(/\s+/g, ' ').trim();
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
    source: 'pdf',
    meta, rows, stations: stationSummaries,
    totals: {
      weight: totalWeight, freight: totalFreight, unitCounts, totalPieces, parcelCount,
      goodsUnitCounts, totalGoodsPieces, vehicleCount,
    },
    printedTotal,
  };
}

// ---------- Dashboard-screenshot format (parsed via OCR) ----------
// Different layout from the PDF manifest: grouped by station with a printed
// "(จำนวน N ชิ้น)" count per station, no ค่าระวาง+ค่า ธ. column, and item rows
// numbered "N. รายการ  น้ำหนัก  จำนวน" instead of unit words like กล่อง/คัน.
const RE_OCR_STATION = /^(.{1,40}?)\s*\(?จำนวน\s*([\d,]+)\s*ชิ้น\)?\s*$/;
const RE_OCR_ITEM = /(\d+)\.\s*(.+?)\s+([\d,]+\.\d{1,2}|\d+)\s+(\d+)\s*$/;
const RE_OCR_TRACKING_GUESS = /([A-Za-z0-9]{2,8}-\d{3,4}-\d{4,6})/;
const RE_OCR_TRAIN_GUESS = /ขบวนรถ\S*(?:พิเศษ)?(?:สินค้า)?\s*(\S+)/;
// item-name keywords treated as a vehicle rather than general goods
const VEHICLE_NAME_RE = /รถจักรยานยนต์|รถยนต์|รถกระบะ|รถบรรทุก|รถตู้/;

function parseDashboardOcr(lines) {
  const meta = { train: '', origin: '', rideDate: '', printedAt: '' };
  const stations = [];
  const rows = [];
  let currentStation = null;
  let rowId = 0;

  const ensureStation = (name, printedQty) => {
    const st = { name, printedQty, rows: [] };
    stations.push(st);
    currentStation = st;
    return st;
  };
  const unassigned = () => currentStation || ensureStation('ไม่ระบุสถานี', null);

  for (const line of lines) {
    if (!meta.train) {
      const tm = line.match(RE_OCR_TRAIN_GUESS);
      if (tm) meta.train = tm[0].trim();
    }

    const st = line.match(RE_OCR_STATION);
    if (st) {
      ensureStation(st[1].trim(), parseInt(st[2].replace(/,/g, ''), 10));
      continue;
    }

    const it = line.match(RE_OCR_ITEM);
    if (it) {
      const prefix = line.slice(0, it.index);
      const trackMatch = prefix.match(RE_OCR_TRACKING_GUESS);
      const name = it[2].trim();
      const row = {
        id: rowId++,
        trackingNo: trackMatch ? trackMatch[1] : '',
        name,
        weight: toNum(it[3]),
        qty: parseInt(it[4], 10),
        isVehicle: VEHICLE_NAME_RE.test(name),
        station: unassigned(),
      };
      currentStation.rows.push(row);
      rows.push(row);
    }
    // otherwise: status text, blank line, or OCR noise — ignore
  }

  return buildOcrResult(meta, stations, rows);
}

// Recomputes totals/station summaries from the (possibly user-edited) row
// list — shared by the initial parse and every edit/add/delete in the review UI.
function buildOcrResult(meta, stations, rows) {
  const totalWeight = rows.reduce((s, r) => s + (r.weight || 0), 0);
  const vehicleCount = rows.filter(r => r.isVehicle).reduce((s, r) => s + (r.qty || 0), 0);
  const totalGoodsPieces = rows.filter(r => !r.isVehicle).reduce((s, r) => s + (r.qty || 0), 0);
  const totalPieces = totalGoodsPieces + vehicleCount;

  const stationSummaries = stations
    .filter(st => st.rows.length > 0)
    .map(st => {
      const qty = st.rows.reduce((s, r) => s + (r.qty || 0), 0);
      return {
        name: st.name,
        itemCount: st.rows.length,
        weight: st.rows.reduce((s, r) => s + (r.weight || 0), 0),
        qty,
        printedQty: st.printedQty,
        qtyMatches: st.printedQty == null ? null : qty === st.printedQty,
      };
    });

  return {
    source: 'ocr',
    meta, rows, stations: stationSummaries,
    totals: {
      weight: totalWeight, freight: null, totalPieces, totalGoodsPieces, vehicleCount,
      parcelCount: rows.length,
      goodsUnitCounts: totalGoodsPieces ? { 'ชิ้น': totalGoodsPieces } : {},
    },
    printedTotal: null,
  };
}

// ---------- Rendering ----------
const fmtInt = n => Number(n).toLocaleString('th-TH');
const fmtNum = n => Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });

function breakdownText(unitCounts) {
  return Object.entries(unitCounts).map(([u, c]) => `${fmtInt(c)} ${u}`).join(', ');
}

// holds the current OCR result so edits in the review table can recompute it
let ocrState = null;

function renderResult(data) {
  const isOcr = data.source === 'ocr';
  if (isOcr) ocrState = data;

  const { meta, totals } = data;

  document.getElementById('docMeta').innerHTML =
    `ขบวน <strong>${escapeHtml(meta.train || '-')}</strong>` +
    (meta.origin ? ` &nbsp;·&nbsp; ต้นทาง <strong>${escapeHtml(meta.origin)}</strong>` : '') +
    (meta.rideDate ? ` &nbsp;·&nbsp; วันที่ขึ้นขบวนรถ <strong>${escapeHtml(meta.rideDate)}</strong>` : '') +
    (meta.printedAt ? ` &nbsp;·&nbsp; พิมพ์เอกสารเมื่อ <strong>${escapeHtml(meta.printedAt)}</strong>` : '') +
    (isOcr ? ' &nbsp;·&nbsp; <strong>อ่านจากรูปภาพด้วย OCR</strong>' : '');

  document.getElementById('pdfDetailSection').hidden = isOcr;
  document.getElementById('ocrDetailSection').hidden = !isOcr;

  renderHeadlineAndVerify(data);

  if (isOcr) {
    renderOcrTables(data);
  } else {
    renderPdfTables(data);
  }

  fillSlip(data);
  resultSection.hidden = false;
}

function renderHeadlineAndVerify(data) {
  const { totals, printedTotal, stations, source } = data;

  document.getElementById('totalWeight').textContent = fmtNum(totals.weight);
  document.getElementById('totalFreight').textContent =
    totals.freight == null ? '-' : fmtNum(totals.freight);
  document.getElementById('totalPieces').textContent = fmtInt(totals.totalGoodsPieces);
  document.getElementById('pieceBreakdown').textContent = breakdownText(totals.goodsUnitCounts) || '-';
  document.getElementById('totalVehicles').textContent = fmtInt(totals.vehicleCount);

  const verifyEl = document.getElementById('verifyMsg');
  if (source === 'pdf' && printedTotal) {
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
  } else if (source === 'ocr') {
    const checkable = stations.filter(s => s.qtyMatches !== null);
    const mismatches = checkable.filter(s => !s.qtyMatches);
    verifyEl.hidden = checkable.length === 0;
    if (checkable.length > 0) {
      if (mismatches.length === 0) {
        verifyEl.className = 'verify-msg ok';
        verifyEl.textContent = '✓ จำนวนที่คำนวณตรงกับ "(จำนวน N ชิ้น)" ที่ระบุไว้ใต้ชื่อสถานีในภาพทุกแห่ง';
      } else {
        verifyEl.className = 'verify-msg warn';
        verifyEl.textContent = `⚠ ${mismatches.length} สถานีมีจำนวนไม่ตรงกับที่ระบุในภาพ (${mismatches.map(m => escapeHtml(m.name)).join(', ')}) — ตรวจสอบแถวที่ไฮไลต์ในตารางด้านล่าง`;
      }
    }
  } else {
    verifyEl.hidden = true;
  }
}

function renderPdfTables(data) {
  const { stations, rows } = data;

  const stBody = document.getElementById('stationTableBody');
  stBody.innerHTML = stations.map(s => `
    <tr>
      <td>${escapeHtml(s.code)}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${fmtInt(s.parcelCount)}</td>
      <td>${fmtNum(s.weight)}</td>
      <td>${fmtNum(s.freight)}</td>
    </tr>`).join('');

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
}

// ---------- OCR review table: editable weight/qty/vehicle, add/delete rows ----------

function renderOcrStationTable(stations) {
  document.getElementById('ocrStationTableBody').innerHTML = stations.map(s => `
    <tr class="${s.qtyMatches === false ? 'ocr-row-mismatch' : ''}">
      <td>${escapeHtml(s.name)}</td>
      <td>${fmtInt(s.itemCount)}</td>
      <td>${fmtNum(s.weight)}</td>
      <td>${fmtInt(s.qty)}</td>
      <td>${s.qtyMatches === null ? '-' : s.qtyMatches ? '✓' : `⚠ ภาพระบุ ${fmtInt(s.printedQty)}`}</td>
    </tr>`).join('');
}

function renderOcrTables(data) {
  renderOcrStationTable(data.stations);
  renderOcrItemTable(data);
}

const stationNamesOf = data => [...new Set(data.rows.map(r => r.station.name))];

function renderOcrItemTable(data) {
  const itBody = document.getElementById('ocrItemTableBody');
  const stationNames = stationNamesOf(data);
  itBody.innerHTML = data.rows.map(r => `
    <tr data-row-id="${r.id}">
      <td>
        <select class="ocr-field" data-field="stationName">
          ${stationNames.map(n => `<option value="${escapeHtml(n)}" ${n === r.station.name ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
        </select>
      </td>
      <td>${escapeHtml(r.trackingNo) || '<span class="hint">-</span>'}</td>
      <td>${escapeHtml(r.name)}</td>
      <td><input class="ocr-field" data-field="weight" type="number" step="0.01" min="0" value="${r.weight}"></td>
      <td><input class="ocr-field" data-field="qty" type="number" step="1" min="0" value="${r.qty}"></td>
      <td><input class="ocr-field" data-field="isVehicle" type="checkbox" ${r.isVehicle ? 'checked' : ''}></td>
      <td><button type="button" class="ocr-del-btn" data-del="${r.id}" title="ลบรายการนี้">✕</button></td>
    </tr>`).join('');
}

function recomputeOcrRows() {
  if (!ocrState) return;
  // regroup rows into station buckets (a row's station may have changed via the dropdown)
  const byName = new Map();
  for (const r of ocrState.rows) {
    if (!byName.has(r.station.name)) byName.set(r.station.name, { name: r.station.name, printedQty: r.station.printedQty, rows: [] });
    const bucket = byName.get(r.station.name);
    r.station = bucket;
    bucket.rows.push(r);
  }
  ocrState = buildOcrResult(ocrState.meta, [...byName.values()], ocrState.rows);
  renderHeadlineAndVerify(ocrState);
  renderOcrStationTable(ocrState.stations);
  fillSlip(ocrState);
}

function handleOcrFieldChange(e) {
  const field = e.target.dataset.field;
  if (!field || !ocrState) return;
  const tr = e.target.closest('tr');
  const row = ocrState.rows.find(r => r.id === Number(tr.dataset.rowId));
  if (!row) return;
  if (field === 'weight') row.weight = toNum(e.target.value) || 0;
  else if (field === 'qty') row.qty = parseInt(e.target.value, 10) || 0;
  else if (field === 'isVehicle') row.isVehicle = e.target.checked;
  else if (field === 'stationName') {
    const bucket = ocrState.rows.map(r => r.station).find(s => s.name === e.target.value);
    row.station = bucket || { name: e.target.value, printedQty: null, rows: [] };
  }
  recomputeOcrRows();
}
document.getElementById('ocrItemTableBody').addEventListener('input', handleOcrFieldChange);
document.getElementById('ocrItemTableBody').addEventListener('change', (e) => {
  if (e.target.tagName === 'SELECT') handleOcrFieldChange(e);
});

document.getElementById('ocrItemTableBody').addEventListener('click', (e) => {
  const delId = e.target.dataset.del;
  if (delId === undefined || !ocrState) return;
  ocrState.rows = ocrState.rows.filter(r => r.id !== Number(delId));
  recomputeOcrRows();
  renderOcrItemTable(ocrState);
});

document.getElementById('ocrAddRowBtn').addEventListener('click', () => {
  if (!ocrState) return;
  const names = stationNamesOf(ocrState);
  const stationName = names[0] || 'ไม่ระบุสถานี';
  let bucket = ocrState.rows.map(r => r.station).find(s => s.name === stationName);
  if (!bucket) bucket = { name: stationName, printedQty: null, rows: [] };
  const maxId = ocrState.rows.reduce((m, r) => Math.max(m, r.id), -1);
  ocrState.rows.push({
    id: maxId + 1, trackingNo: '', name: '(รายการใหม่)', weight: 0, qty: 1, isVehicle: false, station: bucket,
  });
  recomputeOcrRows();
  renderOcrItemTable(ocrState);
});

function fillSlip(data) {
  const { meta, totals, stations, source } = data;
  document.getElementById('slipTrain').textContent =
    `ขบวน ${meta.train || '-'}${meta.origin ? ' (' + meta.origin + ')' : ''}`;
  document.getElementById('slipDate').textContent =
    meta.rideDate ? `วันที่ขึ้นขบวนรถ ${meta.rideDate}` : '';
  document.getElementById('slipWeight').textContent = `${fmtNum(totals.weight)} กก.`;
  document.getElementById('slipFreight').textContent =
    totals.freight == null ? 'ไม่มีข้อมูล' : `${fmtNum(totals.freight)} บาท`;
  document.getElementById('slipPieces').textContent = `${fmtInt(totals.totalGoodsPieces)} ชิ้น/หน่วย`;
  document.getElementById('slipBreakdown').textContent = breakdownText(totals.goodsUnitCounts);
  document.getElementById('slipVehicles').textContent = `${fmtInt(totals.vehicleCount)} คัน`;
  document.getElementById('slipParcelCount').textContent = fmtInt(totals.parcelCount);

  const table = document.getElementById('slipStationTable');
  const rowsHtml = stations.map(s => `
    <tr>
      <td class="code">${escapeHtml(s.code || '')}</td>
      <td class="name">${escapeHtml(s.name)}</td>
      <td class="num">${fmtNum(s.weight)}</td>
      <td class="num">${s.freight == null ? '-' : fmtNum(s.freight)}</td>
    </tr>`).join('');
  table.innerHTML = `
    <thead><tr><th class="code">รหัส</th><th class="name">สถานี</th><th class="num">กก.</th><th class="num">${source === 'ocr' ? 'ชิ้น' : 'บาท'}</th></tr></thead>
    <tbody>${rowsHtml}</tbody>`;
  if (source === 'ocr') {
    // swap the last numeric column to show item count instead of a freight figure that doesn't exist
    [...table.querySelectorAll('tbody tr')].forEach((tr, i) => {
      tr.children[3].textContent = fmtInt(stations[i].qty);
    });
  }

  document.getElementById('slipFooter').textContent =
    (source === 'ocr' ? 'อ่านจากภาพด้วย OCR · ' : '') + 'พิมพ์เมื่อ ' + new Date().toLocaleString('th-TH');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
