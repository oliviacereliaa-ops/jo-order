/**
 * JO Order API — paste into the order spreadsheet (Extensions → Apps Script).
 *
 * Script properties (Project Settings → Script properties):
 *   GEMINI_API_KEY  your free Gemini API key (aistudio.google.com/apikey)
 *   APP_PIN         any PIN you choose; the website must send the same PIN
 *
 * Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 */

const ORDER_SHEET = 'Order';
const PRODUCT_SHEET = 'Product Database';
const PO_PREFIX = 'JO';
const MODEL = 'gemini-3.8-flash';   // if Google retires it, change to the current Flash model
const TZ = 'Asia/Jakarta';
// Order-tab columns are found by header name, so columns can be moved or added.
const ORDER_HEADERS = {
  po: ['PO'], article: ['Article'], description: ['Description'], price: ['Price'], qty: ['Qty'],
  value: ['Value'], category: ['Category'], subCat: ['Sub Cat'], buyer: ['Buyer'], entry: ['Entry Date'],
  delivered: ['Actual Deliv Date', 'Actual Delivery Date', 'Delivery Date'],
  request: ['Request Date', 'Due Date'], notes: ['Notes']
};

function doGet() {
  return ContentService.createTextOutput('JO Order API is running.');
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    const pin = PropertiesService.getScriptProperties().getProperty('APP_PIN');
    if (!pin) throw new Error('APP_PIN is not set in Script properties.');
    if (String(req.pin || '') !== String(pin)) throw new Error('Wrong PIN.');

    if (req.action === 'init') {
      out = { ok: true, products: getProducts(), nextPo: nextPo() };
    } else if (req.action === 'parse') {
      out = Object.assign({ ok: true }, parseOrder(req.text, req.draft));
    } else if (req.action === 'submit') {
      out = Object.assign({ ok: true }, submitOrder(req.order));
    } else if (req.action === 'board') {
      out = { ok: true, cards: getBoard(), now: isoNow() };
    } else if (req.action === 'move') {
      out = { ok: true, card: moveCard(req.po, req.to, req.est), cards: getBoard(), now: isoNow() };
    } else if (req.action === 'setEst') {
      out = { ok: true, card: setEstimate(req.po, req.est), cards: getBoard(), now: isoNow() };
    } else {
      throw new Error('Unknown action.');
    }
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- reading ---------- */

function toNumber(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v || '').replace(/[^\d.,-]/g, '').replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function getProducts() {
  const sh = SpreadsheetApp.getActive().getSheetByName(PRODUCT_SHEET);
  if (!sh) throw new Error('Sheet "' + PRODUCT_SHEET + '" not found.');
  const values = sh.getDataRange().getValues();
  const head = values[0].map(h => String(h).trim().toLowerCase());
  const col = name => head.indexOf(name.toLowerCase());
  const c = {
    article: col('Article'), description: col('Description'), price: col('Price'),
    category: col('Category'), subCat: col('Sub Cat'), channel: col('Channel')
  };
  return values.slice(1)
    .filter(r => String(r[c.article]).trim() && String(r[c.description]).trim())
    .map(r => ({
      article: String(r[c.article]).trim(),
      description: String(r[c.description]).trim(),
      price: toNumber(r[c.price]),
      category: c.category >= 0 ? String(r[c.category]).trim() : '',
      subCat: c.subCat >= 0 ? String(r[c.subCat]).trim() : '',
      channel: c.channel >= 0 ? String(r[c.channel]).trim() : ''
    }));
}

function getOrderSheet() {
  const sh = SpreadsheetApp.getActive().getSheetByName(ORDER_SHEET);
  if (!sh) throw new Error('Sheet "' + ORDER_SHEET + '" not found.');
  const top = sh.getRange(1, 1, Math.min(10, sh.getMaxRows()), 1).getValues();
  let headerRow = top.findIndex(r => String(r[0]).trim().toUpperCase() === 'PO') + 1;
  if (headerRow < 1) headerRow = 1;
  const width = sh.getLastColumn();
  const head = sh.getRange(headerRow, 1, 1, width).getValues()[0].map(h => String(h).trim().toLowerCase());
  const col = {};   // 0-based index per field, -1 if missing
  Object.keys(ORDER_HEADERS).forEach(k => {
    col[k] = -1;
    ORDER_HEADERS[k].some(name => (col[k] = head.indexOf(name.toLowerCase())) >= 0);
  });
  ['po', 'article', 'description', 'price', 'qty'].forEach(k => {
    if (col[k] < 0) throw new Error('Order tab: column "' + ORDER_HEADERS[k][0] + '" not found in the header row.');
  });
  return { sh, headerRow, col, width };
}

function colLetter(i) {   // 0-based index -> A, B, ... AA
  let s = '', n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** All Order-tab data rows as { rowNum, r } with r = raw row values. */
function orderData() {
  const o = getOrderSheet();
  const last = o.sh.getLastRow();
  o.data = last <= o.headerRow ? [] :
    o.sh.getRange(o.headerRow + 1, 1, last - o.headerRow, o.width).getValues()
      .map((r, i) => ({ rowNum: o.headerRow + 1 + i, r }));
  o.get = (r, k) => o.col[k] >= 0 ? r[o.col[k]] : '';
  return o;
}

function existingPos() {
  const o = orderData();
  return o.data.map(({ r }) => String(o.get(r, 'po')).trim()).filter(Boolean);
}

/** Next PO = highest existing JO number + 1 (JO260906 → JO260907). */
function nextPo() {
  const re = new RegExp('^' + PO_PREFIX + '(\\d+)$', 'i');
  let best = null;
  existingPos().forEach(po => {
    const m = po.match(re);
    if (m && (!best || Number(m[1]) > Number(best))) best = m[1];
  });
  if (!best) return PO_PREFIX + Utilities.formatDate(new Date(), TZ, 'yyMM') + '01';
  return PO_PREFIX + String(Number(best) + 1).padStart(best.length, '0');
}

/* ---------- parsing with Gemini ---------- */

const ORDER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING', description: 'One or two short sentences to the user, in the language they wrote in. Mention anything missing or guessed.' },
    buyer: { type: 'STRING', description: 'Buyer/customer, e.g. "Offline", "REXUS", a person or company name.' },
    entryDate: { type: 'STRING', description: 'YYYY-MM-DD. Default today.' },
    deliveryDate: { type: 'STRING', description: 'YYYY-MM-DD, or empty if not given.' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          article: { type: 'STRING', description: 'Article code from the catalog, or empty if no match.' },
          description: { type: 'STRING' },
          price: { type: 'NUMBER', description: 'Unit price in rupiah. Use the catalog price unless the user states another price.' },
          qty: { type: 'NUMBER' },
          notes: { type: 'STRING', description: 'Names or remarks for this line, e.g. "YOSIA, YOTAM".' }
        },
        required: ['article', 'description', 'price', 'qty', 'notes']
      }
    }
  },
  required: ['reply', 'buyer', 'entryDate', 'deliveryDate', 'items']
};

