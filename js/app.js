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
  if (fileInput.files.length) handleFiles(fileInput.files);
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
  if (e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
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

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  resultSection.hidden = true;

  // A single image keeps its own flow (needs OCR progress reporting); every
  // PDF case — single manifest, single receipt, or multiple files of any
  // mix — goes through the shared batch pipeline below, so every upload
  // ends up in the same editable review table with the audit trail.
  if (files.length === 1 && IS_IMAGE(files[0])) {
    setStatus('กำลังเตรียมระบบอ่านข้อความจากภาพ (OCR) ...');
    try {
      const lines = await extractLinesFromImage(files[0], pct =>
        setStatus(`กำลังอ่านข้อความจากภาพด้วย OCR ... ${pct}%`)
      );
      const data = parseDashboardOcr(lines);
      if (data.rows.length === 0) {
        setStatus('อ่านภาพได้ แต่ไม่พบรายการที่ตรงรูปแบบที่รองรับ (ตารางรายการใบนำมอบสินค้าห่อวัตถุ) ลองใช้ภาพที่คมชัดกว่านี้', true);
        return;
      }
      data.rows.forEach(r => { r.sourceFile = files[0].name; });
      clearStatus();
      renderResult(data);
    } catch (err) {
      console.error(err);
      setStatus('เกิดข้อผิดพลาดขณะอ่านภาพด้วย OCR: ' + (err && err.message ? err.message : err), true);
    }
    return;
  } else if (files.length === 1 && !IS_PDF(files[0])) {
    setStatus('กรุณาเลือกไฟล์ .pdf หรือรูปภาพ .png/.jpg เท่านั้น', true);
    return;
  }

  await handleBatch(files);
}

// ---------- Batch: multiple files (any mix of manifest/receipt PDFs and images), merged into one summary ----------
async function handleBatch(files) {
  const fileResults = [];

  for (const file of files) {
    setStatus(`กำลังประมวลผล ${file.name} (${fileResults.length + 1}/${files.length}) ...`);
    try {
      if (IS_PDF(file)) {
        const lines = await extractLines(await file.arrayBuffer());
        const kind = detectPdfKind(lines);
        if (kind === 'manifest') {
          const manifest = parseManifest(lines);
          const rows = manifest.rows.map(r => mapManifestRowToCommon(r, file.name));
          fileResults.push({
            file: file.name, kind: 'manifest', meta: manifest.meta, rows,
            ok: rows.length > 0, note: rows.length === 0 ? 'ไม่พบรายการในไฟล์นี้' : '',
            printedTotal: manifest.printedTotal,
          });
        } else if (kind === 'receipt') {
          const receipt = parseReceiptPdf(lines, file.name);
          fileResults.push({
            file: file.name, kind: 'receipt', meta: receipt.meta, rows: receipt.rows,
            ok: receipt.internalOk !== false,
            note: receipt.internalOk === false ? 'ยอดรวมในไฟล์คำนวณไม่ตรง อาจอ่านค่าธรรมเนียมบางรายการไม่ครบ' : '',
          });
        } else {
          fileResults.push({
            file: file.name, kind: 'unknown', meta: {}, rows: [], ok: false,
            note: 'ไม่รู้จักรูปแบบไฟล์ PDF นี้ (รองรับเฉพาะใบนำมอบสินค้าห่อวัตถุ(รวม) หรือใบส่งของ/ใบเสร็จรับเงิน)',
          });
        }
      } else if (IS_IMAGE(file)) {
        const lines = await extractLinesFromImage(file, pct =>
          setStatus(`กำลังอ่าน OCR ${file.name} (${fileResults.length + 1}/${files.length}) ... ${pct}%`)
        );
        const ocr = parseDashboardOcr(lines);
        ocr.rows.forEach(r => { r.sourceFile = file.name; r.rowSource = 'ocr'; });
        fileResults.push({
          file: file.name, kind: 'image', meta: ocr.meta, rows: ocr.rows,
          ok: ocr.rows.length > 0, note: ocr.rows.length === 0 ? 'อ่านภาพได้ แต่ไม่พบรายการที่ตรงรูปแบบที่รองรับ' : '',
        });
      } else {
        fileResults.push({ file: file.name, kind: 'unknown', meta: {}, rows: [], ok: false, note: 'ไม่รองรับชนิดไฟล์นี้' });
      }
    } catch (err) {
      console.error(err);
      fileResults.push({ file: file.name, kind: 'unknown', meta: {}, rows: [], ok: false, note: 'เกิดข้อผิดพลาด: ' + (err && err.message ? err.message : err) });
    }
  }

  const allRows = fileResults.flatMap(f => f.rows);
  // manifest/receipt rows are built with a placeholder id (they don't know
  // about sibling files while being parsed) — renumber now that everything
  // is combined, so each row in the edit table has a genuinely unique id
  allRows.forEach((r, i) => { r.id = i; markOriginal(r); });
  if (allRows.length === 0) {
    setStatus('ไม่พบรายการที่อ่านได้จากไฟล์ที่อัปโหลดเลย โปรดตรวจสอบรูปแบบไฟล์', true);
    renderFileStatusList(fileResults);
    return;
  }
  clearStatus();

  const meta = fileResults.find(f => f.ok && f.meta && f.meta.train)?.meta || { train: '', origin: '', rideDate: '', printedAt: '' };
  const data = buildOcrResult(meta, groupRowsIntoStations(allRows), allRows, 'batch');
  data.fileResults = fileResults;
  // a single manifest PDF has its own printed grand-total line — when that's
  // the only file uploaded, keep showing the exact cross-check against it
  // (a multi-file batch has no single "document total" to compare against)
  if (fileResults.length === 1 && fileResults[0].kind === 'manifest') {
    data.printedTotal = fileResults[0].printedTotal;
  }
  renderResult(data);
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

// full item row: seq, tracking no, qty, "unit? name" (unit is not always present —
// some rows print just a bare quantity with no unit word), freight, weight
const RE_ITEM_FULL = /^(\d{1,3})\s+([A-Za-z][\w\-\/]{3,})\s+(\d+)\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)$/;
// continuation row (extra item under the same parcel): qty, "unit? name", freight, weight
const RE_ITEM_CONT = /^(\d+)\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)$/;
// station header: "1001 กรุงเทพ" — pure Thai/space name after a 3-4 digit code, no digits in the name
const RE_STATION = /^(\d{3,4})\s+([฀-๿()\.\s]+)$/;
// a station header line occasionally gets fused with the item row right after it
// during text extraction (e.g. "4142 ประจวบคีรีขันธ์ 1 PAN6908-... 17 ... 1,446 310") — split it in two.
const RE_EMBEDDED_STATION_ITEM = /^(\d{3,4})\s+([฀-๿()\.]+(?:\s[฀-๿()\.]+)*)\s+(\d{1,3}\s+[A-Za-z][\w\-\/]{3,}\s+.+)$/;