function parseOrder(text, draft) {
  if (!text || !String(text).trim()) throw new Error('Empty message.');
  const products = getProducts();
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd (EEEE)');
  const catalog = products.map(p =>
    `${p.article} | ${p.description} | Rp${p.price} | ${p.category} / ${p.subCat}`).join('\n');

  const system =
`You turn casual chat messages (English or Indonesian) into a sales order for a small product business.
Today is ${today} (Asia/Jakarta). Resolve relative dates ("besok", "Jumat", "tgl 20") to YYYY-MM-DD.
Match products to this catalog (article | description | price | category):
${catalog}

Rules:
- Each distinct product is one item. Quantities like "3 pcs", "x3", "3 biji" are qty.
- Names attached to an item (who it is for) go in that item's notes, comma-separated, uppercase.
- Price: use the catalog price unless the message states a price ("20rb", "@20.000", "20k" = 20000).
- "rb"/"k" = thousand, "jt" = million.
- If a product cannot be matched, keep it with article "" and describe it in description.
- If a current draft is given, the message is an edit to it: return the whole updated draft.
- Never invent a delivery date; leave it empty and say it is missing.
Answer only with JSON matching the schema.`;

  const user = (draft && draft.items && draft.items.length)
    ? 'Current draft:\n' + JSON.stringify(stripDraft(draft)) + '\n\nNew message:\n' + text
    : text;

  const result = callGemini(system, user);
  return { reply: result.reply || '', order: enrich(result, products) };
}

function stripDraft(d) {
  return {
    buyer: d.buyer, entryDate: d.entryDate, deliveryDate: d.deliveryDate,
    items: (d.items || []).map(i => ({ article: i.article, description: i.description, price: i.price, qty: i.qty, notes: i.notes }))
  };
}

function enrich(o, products) {
  const byArticle = {};
  products.forEach(p => byArticle[p.article.toUpperCase()] = p);
  const items = (o.items || []).map(i => {
    const p = byArticle[String(i.article || '').trim().toUpperCase()];
    const price = toNumber(i.price) || (p ? p.price : 0);
    return {
      article: p ? p.article : String(i.article || '').trim(),
      description: p ? p.description : String(i.description || '').trim(),
      price: price,
      qty: toNumber(i.qty) || 1,
      notes: String(i.notes || '').trim(),
      category: p ? p.category : '',
      subCat: p ? p.subCat : '',
      known: !!p
    };
  });
  return {
    buyer: String(o.buyer || '').trim(),
    entryDate: o.entryDate || Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'),
    deliveryDate: o.deliveryDate || '',
    items: items
  };
}

function callGemini(system, userText) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is not set in Script properties.');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: ORDER_SCHEMA,
      thinkingConfig: { thinkingLevel: 'low' }
    }
  });
  let res, body;
  for (let attempt = 0; attempt < 3; attempt++) {          // retry briefly on free-tier rate limits
    res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { 'x-goog-api-key': key }, muteHttpExceptions: true, payload: payload
    });
    if (res.getResponseCode() !== 429 && res.getResponseCode() !== 503) break;
    Utilities.sleep(1500 * (attempt + 1));
  }
  body = JSON.parse(res.getContentText());
  if (res.getResponseCode() === 400 && /thinking/i.test(res.getContentText())) {
    const p = JSON.parse(payload); delete p.generationConfig.thinkingConfig;
    res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
      headers: { 'x-goog-api-key': key }, muteHttpExceptions: true, payload: JSON.stringify(p) });
    body = JSON.parse(res.getContentText());
  }
  if (res.getResponseCode() !== 200) {
    const msg = (body.error && body.error.message) || res.getResponseCode();
    if (res.getResponseCode() === 429) throw new Error('Gemini free limit reached, wait a minute and try again.');
    throw new Error('Gemini API: ' + msg);
  }
  const cand = body.candidates && body.candidates[0];
  const text = cand && cand.content && cand.content.parts && cand.content.parts.map(p => p.text || '').join('');
  if (!text) throw new Error('Could not read the order. Try rephrasing.');
  try { return JSON.parse(text); }
  catch (e) { throw new Error('Could not read the order. Try rephrasing.'); }
}

/* ---------- writing ---------- */

function toDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : '';
}