function toNum(s) {
  return parseFloat(String(s).replace(/,/g, ''));
}

// หน่วยนับที่ถือว่าเป็น "ยานพาหนะ" (แยกออกจากจำนวนสินค้าทั่วไป)
const VEHICLE_UNITS = new Set(['คัน']);
// หน่วยนับที่รู้จัก — ใช้แยก "หน่วย" ออกจาก "ชื่อรายการ" ในคอลัมน์เดียวกัน
// บางแถวไม่มีคำหน่วยเลย (เช่น "17 เครื่องบริโภค(ของกิน)") จึงแยกไม่ได้และถือว่าไม่มีหน่วย
const KNOWN_UNITS = new Set([
  'กล่อง', 'ชิ้น', 'คัน', 'ถุง', 'กระสอบ', 'ลัง', 'มัด', 'แผง', 'ม้วน',
  'ตะกร้า', 'ห่อ', 'ใบ', 'ชุด', 'ขวด', 'ถัง', 'กระบอก', 'แผ่น', 'คู่', 'โหล', 'ฟอง',
]);

// แยก "หน่วย" กับ "ชื่อรายการ" จากข้อความที่เหลือหลังคอลัมน์จำนวน
function splitUnitAndName(desc) {
  const sp = desc.indexOf(' ');
  if (sp === -1) return { unit: '', name: desc };
  const first = desc.slice(0, sp);
  if (KNOWN_UNITS.has(first)) return { unit: first, name: desc.slice(sp + 1).trim() };
  return { unit: '', name: desc };
}

// ต่อบรรทัดที่หัวสถานีถูกรวมเข้ากับแถวรายการแรกโดยไม่ตั้งใจ ให้แยกเป็นสองบรรทัด
function preprocessLines(lines) {
  const out = [];
  for (const raw of lines) {
    const m = raw.match(RE_EMBEDDED_STATION_ITEM);
    if (m) {
      out.push(`${m[1]} ${m[2]}`);
      out.push(m[3]);
    } else {
      out.push(raw);
    }
  }
  return out;
}