function submitOrder(order) {
  if (!order || !order.items || !order.items.length) throw new Error('Order has no items.');
  const products = getProducts();
  const o = enrich(order, products);
  o.items.forEach((it, i) => {
    if (!it.description) throw new Error('Item ' + (i + 1) + ' has no product.');
    if (!(it.qty > 0)) throw new Error('Item ' + (i + 1) + ' has no quantity.');
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const taken = existingPos().map(p => p.toUpperCase());
    let po = String(order.po || '').trim().toUpperCase();
    if (!po || taken.indexOf(po) >= 0) po = nextPo();

    const { sh, col, width } = getOrderSheet();
    const start = sh.getLastRow() + 1;
    const rows = o.items.map((it, i) => {
      const row = new Array(width).fill('');
      const put = (k, v) => { if (col[k] >= 0) row[col[k]] = v; };
      put('po', po); put('article', it.article); put('description', it.description);
      put('price', it.price); put('qty', it.qty);
      put('category', it.category); put('subCat', it.subCat); put('buyer', o.buyer);
      put('entry', toDate(o.entryDate)); put('delivered', '');      // filled when delivered
      put('request', toDate(o.deliveryDate)); put('notes', it.notes);
      if (col.value >= 0) put('value', '=' + colLetter(col.price) + (start + i) + '*' + colLetter(col.qty) + (start + i));
      return row;
    });
    const target = sh.getRange(start, 1, rows.length, width);
    if (start - 1 > 1) sh.getRange(start - 1, 1, 1, width).copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    target.setValues(rows);
    ['entry', 'delivered', 'request'].forEach(k => {
      if (col[k] >= 0) sh.getRange(start, col[k] + 1, rows.length, 1).setNumberFormat('d mmm yyyy');
    });
    addToProduction(po, o);
    SpreadsheetApp.flush();

    return { po: po, rowsAdded: rows.length, order: o, nextPo: nextPo() };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- production board ---------- */

const PROD_SHEET = 'Production';
const LOG_SHEET = 'Production Log';
const STAGES = ['In Queue', 'On Production', 'Done', 'Delivered'];
const STAGE_COL = { 'In Queue': 'In Queue At', 'On Production': 'On Production At', 'Done': 'Done At', 'Delivered': 'Delivered At' };
const PROD_COLS = ['PO', 'Buyer', 'Items', 'Total Qty', 'Value', 'Due Date', 'Status', 'Est. Finish',
                   'In Queue At', 'On Production At', 'Done At', 'Delivered At', 'Last Update'];
const LOG_COLS = ['Timestamp', 'PO', 'From', 'To', 'Est. Finish'];
const TS_FMT = 'd mmm yyyy hh:mm';

function isoNow() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm"); }
function toIso(v) {
  return (v instanceof Date && !isNaN(v)) ? Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm") : '';
}
function parseLocal(s) {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (!m) return null;
  return Utilities.parseDate(m[1] + ' ' + (m[2] || '17:00'), TZ, 'yyyy-MM-dd HH:mm');
}

function ensureSheet(name, cols, formats) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    (formats || []).forEach(f => sh.getRange(2, f[0], sh.getMaxRows() - 1, 1).setNumberFormat(f[1]));
  }
  return sh;
}
function prodSheet() {
  return ensureSheet(PROD_SHEET, PROD_COLS,
    [[5, '#,##0'], [6, 'd mmm yyyy'], [8, TS_FMT], [9, TS_FMT], [10, TS_FMT], [11, TS_FMT], [12, TS_FMT], [13, TS_FMT]]);
}
function logSheet() { return ensureSheet(LOG_SHEET, LOG_COLS, [[1, TS_FMT], [5, TS_FMT]]); }

function addToProduction(po, o, note) {
  const sh = prodSheet();
  const now = new Date();
  const sm = summarize(o.items);
  sh.appendRow([po, o.buyer, sm.items, sm.qty, sm.value, toDate(o.deliveryDate), 'In Queue', '', now, '', '', '', now]);
  logSheet().appendRow([now, po, '', 'In Queue' + (note ? ' (' + note + ')' : ''), '']);
}

function prodRows() {
  const sh = prodSheet();
  const values = sh.getDataRange().getValues();
  const head = values[0].map(String);
  const old = head.indexOf('Delivery Date');
  if (head.indexOf('Due Date') < 0 && old >= 0) { sh.getRange(1, old + 1).setValue('Due Date'); head[old] = 'Due Date'; }
  const idx = {}; PROD_COLS.forEach(c => idx[c] = head.indexOf(c));
  return { sh, head, idx, rows: values.slice(1) };
}

/** Order lines grouped by PO (for card details). */
function orderLinesByPo(pos) {
  const want = {}; pos.forEach(p => want[p] = true);
  const o = orderData(), out = {};
  o.data.forEach(({ r }) => {
    const po = String(o.get(r, 'po')).trim().toUpperCase();
    if (!want[po]) return;
    (out[po] = out[po] || []).push({ article: String(o.get(r, 'article')), description: String(o.get(r, 'description')),
      qty: toNumber(o.get(r, 'qty')), notes: String(o.get(r, 'notes') || '') });
  });
  return out;
}

/** Order-tab rows grouped by PO. blank = some row of the PO has no Actual Deliv Date. */
function ordersByPo() {
  const o = orderData(), groups = {};
  o.data.forEach(({ rowNum, r }) => {
    const po = String(o.get(r, 'po')).trim().toUpperCase();
    if (!po) return;
    const g = groups[po] = groups[po] || { lines: [], rowNums: [], blank: false, delivered: '', request: '' };
    const line = {
      article: String(o.get(r, 'article')), description: String(o.get(r, 'description')),
      price: toNumber(o.get(r, 'price')), qty: toNumber(o.get(r, 'qty')),
      buyer: String(o.get(r, 'buyer') || ''), notes: String(o.get(r, 'notes') || '')
    };
    g.lines.push(line); g.rowNums.push(rowNum);
    const d = o.get(r, 'delivered');
    if (d === '' || d == null || String(d).trim() === '') g.blank = true;
    else if (!g.delivered) g.delivered = d;
    const rq = o.get(r, 'request');
    if (rq instanceof Date && !g.request) g.request = rq;
  });
  return { sh: o.sh, col: o.col, groups };
}

/**
 * Keeps the board in step with the Order tab:
 *  - a PO whose Delivery Date is blank gets a card (if it has none yet)
 *  - a PO whose Delivery Date was filled in by hand leaves the board as Delivered
 */
function syncFromOrders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const { groups } = ordersByPo();
    const p = prodRows();
    const onBoard = {};
    p.rows.forEach((r, i) => { const po = String(r[p.idx['PO']]).trim().toUpperCase(); if (po) onBoard[po] = i; });
    const now = new Date();
    Object.keys(groups).forEach(po => {
      const g = groups[po];
      if (g.blank && !(po in onBoard)) {
        addToProduction(po, { buyer: g.lines[0].buyer, deliveryDate: g.request ? toIso(g.request).slice(0, 10) : '', items: g.lines }, 'from sheet');
        return;
      }
      if (!(po in onBoard)) return;
      const i = onBoard[po], row = p.rows[i], rowNum = i + 2, st = String(row[p.idx['Status']]);
      if (st === 'Delivered') return;
      if (!g.blank) {                       // date typed into the Order tab by hand
        p.sh.getRange(rowNum, p.idx['Status'] + 1).setValue('Delivered');
        p.sh.getRange(rowNum, p.idx['Delivered At'] + 1).setValue(g.delivered instanceof Date ? g.delivered : now);
        p.sh.getRange(rowNum, p.idx['Last Update'] + 1).setValue(now);
        logSheet().appendRow([now, row[p.idx['PO']], st, 'Delivered (date entered in sheet)', '']);
        return;
      }
      // keep card details in step with edits made in the Order tab
      const s = summarize(g.lines);
      const want = { 'Buyer': g.lines[0].buyer, 'Items': s.items, 'Total Qty': s.qty, 'Value': s.value, 'Due Date': g.request || '' };
      Object.keys(want).forEach(k => {
        if (p.idx[k] < 0) return;
        const cur = row[p.idx[k]], v = want[k];
        const same = (cur instanceof Date && v instanceof Date) ? cur.getTime() === v.getTime() : String(cur) === String(v);
        if (!same) p.sh.getRange(rowNum, p.idx[k] + 1).setValue(v);
      });
    });
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
}

function summarize(items) {
  return {
    qty: items.reduce((s, i) => s + i.qty, 0),
    value: items.reduce((s, i) => s + i.qty * i.price, 0),
    items: items.map(i => i.article + ' ' + i.description + ' x' + i.qty + (i.notes ? ' (' + i.notes + ')' : '')).join('\n')
  };
}

/** Writes (or clears) the Delivery Date on every Order-tab row of this PO. */
function setOrderDeliveryDate(po, when) {
  const { sh, col, groups } = ordersByPo();
  const g = groups[String(po).trim().toUpperCase()];
  if (!g || col.delivered < 0) return;
  const day = when instanceof Date ? new Date(when.getFullYear(), when.getMonth(), when.getDate()) : '';
  g.rowNums.forEach(n => sh.getRange(n, col.delivered + 1).setValue(day).setNumberFormat('d mmm yyyy'));
}

function getBoard() {
  syncFromOrders();
  const { idx, rows } = prodRows();
  const active = rows.filter(r => String(r[idx['PO']]).trim() && STAGES.indexOf(String(r[idx['Status']])) >= 0
                                   && String(r[idx['Status']]) !== 'Delivered');
  const lines = orderLinesByPo(active.map(r => String(r[idx['PO']]).trim().toUpperCase()));
  return active.map(r => {
    const po = String(r[idx['PO']]).trim();
    return {
      po: po,
      buyer: String(r[idx['Buyer']] || ''),
      items: lines[po.toUpperCase()] || String(r[idx['Items']] || '').split('\n').filter(Boolean).map(t => ({ description: t, qty: '', article: '', notes: '' })),
      qty: toNumber(r[idx['Total Qty']]),
      value: toNumber(r[idx['Value']]),
      delivery: toIso(r[idx['Due Date']]).slice(0, 10),
      status: String(r[idx['Status']]),
      est: toIso(r[idx['Est. Finish']]),
      queuedAt: toIso(r[idx['In Queue At']]),
      startedAt: toIso(r[idx['On Production At']]),
      doneAt: toIso(r[idx['Done At']]),
      updatedAt: toIso(r[idx['Last Update']])
    };
  });
}