// เดารูปแบบไฟล์ PDF จากข้อความในไฟล์: ใบนำมอบสินค้าห่อวัตถุ(รวม) แบบหลายรายการ,
// หรือใบส่งของ/ใบเสร็จรับเงินแบบรายชิ้นเดียว, หรือไม่รู้จัก
function detectPdfKind(lines) {
  const joined = lines.join('\n');
  if (/ใบนำมอบสินค้าห่อวัตถุ/.test(joined)) return 'manifest';
  if (/ใบส่งของ\s*\/\s*ใบเสร็จรับเงิน/.test(joined) || /รวมเงินทั้งสิ้น/.test(joined)) return 'receipt';
  return 'unknown';
}

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

  for (const raw of preprocessLines(lines)) {
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
      const { unit, name } = splitUnitAndName(full[4].trim());
      const row = {
        seq: full[1],
        trackingNo: full[2],
        qty: parseInt(full[3], 10),
        unit, name,
        freight: toNum(full[5]),
        weight: toNum(full[6]),
        origin: meta.origin,
        stationCode: unassigned().code,
        stationName: unassigned().name,
      };
      currentStation.rows.push(row);
      rows.push(row);
      continue;
    }

    const cont = line.match(RE_ITEM_CONT);
    if (cont) {
      const { unit, name } = splitUnitAndName(cont[2].trim());
      const row = {
        seq: '',
        trackingNo: '',
        qty: parseInt(cont[1], 10),
        unit, name,
        freight: toNum(cont[3]),
        weight: toNum(cont[4]),
        origin: meta.origin,
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
      qty: st.rows.reduce((s, r) => s + r.qty, 0),
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

// ---------- Single-parcel receipt format ("ใบส่งของ/ใบเสร็จรับเงิน") ----------
// Issued per shipment/customer rather than per train — one item (occasionally
// a few), plus a itemized fee breakdown: ค่าระวาง (freight), ค่าธรรมเนียม (fee,
// the "ค่า ธ." from the manifest format), ค่าขนขึ้น/ลง (loading/unloading),
// ค่ารักษา (insurance), minus discounts, totalling รวมเงินทั้งสิ้น.
// สำเนา/ต้นฉบับใบส่งของมีเลย์เอาต์ 2 คอลัมน์ (ผู้ส่ง | ผู้รับ) ทำให้ข้อความของทั้งสอง
// ฝั่งไปรวมอยู่บรรทัดเดียวกันหลังแยกข้อความจาก PDF — จับคู่ label:value แบบขอบเขต
// ด้วย "ป้ายถัดไปที่รู้จัก" แทนการยึดต้น/ท้ายบรรทัด ซึ่งใช้ไม่ได้กับเลย์เอาต์นี้
const RECEIPT_LABELS = [
  'ชื่อผู้ส่ง', 'ชื่อผู้รับ', 'ที่อยู่ผู้ส่ง', 'ที่อยู่ผู้รับ', 'โทรศัพท์',
  'สถานีส่ง', 'สถานีรับ', 'วันที่ส่ง', 'วันเวลาที่ออกใบส่งของ', 'ขบวนรถ', 'จังหวัด',
];
const RECEIPT_LABEL_BOUND = RECEIPT_LABELS.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
function receiptLabelValue(text, label) {
  const re = new RegExp(label + '\\s*:\\s*(.+?)(?=\\s+(?:' + RECEIPT_LABEL_BOUND + ')\\s*:|$)');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

const RE_RECEIPT_TRACKING = /เลขที่\s*:\s*(\S+)/;
const RE_RECEIPT_TRAIN = /ขบวนรถ\s*:\s*(\S+)/;
const RE_RECEIPT_QTY = /จำนวน\s*(\d+)\s*(\S+)/g;
const RE_RECEIPT_WEIGHT = /น้ำหนัก\s*([\d.,]+)\s*\/?\s*[\d.,]*\s*กิโลกรัม/g;
// ชื่อรายการอยู่ระหว่าง "1." (ลำดับที่ในตาราง) กับ "จำนวน N หน่วย" แต่มักมีข้อความ
// จากคอลัมน์ค่าธรรมเนียมข้างๆ ปนมาด้วย (เพราะอยู่แถวเดียวกันในตาราง) ต้องกรองออก
const RE_RECEIPT_ITEM_RAW = /(?:^|\s)1\.\s*(.+?)\s*จำนวน\s*\d+\s*\S+/;
const RECEIPT_FEE_LABELS = ['ค่าระวาง', 'ค่าธรรมเนียม', 'ค่าขนขึ้น', 'ค่าขนลง', 'ค่ารักษา'];
const feeAmountRe = label => new RegExp('([\\d,]+\\.\\d{2})\\s*' + label + '(?!\\S)');

function cleanReceiptItemName(raw) {
  let s = raw;
  for (const label of RECEIPT_FEE_LABELS) s = s.replace(new RegExp('[\\d,]+\\.\\d{2}\\s*' + label, 'g'), '');
  s = s.replace(/[\d,]+\.\d{2}\s*-{2,}\s*ส่วนลด\s*-{2,}/g, '');
  s = s.replace(/-\s+/g, ''); // ต่อคำไทยที่ถูกตัดขึ้นบรรทัดใหม่ด้วยยัติภังค์กลับเป็นคำเดียว
  return s.replace(/\s+/g, ' ').trim();
}

function parseReceiptPdf(lines, filename) {
  const text = lines.join(' ');

  const trackingNo = (text.match(RE_RECEIPT_TRACKING) || [])[1] || '';
  const train = (text.match(RE_RECEIPT_TRAIN) || [])[1] || '';
  const shipDate = receiptLabelValue(text, 'วันที่ส่ง');
  const printedAt = receiptLabelValue(text, 'วันเวลาที่ออกใบส่งของ');

  const originRaw = receiptLabelValue(text, 'สถานีส่ง');
  const destRaw = receiptLabelValue(text, 'สถานีรับ');
  const originMatch = originRaw.match(/^(\d{3,4})\s+(.+)$/);
  const destMatch = destRaw.match(/^(\d{3,4})\s+(.+)$/);
  const originCode = originMatch ? originMatch[1] : '';
  const originName = originMatch ? originMatch[2].trim() : originRaw;
  const destCode = destMatch ? destMatch[1] : '';
  const destName = destMatch ? destMatch[2].trim() : destRaw;

  let qty = 0, unit = '', m;
  RE_RECEIPT_QTY.lastIndex = 0;
  while ((m = RE_RECEIPT_QTY.exec(text)) !== null) { qty += parseInt(m[1], 10); unit = m[2]; }
  if (!qty) qty = 1;

  let weight = 0;
  RE_RECEIPT_WEIGHT.lastIndex = 0;
  while ((m = RE_RECEIPT_WEIGHT.exec(text)) !== null) weight += toNum(m[1]);

  const itemMatch = text.match(RE_RECEIPT_ITEM_RAW);
  const itemName = itemMatch ? cleanReceiptItemName(itemMatch[1]) : filename.replace(/\.pdf$/i, '');

  const feeOf = label => {
    const v = (text.match(feeAmountRe(label)) || [])[1];
    return v == null ? null : toNum(v);
  };
  const freightFee = feeOf('ค่าระวาง');
  const commissionFee = feeOf('ค่าธรรมเนียม');
  const loadFee = feeOf('ค่าขนขึ้น');
  const unloadFee = feeOf('ค่าขนลง');
  const careFee = feeOf('ค่ารักษา');
  const grandTotal = feeOf('รวมเงินทั้งสิ้น');

  // ค่าระวาง+ค่าธ. ให้นิยามตรงกับคอลัมน์เดียวกันในไฟล์ใบนำมอบสินค้าห่อวัตถุ(รวม)
  const freight = (freightFee || 0) + (commissionFee || 0);
  const computedGrandTotal = freight + (loadFee || 0) + (unloadFee || 0) + (careFee || 0);
  const internalOk = grandTotal == null ? null : Math.abs(computedGrandTotal - grandTotal) < 0.5;

  const isVehicle = VEHICLE_UNITS.has(unit) || VEHICLE_NAME_RE.test(itemName);
  const stationName = destName ? `${destCode} ${destName}` : 'ไม่ระบุสถานี';
  const origin = originName ? `${originCode} ${originName}` : '';

  const row = {
    id: 0, // placeholder — handleBatch() renumbers all rows once combined
    sourceFile: filename, rowSource: 'pdf',
    trackingNo, name: itemName, weight, qty, unit, isVehicle, freight, origin,
    station: { name: stationName, printedQty: null, rows: [] },
  };

  const meta = {
    train, origin: originName ? `${originCode} ${originName}` : '',
    rideDate: shipDate, printedAt,
  };

  return { meta, rows: [row], grandTotal, internalOk };
}

// แปลงแถวจากใบนำมอบสินค้าห่อวัตถุ(รวม) ให้อยู่ในรูปแบบเดียวกับแถวของ OCR/ใบส่งของ
// เพื่อรวมเข้าตารางเดียวกันได้เมื่ออัปโหลดหลายไฟล์
function mapManifestRowToCommon(row, filename) {
  return {
    id: 0, // placeholder — handleBatch() renumbers all rows once combined
    sourceFile: filename, rowSource: 'pdf',
    trackingNo: row.trackingNo, name: row.name, weight: row.weight, qty: row.qty, unit: row.unit,
    isVehicle: VEHICLE_UNITS.has(row.unit), freight: row.freight, origin: row.origin || '',
    station: {
      name: row.stationCode ? `${row.stationCode} ${row.stationName}` : row.stationName,
      printedQty: null, rows: [],
    },
  };
}

// จัดกลุ่มแถว (จากไฟล์เดียวหรือหลายไฟล์รวมกัน) เป็นสถานีตามชื่อสถานีของแต่ละแถว
function groupRowsIntoStations(rows) {
  const byName = new Map();
  for (const r of rows) {
    const key = r.station.name;
    if (!byName.has(key)) byName.set(key, { name: key, printedQty: r.station.printedQty, rows: [] });
    const bucket = byName.get(key);
    r.station = bucket;
    bucket.rows.push(r);
  }
  return [...byName.values()];
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
        id: rowId++, rowSource: 'ocr',
        trackingNo: trackMatch ? trackMatch[1] : '',
        name,
        weight: toNum(it[3]),
        qty: parseInt(it[4], 10),
        unit: 'ชิ้น', freight: null, origin: '',
        isVehicle: VEHICLE_NAME_RE.test(name),
        station: unassigned(),
      };
      currentStation.rows.push(row);
      rows.push(row);
    }
    // otherwise: status text, blank line, or OCR noise — ignore
  }

  rows.forEach(markOriginal);
  return buildOcrResult(meta, stations, rows, 'ocr');
}

// Recomputes totals/station summaries from the (possibly user-edited) row
// list — shared by the initial parse and every edit/add/delete in the review UI.
// Also used for the multi-file batch result (source: 'batch'), since a
// combined upload needs the very same editable review UI and totals math.
function buildOcrResult(meta, stations, rows, source = 'ocr') {
  const totalWeight = rows.reduce((s, r) => s + (r.weight || 0), 0);
  const freightRows = rows.filter(r => r.freight != null);
  const totalFreight = freightRows.length ? freightRows.reduce((s, r) => s + r.freight, 0) : null;

  const vehicleCount = rows.filter(r => r.isVehicle).reduce((s, r) => s + (r.qty || 0), 0);
  const goodsRows = rows.filter(r => !r.isVehicle);
  const totalGoodsPieces = goodsRows.reduce((s, r) => s + (r.qty || 0), 0);
  const totalPieces = totalGoodsPieces + vehicleCount;

  const goodsUnitCounts = {};
  for (const r of goodsRows) goodsUnitCounts[r.unit || ''] = (goodsUnitCounts[r.unit || ''] || 0) + (r.qty || 0);
  const unitCounts = {};
  for (const r of rows) unitCounts[r.unit || ''] = (unitCounts[r.unit || ''] || 0) + (r.qty || 0);

  const stationSummaries = stations
    .filter(st => st.rows.length > 0)
    .map(st => {
      const qty = st.rows.reduce((s, r) => s + (r.qty || 0), 0);
      const stFreightRows = st.rows.filter(r => r.freight != null);
      const freight = stFreightRows.length ? stFreightRows.reduce((s, r) => s + r.freight, 0) : null;
      return {
        name: st.name,
        itemCount: st.rows.length,
        weight: st.rows.reduce((s, r) => s + (r.weight || 0), 0),
        freight, qty,
        printedQty: st.printedQty,
        qtyMatches: st.printedQty == null ? null : qty === st.printedQty,
      };
    });

  return {
    source,
    meta, rows, stations: stationSummaries,
    totals: {
      weight: totalWeight, freight: totalFreight, totalPieces, totalGoodsPieces, vehicleCount,
      parcelCount: rows.length,
      goodsUnitCounts, unitCounts,
    },
    printedTotal: null,
  };
}