function findProdRow(po) {
  const p = prodRows();
  const key = String(po || '').trim().toUpperCase();
  const i = p.rows.findIndex(r => String(r[p.idx['PO']]).trim().toUpperCase() === key);
  if (i < 0) throw new Error('Order ' + po + ' is not on the production board.');
  return Object.assign(p, { rowNum: i + 2, row: p.rows[i] });
}

function moveCard(po, to, est) {
  if (STAGES.indexOf(to) < 0) throw new Error('Unknown stage: ' + to);
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const f = findProdRow(po);
    const from = String(f.row[f.idx['Status']]);
    const step = STAGES.indexOf(to) - STAGES.indexOf(from);
    if (step === 0) throw new Error(po + ' is already ' + to + '.');
    if (Math.abs(step) !== 1) throw new Error(po + ' is now ' + from + '. Refresh the board and try again.');
    const now = new Date();
    const set = (col, v) => f.sh.getRange(f.rowNum, f.idx[col] + 1).setValue(v);

    let estDate = f.row[f.idx['Est. Finish']];
    if (to === 'On Production') {
      const d = parseLocal(est);
      if (!d) throw new Error('Estimated finish time is required to start production.');
      set('Est. Finish', d); estDate = d;
    }
    set('Status', to);
    if (step > 0) set(STAGE_COL[to], now);      // moving forward: stamp the new stage
    else set(STAGE_COL[from], '');               // moving back: clear the stage we left
    set('Last Update', now);
    if (to === 'Delivered') setOrderDeliveryDate(f.row[f.idx['PO']], now);
    if (from === 'Delivered') setOrderDeliveryDate(f.row[f.idx['PO']], '');
    logSheet().appendRow([now, f.row[f.idx['PO']], from, to, estDate instanceof Date ? estDate : '']);
    SpreadsheetApp.flush();
    return { po: po, status: to };
  } finally { lock.releaseLock(); }
}

function setEstimate(po, est) {
  const d = parseLocal(est);
  if (!d) throw new Error('Pick a valid date and time.');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const f = findProdRow(po);
    const now = new Date();
    f.sh.getRange(f.rowNum, f.idx['Est. Finish'] + 1).setValue(d);
    f.sh.getRange(f.rowNum, f.idx['Last Update'] + 1).setValue(now);
    const st = String(f.row[f.idx['Status']]);
    logSheet().appendRow([now, f.row[f.idx['PO']], st, st + ' (new estimate)', d]);
    SpreadsheetApp.flush();
    return { po: po, est: toIso(d) };
  } finally { lock.releaseLock(); }
}

/* ---------- run this from the editor to diagnose ---------- */
function testSetup() {
  const props = PropertiesService.getScriptProperties();
  Logger.log('GEMINI_API_KEY set: ' + !!props.getProperty('GEMINI_API_KEY'));
  Logger.log('APP_PIN set: ' + !!props.getProperty('APP_PIN'));
  Logger.log('Products: ' + getProducts().length + ', next PO: ' + nextPo());
  const t = Date.now();
  const r = parseOrder('Claudio, cable magnet 1 pcs, kirim besok', null);
  Logger.log('Gemini answered in ' + ((Date.now() - t) / 1000).toFixed(1) + 's');
  Logger.log(JSON.stringify(r, null, 2));
}