// ---------- Rendering ----------
const fmtInt = n => Number(n).toLocaleString('th-TH');
const fmtNum = n => Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 });

function breakdownText(unitCounts) {
  return Object.entries(unitCounts)
    .map(([u, c]) => `${fmtInt(c)} ${u || '(ไม่ระบุหน่วย)'}`)
    .join(', ');
}

// holds the current OCR result so edits in the review table can recompute it
let ocrState = null;

function renderResult(data) {
  // every upload — single manifest PDF, single receipt, image OCR, or a
  // multi-file batch — renders through the one editable review table below,
  // so corrections are always possible and always tracked in the audit log
  ocrState = data;

  auditLog = [];
  document.getElementById('auditLogSection').hidden = true;

  const { meta } = data;
  const ocrInvolved = data.rows.some(r => r.rowSource === 'ocr');
  const multiFile = data.fileResults && data.fileResults.length > 1;

  document.getElementById('docMeta').innerHTML =
    `ขบวน <strong>${escapeHtml(meta.train || '-')}</strong>` +
    (meta.origin ? ` &nbsp;·&nbsp; ต้นทาง <strong>${escapeHtml(meta.origin)}</strong>` : '') +
    (meta.rideDate ? ` &nbsp;·&nbsp; วันที่ขึ้นขบวนรถ <strong>${escapeHtml(meta.rideDate)}</strong>` : '') +
    (meta.printedAt ? ` &nbsp;·&nbsp; พิมพ์เอกสารเมื่อ <strong>${escapeHtml(meta.printedAt)}</strong>` : '') +
    (data.source === 'ocr' ? ' &nbsp;·&nbsp; <strong>อ่านจากรูปภาพด้วย OCR</strong>' : '') +
    (multiFile ? ` &nbsp;·&nbsp; <strong>รวมจาก ${fmtInt(data.fileResults.length)} ไฟล์</strong>` : '');

  document.getElementById('ocrDetailSection').hidden = false;

  if (data.fileResults) {
    renderFileStatusList(data.fileResults);
  } else {
    document.getElementById('fileStatusList').hidden = true;
  }

  const warnEl = document.getElementById('ocrWarnText');
  warnEl.textContent = ocrInvolved
    ? 'บางรายการอ่านจากรูปภาพด้วย OCR ซึ่งอาจอ่านตัวเลขผิดพลาดได้ กรุณาตรวจสอบคอลัมน์ "น้ำหนัก" และ "จำนวน" ในตารางด้านล่าง แก้ไขได้โดยคลิกที่ตัวเลข ก่อนเชื่อผลสรุปด้านบน'
    : 'ตรวจสอบรายการในตารางด้านล่าง แก้ไขตัวเลขหรือลบ/เพิ่มรายการได้โดยตรงหากพบข้อผิดพลาด';

  renderHeadlineAndVerify(data);
  renderOcrTables(data);

  fillSlip(data);
  resultSection.hidden = false;
}

function renderHeadlineAndVerify(data) {
  const { totals, printedTotal, stations, source } = data;

  document.getElementById('totalWeight').textContent = fmtNum(totals.weight);
  document.getElementById('totalFreight').textContent =
    totals.freight == null ? '-' : fmtNum(totals.freight);
  document.getElementById('totalParcels').textContent = fmtInt(totals.parcelCount);
  document.getElementById('totalPieces').textContent = fmtInt(totals.totalGoodsPieces);
  document.getElementById('pieceBreakdown').textContent = breakdownText(totals.goodsUnitCounts) || '-';
  document.getElementById('totalVehicles').textContent = fmtInt(totals.vehicleCount);

  const verifyEl = document.getElementById('verifyMsg');
  if (printedTotal) {
    const weightMatches = Math.abs(printedTotal.weight - totals.weight) < 0.05;
    const printedMap = {};
    printedTotal.breakdown.forEach(b => { printedMap[b.unit] = b.count; });
    const printedTotalCount = printedTotal.breakdown.reduce((s, b) => s + b.count, 0);
    const exactUnitsMatch = Object.keys(printedMap).length === Object.keys(totals.unitCounts).length &&
      Object.entries(printedMap).every(([u, c]) => totals.unitCounts[u] === c);
    const totalCountMatches = printedTotalCount === totals.totalPieces;
    verifyEl.hidden = false;
    if (weightMatches && exactUnitsMatch) {
      verifyEl.className = 'verify-msg ok';
      verifyEl.textContent = '✓ ยอดรวมที่คำนวณตรงกับ "ยอดรวมทั้งหมด" ที่พิมพ์ไว้ในเอกสาร';
    } else if (weightMatches && totalCountMatches) {
      verifyEl.className = 'verify-msg ok';
      verifyEl.textContent = '✓ น้ำหนักและจำนวนรวมตรงกับเอกสาร (บางแถวในตารางไม่มีคำระบุหน่วยสินค้า จึงจับคู่ชื่อหน่วยกับเอกสารไม่ได้ทั้งหมด แต่ตัวเลขรวมถูกต้อง)';
    } else {
      verifyEl.className = 'verify-msg warn';
      verifyEl.textContent = `⚠ ยอดที่คำนวณไม่ตรงกับเอกสาร (เอกสารระบุ: ${fmtNum(printedTotal.weight)} กก., ${breakdownText(printedMap)}) — โปรดตรวจสอบไฟล์ต้นฉบับ`;
    }
  } else if (source === 'ocr' || source === 'batch') {
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

// ---------- File status list (multi-file batch upload) ----------

const KIND_LABEL = { manifest: 'PDF ใบนำมอบสินค้า', receipt: 'PDF ใบส่งของ', image: 'รูปภาพ (OCR)', unknown: 'ไม่รู้จัก' };

function renderFileStatusList(fileResults) {
  const el = document.getElementById('fileStatusList');
  el.hidden = false;
  el.innerHTML = fileResults.map(f => {
    const status = !f.ok ? 'error' : (f.note ? 'warn' : 'ok');
    const icon = status === 'error' ? '✕' : status === 'warn' ? '⚠' : '✓';
    return `
      <div class="file-status-row status-${status}">
        <span class="ficon">${icon}</span>
        <span class="fname">${escapeHtml(f.file)}</span>
        <span class="fkind">${KIND_LABEL[f.kind] || f.kind}${f.rows.length ? ` · ${fmtInt(f.rows.length)} รายการ` : ''}${f.note ? ' · ' + escapeHtml(f.note) : ''}</span>
      </div>`;
  }).join('');
}

// ---------- Editable review table: shared by OCR-image results and multi-file batch results ----------

function renderOcrStationTable(stations) {
  document.getElementById('ocrStationTableBody').innerHTML = stations.map(s => `
    <tr class="${s.qtyMatches === false ? 'ocr-row-mismatch' : ''}">
      <td>${escapeHtml(s.name)}</td>
      <td>${fmtInt(s.itemCount)}</td>
      <td>${fmtNum(s.weight)}</td>
      <td>${s.freight == null ? '-' : fmtNum(s.freight)}</td>
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
  itBody.innerHTML = data.rows.map(r => {
    const editedCls = f => isFieldEdited(r, f) ? ' ocr-field-edited' : '';
    const editedTitle = f => isFieldEdited(r, f) ? `title="ค่าเดิม: ${escapeHtml(formatAuditValue(f, r.original[f]))}"` : '';
    return `
    <tr data-row-id="${r.id}">
      <td>${escapeHtml(r.sourceFile) || '<span class="hint">-</span>'}</td>
      <td>${escapeHtml(r.origin) || '<span class="hint">-</span>'}</td>
      <td>
        <select class="ocr-field${editedCls('stationName')}" data-field="stationName" ${editedTitle('stationName')}>
          ${stationNames.map(n => `<option value="${escapeHtml(n)}" ${n === r.station.name ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
        </select>
      </td>
      <td>${escapeHtml(r.trackingNo) || '<span class="hint">-</span>'}</td>
      <td>${escapeHtml(r.name)}</td>
      <td><input class="ocr-field${editedCls('weight')}" data-field="weight" type="number" step="0.01" min="0" value="${r.weight}" ${editedTitle('weight')}></td>
      <td><input class="ocr-field${editedCls('qty')}" data-field="qty" type="number" step="1" min="0" value="${r.qty}" ${editedTitle('qty')}></td>
      <td><input class="ocr-field${editedCls('isVehicle')}" data-field="isVehicle" type="checkbox" ${r.isVehicle ? 'checked' : ''} ${editedTitle('isVehicle')}></td>
      <td><button type="button" class="ocr-del-btn" data-del="${r.id}" title="ลบรายการนี้">✕</button></td>
    </tr>`;
  }).join('');
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
  // buildOcrResult() always returns a fresh object (printedTotal: null,
  // no fileResults) — carry over the fields it doesn't know about so a
  // single manifest PDF's exact-match check keeps re-verifying after edits
  const { printedTotal, fileResults } = ocrState;
  ocrState = buildOcrResult(ocrState.meta, [...byName.values()], ocrState.rows, ocrState.source);
  ocrState.printedTotal = printedTotal;
  ocrState.fileResults = fileResults;
  renderHeadlineAndVerify(ocrState);
  renderOcrStationTable(ocrState.stations);
  fillSlip(ocrState);
}

function updateFieldEditedMark(el, row, field) {
  const edited = isFieldEdited(row, field);
  el.classList.toggle('ocr-field-edited', edited);
  el.title = edited ? `ค่าเดิม: ${formatAuditValue(field, row.original[field])}` : '';
}

function handleOcrFieldChange(e) {
  const field = e.target.dataset.field;
  if (!field || !ocrState) return;
  const tr = e.target.closest('tr');
  const row = ocrState.rows.find(r => r.id === Number(tr.dataset.rowId));
  if (!row) return;
  markOriginal(row);
  if (field === 'weight') row.weight = toNum(e.target.value) || 0;
  else if (field === 'qty') row.qty = parseInt(e.target.value, 10) || 0;
  else if (field === 'isVehicle') row.isVehicle = e.target.checked;
  else if (field === 'stationName') {
    const bucket = ocrState.rows.map(r => r.station).find(s => s.name === e.target.value);
    row.station = bucket || { name: e.target.value, printedQty: null, rows: [] };
  }
  updateFieldEditedMark(e.target, row, field);
  recomputeOcrRows();
}
document.getElementById('ocrItemTableBody').addEventListener('input', handleOcrFieldChange);
document.getElementById('ocrItemTableBody').addEventListener('change', (e) => {
  if (e.target.tagName === 'SELECT') handleOcrFieldChange(e);
});

// บันทึกประวัติการแก้ไขครั้งเดียวต่อ "รอบแก้ไข" (โฟกัส -> พิมพ์ -> ออกจากช่อง)
// ไม่ใช่ทุกครั้งที่กดคีย์ เพื่อไม่ให้ log รกจากการพิมพ์ทีละตัวอักษร
document.getElementById('ocrItemTableBody').addEventListener('focusin', (e) => {
  if (!e.target.matches('.ocr-field')) return;
  e.target.dataset.beforeValue = e.target.type === 'checkbox' ? String(e.target.checked) : e.target.value;
});
document.getElementById('ocrItemTableBody').addEventListener('change', (e) => {
  if (!e.target.matches('.ocr-field')) return;
  const field = e.target.dataset.field;
  const tr = e.target.closest('tr');
  const row = ocrState && ocrState.rows.find(r => r.id === Number(tr.dataset.rowId));
  const before = e.target.dataset.beforeValue;
  if (!row || !field || before === undefined) return;
  const after = e.target.type === 'checkbox' ? String(e.target.checked) : e.target.value;
  if (before !== after) {
    const fromVal = field === 'weight' ? toNum(before)
      : field === 'qty' ? parseInt(before, 10)
      : field === 'isVehicle' ? before === 'true'
      : before;
    const toVal = field === 'weight' ? row.weight
      : field === 'qty' ? row.qty
      : field === 'isVehicle' ? row.isVehicle
      : row.station.name;
    logAudit('edit', row, field, fromVal, toVal);
  }
  delete e.target.dataset.beforeValue;
});

document.getElementById('ocrItemTableBody').addEventListener('click', (e) => {
  const delId = e.target.dataset.del;
  if (delId === undefined || !ocrState) return;
  const row = ocrState.rows.find(r => r.id === Number(delId));
  if (row) logAudit('delete', row, null, null, null);
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
  const newRow = {
    id: maxId + 1, sourceFile: '(เพิ่มเอง)', rowSource: 'manual', trackingNo: '',
    name: '(รายการใหม่)', weight: 0, qty: 1, unit: '', freight: null, origin: '', isVehicle: false, station: bucket,
  };
  markOriginal(newRow);
  ocrState.rows.push(newRow);
  logAudit('add', newRow, null, null, null);
  recomputeOcrRows();
  renderOcrItemTable(ocrState);
});

// จัดกลุ่มแถวตามคู่ "ต้นทาง-ปลายทาง" (ต่างจาก stations[] ที่จัดกลุ่มตามปลายทางอย่างเดียว)
// ใช้เฉพาะตอนพิมพ์สลิปที่มีต้นทางหลายแห่งปนกัน เพื่อไม่ให้ยอดจากคนละต้นทางไปรวมกันในแถวเดียว
function summarizeRowsByOriginDest(rows) {
  const map = new Map();
  for (const r of rows) {
    const origin = r.origin || 'ไม่ระบุต้นทาง';
    const key = origin + ' ' + r.station.name;
    if (!map.has(key)) map.set(key, { origin, name: r.station.name, weight: 0, freight: 0, freightCount: 0, qty: 0 });
    const b = map.get(key);
    b.weight += r.weight || 0;
    if (r.freight != null) { b.freight += r.freight; b.freightCount++; }
    b.qty += r.qty || 0;
  }
  return [...map.values()].map(b => ({ ...b, freight: b.freightCount ? b.freight : null }));
}

// ---------- Audit trail: tracks every correction made in the editable review table ----------

// บันทึกค่าดั้งเดิมของแถว (ครั้งแรกที่เห็นแถวนี้เท่านั้น) ไว้เทียบว่ามีการแก้ไขหรือยัง
function markOriginal(row) {
  if (!row.original) {
    row.original = { weight: row.weight, qty: row.qty, isVehicle: row.isVehicle, stationName: row.station.name };
  }
}

function isFieldEdited(row, field) {
  if (!row.original) return false;
  if (field === 'weight') return Math.abs(row.weight - row.original.weight) > 1e-9;
  if (field === 'qty') return row.qty !== row.original.qty;
  if (field === 'isVehicle') return row.isVehicle !== row.original.isVehicle;
  if (field === 'stationName') return row.station.name !== row.original.stationName;
  return false;
}

function rowLabelFor(row) {
  return `${row.sourceFile || ''} ${row.trackingNo || row.name || ''}`.trim();
}

let auditLog = [];

const AUDIT_ACTION_LABEL = { edit: 'แก้ไข', delete: 'ลบ', add: 'เพิ่ม' };
const AUDIT_FIELD_LABEL = { weight: 'น้ำหนัก', qty: 'จำนวน', isVehicle: 'ยานพาหนะ', stationName: 'สถานี' };

function formatAuditValue(field, value) {
  if (field === 'weight') return `${fmtNum(value)} กก.`;
  if (field === 'qty') return fmtInt(value);
  if (field === 'isVehicle') return value ? 'เป็นยานพาหนะ' : 'ไม่ใช่ยานพาหนะ';
  return escapeHtml(value ?? '');
}

function logAudit(action, row, field, fromValue, toValue) {
  auditLog.push({ time: new Date(), action, field, rowLabel: rowLabelFor(row), from: fromValue, to: toValue });
  renderAuditLog();
}

function renderAuditLog() {
  const section = document.getElementById('auditLogSection');
  if (!auditLog.length) { section.hidden = true; return; }
  section.hidden = false;
  document.getElementById('auditLogTableBody').innerHTML = auditLog.slice().reverse().map(e => {
    let change;
    if (e.action === 'delete') change = 'ลบรายการนี้ออกจากตาราง';
    else if (e.action === 'add') change = 'เพิ่มรายการใหม่ด้วยตนเอง';
    else change = `${escapeHtml(AUDIT_FIELD_LABEL[e.field] || e.field)}: ${formatAuditValue(e.field, e.from)}<span class="audit-arrow">→</span>${formatAuditValue(e.field, e.to)}`;
    return `
      <tr>
        <td>${e.time.toLocaleTimeString('th-TH')}</td>
        <td>${AUDIT_ACTION_LABEL[e.action] || e.action}</td>
        <td>${escapeHtml(e.rowLabel)}</td>
        <td>${change}</td>
      </tr>`;
  }).join('');
}

function fillSlip(data) {
  const { meta, totals, stations, rows } = data;
  document.getElementById('slipTrain').textContent = `ขบวน ${meta.train || '-'}`;

  // ต้นทาง: เอกสารเดียวมีต้นทางเดียวเสมอ แต่การรวมหลายไฟล์อาจมีหลายต้นทางปนกันได้
  const origins = [...new Set(rows.map(r => r.origin).filter(Boolean))];
  const slipOriginEl = document.getElementById('slipOrigin');
  if (origins.length === 0) {
    slipOriginEl.hidden = true;
  } else {
    slipOriginEl.hidden = false;
    slipOriginEl.textContent = origins.length <= 3
      ? `ต้นทาง: ${origins.join(', ')}`
      : `ต้นทาง: หลายสถานี (${origins.length} แห่ง)`;
  }

  document.getElementById('slipDate').textContent =
    meta.rideDate ? `วันที่ขึ้นขบวนรถ ${meta.rideDate}` : '';
  document.getElementById('slipWeight').textContent = `${fmtNum(totals.weight)} กก.`;
  document.getElementById('slipFreight').textContent =
    totals.freight == null ? 'ไม่มีข้อมูล' : `${fmtNum(totals.freight)} บาท`;
  document.getElementById('slipPieces').textContent = `${fmtInt(totals.totalGoodsPieces)} ชิ้น/หน่วย`;
  document.getElementById('slipBreakdown').textContent = breakdownText(totals.goodsUnitCounts);
  document.getElementById('slipVehicles').textContent = `${fmtInt(totals.vehicleCount)} คัน`;
  document.getElementById('slipParcelCount').textContent = fmtInt(totals.parcelCount);

  // เมื่อมีต้นทางมากกว่า 1 แห่งปนกัน (เช่น รวมหลายใบส่งของ) การจัดกลุ่มตามปลายทาง
  // อย่างเดียวจะรวมพัสดุจากคนละต้นทางเข้าเป็นแถวเดียว ซ่อนว่าแต่ละส่วนมาจากไหน —
  // ในกรณีนี้จึงจัดกลุ่มตามคู่ต้นทาง-ปลายทางแทน เพื่อให้เห็นต้นทางของแต่ละแถว
  const multiOrigin = origins.length > 1;
  const slipRows = multiOrigin ? summarizeRowsByOriginDest(rows) : stations;

  document.getElementById('slipStationSubtitle').textContent =
    multiOrigin ? 'สรุปแยกตามต้นทาง-ปลายทาง' : 'สรุปแยกตามสถานี';

  const table = document.getElementById('slipStationTable');
  const rowsHtml = slipRows.map(s => `
    <tr>
      ${multiOrigin ? `<td class="name">${escapeHtml(s.origin)}</td>` : `<td class="code">${escapeHtml(s.code || '')}</td>`}
      <td class="name">${escapeHtml(s.name)}</td>
      <td class="num">${fmtNum(s.weight)}</td>
      <td class="num">${fmtInt(s.qty)}</td>
      <td class="num">${s.freight == null ? '-' : fmtNum(s.freight)}</td>
    </tr>`).join('');
  table.innerHTML = `
    <thead><tr>${multiOrigin ? '<th class="name">ต้นทาง</th>' : '<th class="code">รหัส</th>'}<th class="name">ปลายทาง</th><th class="num">กก.</th><th class="num">จำนวน</th><th class="num">บาท</th></tr></thead>
    <tbody>${rowsHtml}</tbody>`;

  const editNote = auditLog.length
    ? `แก้ไขด้วยตนเอง ${fmtInt(auditLog.length)} รายการ · `
    : (data.fileResults && data.fileResults.length > 1 ? 'รวมจากหลายไฟล์ · ' : '');
  document.getElementById('slipFooter').textContent =
    editNote + 'พิมพ์เมื่อ ' + new Date().toLocaleString('th-TH');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
