/**
 * Legrand Partner Klub - Hűségprogram automatizálás
 * ===================================================
 * Ez a script egy erre a célra létrehozott Google Sheethez van kötve
 * ("bound script"). Beolvassa a Forminatorból hetente exportált
 * CSV fájlokat, AI-val kiolvassa a feltöltött számlákat, párosítja
 * a Legrand árlistával, kiszámolja az ajándék-szinteket, és hetente
 * egy összefoglaló emailt küld.
 *
 * Lásd README.md a telepítési lépésekhez.
 */

// ---------------------------------------------------------------------------
// BEÁLLÍTÁSOK
// ---------------------------------------------------------------------------

const SHEET_RAW_INVOICES = 'Raw_Szamlak';
const SHEET_RAW_REGISTRATIONS = 'Raw_Regisztraciok';
const SHEET_PROCESSED = 'Feldolgozott_Szamlak';
const SHEET_PRICELIST = 'Arlista';
const SHEET_WEEKLY_LOG = 'Heti_Osszesito';

// Ezeket a Script Properties-ben kell beállítani (soha ne kerüljenek kódba
// vagy a Sheetbe!): Project Settings > Script Properties.
//   DRIVE_INBOX_FOLDER_ID   - ide töltöd fel a heti Forminator CSV exportokat
//   DRIVE_ARCHIVE_FOLDER_ID - ide kerülnek a már feldolgozott CSV-k
//   GEMINI_API_KEY          - ingyenes kulcs: https://aistudio.google.com/app/apikey
//   REPORT_EMAILS           - vesszővel elválasztott email címek a heti riporthoz

const PROPS = PropertiesService.getScriptProperties();

// Ajándék-szintek 2026.05.01 - 2026.08.31 között (a kapott táblázat alapján).
// A "felett" szó szerint értendő: a küszöbérték FÖLÖTT jogosult a szintre.
// FONTOS: erősítsd meg Legranddal, hogy ez éles (>) vagy záró (>=) határ-e,
// és minden szezonváltáskor frissítsd ezt a listát.
const GIFT_TIERS = [
  {
    thresholdHuf: 500000,
    label: '500.000 Ft felett',
    options: [
      { sap: 'LG-753120', name: 'Valena Life 2P+F csatlakozóaljzat biztonsági zsaluval', pieces: 30 },
      { sap: 'LG-367915', name: 'Legrand 2 vezetékes EASYKIT Essential videó kaputelefon', pieces: 1 },
    ],
  },
  {
    thresholdHuf: 400000,
    label: '400.000 Ft felett',
    options: [
      { sap: 'LG-721120', name: 'Suno 2P+F csatlakozóaljzat (rugós), biztonsági zsaluval, fehér', pieces: 20 },
      { sap: 'LG-863120B', name: 'Niloé Step 2P+F csatlakozóaljzat (rugós), biztonsági zsaluval, fehér', pieces: 40 },
      { sap: 'LG-310186', name: 'LEGRAND KEOR SP szünetmentes torony 1000VA', pieces: 1 },
    ],
  },
  {
    thresholdHuf: 200000,
    label: '200.000 Ft felett',
    options: [
      { sap: 'LG-694595', name: 'Elosztóállomás TV-hez 4x2P+F + 4x2P, 6A, túlfeszültség-védelemmel', pieces: 1 },
    ],
  },
];

// Ha az AI által kiolvasott Legrand-érték ennyivel (vagy ennél jobban) eltér
// attól, amit a feltöltő maga beírt, a számlát kézi ellenőrzésre jelöljük.
const REVIEW_DISCREPANCY_RATIO = 0.15;

// Egy futtatás legfeljebb ennyi új számlát dolgoz fel (Apps Script 6 perces
// futásidő-korlátja miatt). A trigger 15-30 percenként fut, úgyhogy néhány
// futás alatt minden lefeldolgozódik.
const BATCH_LIMIT = 15;

// ---------------------------------------------------------------------------
// EGYSZERI BEÁLLÍTÁS
// ---------------------------------------------------------------------------

/**
 * Futtasd EGYSZER kézzel a szerkesztőből, mielőtt bármi mást elindítanál.
 * Létrehozza a hiányzó lapokat és fejléceket.
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  ensureSheet_(ss, SHEET_RAW_INVOICES, [
    'import_kulcs', 'submission_time', 'tag_neve', 'email', 'telefonszam',
    'szamlaszam', 'szamla_kelte', 'brutto_osszeg_raw', 'legrand_osszeg_raw',
    'uzlet', 'utca', 'varos', 'irsz', 'fajl_urlek', 'importalva',
  ]);

  ensureSheet_(ss, SHEET_RAW_REGISTRATIONS, [
    'import_kulcs', 'regisztracio_ideje', 'nev', 'email', 'egyeb_adat', 'importalva',
  ]);

  ensureSheet_(ss, SHEET_PROCESSED, [
    'import_kulcs', 'submission_time', 'tag_neve', 'email', 'szamlaszam',
    'szamla_kelte', 'brutto_osszeg_raw', 'legrand_osszeg_sajat_bevallas',
    'legrand_ertek_ai', 'ai_talalt_tetelek_json', 'nem_azonositott_tetelek',
    'ajandek_szint', 'kezi_ellenorzes_szukseges', 'ellenorzes_oka',
    'feldolgozva_ekkor',
  ]);

  ensureSheet_(ss, SHEET_WEEKLY_LOG, [
    'idoszak_kezdete', 'idoszak_vege', 'egyedi_feltoltok', 'uj_szamlak',
    'osszes_brutto', 'osszes_legrand_ertek', '200k_szint', '400k_szint',
    '500k_szint', 'kezi_ellenorzest_igenylo', 'uj_regisztraciok', 'kikuldve',
  ]);

  // Az Arlista fület NEM ez a script tölti fel: importáld a
  // pricelist/legrand_pricelist_2026-03-18.csv fájlt File > Import >
  // "Insert new sheet(s)" -> nevezd át "Arlista"-ra (lásd README).
  if (!ss.getSheetByName(SHEET_PRICELIST)) {
    SpreadsheetApp.getUi().alert(
      'Ne felejtsd el importálni az árlistát az "' + SHEET_PRICELIST + '" nevű fülre! Lásd README.md.'
    );
  }

  SpreadsheetApp.getUi().alert('Kész. Most állítsd be a Script Properties-t (lásd README), majd futtasd a createTriggers() függvényt.');
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
}

/**
 * Futtasd EGYSZER, miután setupSheets() lefutott és a Script Properties be
 * van állítva. Létrehozza az időzített triggereket.
 */
function createTriggers() {
  deleteAllTriggers_();
  ScriptApp.newTrigger('importAndProcess').timeBased().everyHours(2).create();
  ScriptApp.newTrigger('weeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  Logger.log('Triggerek létrehozva.');
}

function deleteAllTriggers_() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
}

// ---------------------------------------------------------------------------
// FŐ BELÉPÉSI PONT (a 2 órás trigger ezt hívja)
// ---------------------------------------------------------------------------

function importAndProcess() {
  importNewCsvExports();
  processNewInvoices();
}

// ---------------------------------------------------------------------------
// 1. LÉPÉS: CSV EXPORTOK BEOLVASÁSA A DRIVE MAPPÁBÓL
// ---------------------------------------------------------------------------

/**
 * A DRIVE_INBOX_FOLDER_ID mappában lévő .csv fájlokat dolgozza fel.
 * Fájlnév alapján dönti el, hogy számla- vagy regisztráció-export-e:
 *   - a "szamla" vagy "invoice" szót tartalmazó fájlnév -> Raw_Szamlak
 *   - a "regisztr" vagy "registration" szót tartalmazó fájlnév -> Raw_Regisztraciok
 * A Forminator export MINDIG az összes eddigi beküldést tartalmazza, ezért
 * minden sorhoz egyedi kulcsot képzünk és csak az újakat vesszük fel.
 * A feldolgozott fájlt átmozgatja az archívum mappába, hogy ne dolgozzuk
 * fel kétszer.
 */
function importNewCsvExports() {
  const inboxId = PROPS.getProperty('DRIVE_INBOX_FOLDER_ID');
  const archiveId = PROPS.getProperty('DRIVE_ARCHIVE_FOLDER_ID');
  if (!inboxId || !archiveId) {
    throw new Error('Állítsd be a DRIVE_INBOX_FOLDER_ID és DRIVE_ARCHIVE_FOLDER_ID Script Property-ket.');
  }
  const inbox = DriveApp.getFolderById(inboxId);
  const archive = DriveApp.getFolderById(archiveId);
  const files = inbox.getFilesByType(MimeType.CSV);

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName().toLowerCase();
    const csvText = file.getBlob().getDataAsString('UTF-8');
    const rows = Utilities.parseCsv(csvText);
    if (rows.length < 2) {
      file.moveTo(archive);
      continue;
    }

    if (name.indexOf('regisztr') !== -1 || name.indexOf('registration') !== -1) {
      importRegistrationRows_(rows);
    } else {
      importInvoiceRows_(rows);
    }
    file.moveTo(archive);
  }
}

/**
 * A Forminator számla-export oszlopai (lásd a mintaexportot):
 * Submission Time, Legrand Partner Klub tag neve, E-mail cím, Telefonszám,
 * Számlaszám, Számla kelte, Bruttó összeg, Összeg (Legrand termékek),
 * Melyik üzletben vásárolt?, Address - Utca/Város/Irányítószám, Upload
 *
 * Ha a form mezőit átnevezik/átrendezik a WordPress oldalon, ezt a
 * COLUMN indexet kell frissíteni.
 */
function importInvoiceRows_(rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_RAW_INVOICES);
  const existingKeys = getExistingKeys_(sheet);

  const header = rows[0];
  const col = indexHeaders_(header, {
    submission_time: 'Submission Time',
    tag_neve: 'Legrand Partner Klub tag neve',
    email: 'E-mail cím',
    telefonszam: 'Telefonszám',
    szamlaszam: 'Számlaszám',
    szamla_kelte: 'Számla kelte',
    brutto: 'Bruttó összeg',
    legrand_osszeg: 'Összeg (Legrand termékek)',
    uzlet: 'Melyik üzletben vásárolt?',
    utca: 'Address - Utca, Házszám',
    varos: 'Address - Város',
    irsz: 'Address - Irányítószám',
    upload: 'Upload',
  });

  const newRows = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const key = buildKey_([r[col.szamlaszam], r[col.email], r[col.upload]]);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    newRows.push([
      key, r[col.submission_time], r[col.tag_neve], r[col.email], r[col.telefonszam],
      r[col.szamlaszam], r[col.szamla_kelte], r[col.brutto], r[col.legrand_osszeg],
      r[col.uzlet], r[col.utca], r[col.varos], r[col.irsz], r[col.upload],
      new Date(),
    ]);
  }
  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
  }
  Logger.log('Új számla-beküldés: ' + newRows.length);
}

/**
 * A regisztrációs export oszlopnevei form-specifikusak. Csak az első
 * (submission time), és a legvalószínűbb "email"/"név" oszlopokat várjuk
 * el pontos névvel; minden más oszlop nyersen bekerül az "egyeb_adat"
 * mezőbe JSON-ként. Igazítsd a COLUMN neveket, amikor megkapod a valódi
 * regisztrációs exportot.
 */
function importRegistrationRows_(rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_RAW_REGISTRATIONS);
  const existingKeys = getExistingKeys_(sheet);

  const header = rows[0];
  const timeIdx = findHeaderIndex_(header, ['Submission Time', 'Regisztráció ideje', 'Dátum']);
  const nameIdx = findHeaderIndex_(header, ['Név', 'Name', 'Teljes név']);
  const emailIdx = findHeaderIndex_(header, ['E-mail cím', 'Email', 'E-mail']);

  const newRows = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const key = buildKey_([r[emailIdx], r[timeIdx]]);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    newRows.push([key, r[timeIdx], r[nameIdx], r[emailIdx], JSON.stringify(r), new Date()]);
  }
  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
  }
  Logger.log('Új regisztráció: ' + newRows.length);
}

function buildKey_(parts) {
  return parts.map((p) => (p === undefined || p === null ? '' : String(p).trim())).join('||');
}

function getExistingKeys_(sheet) {
  const keys = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return keys;
  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  values.forEach((row) => keys.add(row[0]));
  return keys;
}

function indexHeaders_(header, mapping) {
  const result = {};
  Object.keys(mapping).forEach((key) => {
    const idx = header.indexOf(mapping[key]);
    result[key] = idx === -1 ? 0 : idx;
  });
  return result;
}

function findHeaderIndex_(header, candidates) {
  for (const c of candidates) {
    const idx = header.indexOf(c);
    if (idx !== -1) return idx;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 2. LÉPÉS: SZÁMLÁK FELDOLGOZÁSA AI-VAL
// ---------------------------------------------------------------------------

function processNewInvoices() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName(SHEET_RAW_INVOICES);
  const processedSheet = ss.getSheetByName(SHEET_PROCESSED);
  const processedKeys = getExistingKeys_(processedSheet);

  const lastRow = rawSheet.getLastRow();
  if (lastRow < 2) return;
  const rows = rawSheet.getRange(2, 1, lastRow - 1, rawSheet.getLastColumn()).getValues();

  const priceIndex = loadPriceListIndex_();
  let processedCount = 0;

  for (const r of rows) {
    if (processedCount >= BATCH_LIMIT) break;
    const key = r[0];
    if (processedKeys.has(key)) continue;

    const submissionTime = r[1];
    const tagNeve = r[2];
    const email = r[3];
    const szamlaszam = r[5];
    const szamlaKelte = r[6];
    const bruttoRaw = r[7];
    const legrandRaw = r[8];
    const fajlUrlek = String(r[13] || '').split(',').map((s) => s.trim()).filter(Boolean);

    if (fajlUrlek.length === 0) continue;

    let allLineItems = [];
    let extractionFailed = false;
    for (const url of fajlUrlek) {
      try {
        const items = extractInvoiceLineItems_(url);
        allLineItems = allLineItems.concat(items);
      } catch (e) {
        Logger.log('Kiolvasási hiba (' + url + '): ' + e);
        extractionFailed = true;
      }
    }

    const match = matchLineItemsToLegrand_(allLineItems, priceIndex);
    const selfReported = parseHufAmount_(legrandRaw);
    const discrepancy = selfReported !== null && match.legrandValue !== null
      ? Math.abs(match.legrandValue - selfReported) / Math.max(selfReported, 1)
      : null;

    const needsReview = extractionFailed
      || allLineItems.length === 0
      || match.unmatchedCount > 0
      || (discrepancy !== null && discrepancy > REVIEW_DISCREPANCY_RATIO);

    let reviewReason = [];
    if (extractionFailed) reviewReason.push('AI kiolvasás sikertelen');
    if (allLineItems.length === 0) reviewReason.push('nem sikerült tételeket kiolvasni');
    if (match.unmatchedCount > 0) reviewReason.push(match.unmatchedCount + ' tétel nem azonosítható a katalógusban');
    if (discrepancy !== null && discrepancy > REVIEW_DISCREPANCY_RATIO) {
      reviewReason.push('AI-érték (' + match.legrandValue + ' Ft) eltér a bevallott értéktől (' + selfReported + ' Ft)');
    }

    const tier = computeGiftTier_(match.legrandValue);

    processedSheet.appendRow([
      key, submissionTime, tagNeve, email, szamlaszam, szamlaKelte, bruttoRaw,
      selfReported, match.legrandValue, JSON.stringify(allLineItems),
      match.unmatchedCount, tier ? tier.label : '(nincs szint)', needsReview,
      reviewReason.join('; '), new Date(),
    ]);
    processedCount++;
  }

  Logger.log('Feldolgozott számlák ebben a futásban: ' + processedCount);
}

function parseHufAmount_(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  // Kezeli a "Bruttó: 312364 Ft", "12040,7", "41 502", "53578,7" formátumokat.
  const cleaned = String(raw).replace(/[^\d,.-]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : Math.round(num);
}

// ---------------------------------------------------------------------------
// AI KIOLVASÁS (Gemini)
// ---------------------------------------------------------------------------

/**
 * Letölti a számlát a megadott (publikus) URL-ről, és a Gemini API-val
 * strukturált tétel-listát kér ki belőle.
 * Ingyenes API kulcs: https://aistudio.google.com/app/apikey
 */
function extractInvoiceLineItems_(fileUrl) {
  const response = UrlFetchApp.fetch(fileUrl, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('Nem sikerült letölteni: ' + fileUrl + ' (HTTP ' + response.getResponseCode() + ')');
  }
  const blob = response.getBlob();
  const mimeType = blob.getContentType();

  // A .docx és más nem támogatott formátumokat kihagyjuk (jelöljük review-ra).
  const supported = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic'];
  if (supported.indexOf(mimeType) === -1) {
    throw new Error('Nem támogatott fájltípus feldolgozásra: ' + mimeType);
  }

  const apiKey = PROPS.getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Állítsd be a GEMINI_API_KEY Script Property-t.');

  const base64 = Utilities.base64Encode(blob.getBytes());
  const prompt = 'Ez egy magyar nyelvű számla (villamossági szaküzlet/nagyker számlája). ' +
    'Olvasd ki a számla összes tételét. Minden tételnél add meg: description (a tétel ' +
    'megnevezése/leírása pontosan ahogy a számlán szerepel), sku (cikkszám/termékkód, ha ' +
    'szerepel a számlán, egyébként üres string), quantity (mennyiség, szám), unit_price ' +
    '(nettó vagy bruttó egységár, szám), amount (a tétel végösszege Ft-ban, szám). ' +
    'Csak a tényleges termék/szolgáltatás sorokat vedd fel, az összesítő sorokat ' +
    '(részösszeg, ÁFA, végösszeg) ne. Válaszolj KIZÁRÓLAG egy JSON tömbbel, más szöveg ' +
    'nélkül. Ha egy értéket nem tudsz kiolvasni, használj null-t.';

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64 } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
    },
  };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey;
  const apiResponse = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (apiResponse.getResponseCode() !== 200) {
    throw new Error('Gemini API hiba: ' + apiResponse.getContentText());
  }

  const json = JSON.parse(apiResponse.getContentText());
  const text = json.candidates[0].content.parts[0].text;
  const items = JSON.parse(text);
  return Array.isArray(items) ? items : [];
}

// ---------------------------------------------------------------------------
// ÁRLISTA PÁROSÍTÁS
// ---------------------------------------------------------------------------

function loadPriceListIndex_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_PRICELIST);
  if (!sheet) throw new Error('Hiányzik az "' + SHEET_PRICELIST + '" fül. Importáld a pricelist/*.csv fájlt (lásd README).');
  const lastRow = sheet.getLastRow();
  const values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  return values.map((row) => ({
    sap: String(row[1] || '').toUpperCase(),
    name: String(row[2] || ''),
    normalizedName: normalizeText_(String(row[2] || '')),
    price: row[3],
    status: row[4],
  })).filter((p) => p.sap);
}

function normalizeText_(s) {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // ékezetek eltávolítása
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Minden sorra megpróbál Legrand-terméket azonosítani:
 *  1. Ha a sorban van "LG-xxxxx" mintájú kód, direkt katalógus-egyezés.
 *  2. Egyébként a leírás szó-átfedését nézi az árlista termékneveivel
 *     (egyszerű Jaccard-index), és a legjobb 0.5 feletti találatot fogadja el.
 * Ha egyik sem talál egyértelmű egyezést, a tétel "unmatched"-nek számít -
 * ez emberi ellenőrzést von maga után, NEM kerül automatikusan bele az
 * összegbe.
 */
function matchLineItemsToLegrand_(lineItems, priceIndex) {
  let legrandValue = 0;
  let unmatchedCount = 0;

  for (const item of lineItems) {
    const desc = String(item.description || '');
    const skuRaw = String(item.sku || '').toUpperCase();
    const amount = typeof item.amount === 'number' ? item.amount : parseHufAmount_(item.amount);

    let matched = null;

    const skuCandidate = (skuRaw.match(/LG-?\d{5,7}[A-Z]?/) || desc.match(/LG-?\d{5,7}[A-Z]?/))?.[0];
    if (skuCandidate) {
      const normalizedSku = skuCandidate.replace(/^LG-?/, 'LG-');
      matched = priceIndex.find((p) => p.sap === normalizedSku);
    }

    if (!matched) {
      const normalizedDesc = normalizeText_(desc);
      if (normalizedDesc.length > 3) {
        matched = bestFuzzyMatch_(normalizedDesc, priceIndex);
      }
    }

    if (matched && amount !== null) {
      legrandValue += amount;
    } else if (desc.toLowerCase().indexOf('legrand') !== -1) {
      // A leírás explicit "Legrand"-ot említ, de nem tudtuk katalógusra
      // párosítani -> mindenképp kézi ellenőrzés kell, ne becsüljünk.
      unmatchedCount++;
    }
    // Ha se SKU, se "legrand" szó, se névegyezés -> feltehetően nem
    // Legrand-termék, kihagyjuk, nem számít unmatched-nek.
  }

  return { legrandValue: Math.round(legrandValue), unmatchedCount };
}

function bestFuzzyMatch_(normalizedDesc, priceIndex) {
  const descTokens = new Set(normalizedDesc.split(' ').filter((t) => t.length > 2));
  if (descTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const p of priceIndex) {
    if (p.status && p.status.indexOf('Megsz') !== -1) continue; // megszűnt termék
    const nameTokens = new Set(p.normalizedName.split(' ').filter((t) => t.length > 2));
    if (nameTokens.size === 0) continue;
    let overlap = 0;
    descTokens.forEach((t) => { if (nameTokens.has(t)) overlap++; });
    const union = new Set([...descTokens, ...nameTokens]).size;
    const score = union === 0 ? 0 : overlap / union;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function computeGiftTier_(legrandValue) {
  if (legrandValue === null) return null;
  for (const tier of GIFT_TIERS) {
    if (legrandValue > tier.thresholdHuf) return tier;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. LÉPÉS: HETI ÖSSZESÍTŐ EMAIL
// ---------------------------------------------------------------------------

function weeklyDigest() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const processedSheet = ss.getSheetByName(SHEET_PROCESSED);
  const processedRows = readRowsSince_(processedSheet, 1, weekAgo); // col idx 1 = submission_time

  const regSheet = ss.getSheetByName(SHEET_RAW_REGISTRATIONS);
  const regRows = readRowsSince_(regSheet, 1, weekAgo);

  const uniqueUploaders = new Set(processedRows.map((r) => r[3])); // email
  let totalBrutto = 0;
  let totalLegrand = 0;
  const tierCounts = { '200.000 Ft felett': 0, '400.000 Ft felett': 0, '500.000 Ft felett': 0 };
  let reviewCount = 0;

  processedRows.forEach((r) => {
    totalBrutto += parseHufAmount_(r[6]) || 0;
    totalLegrand += Number(r[8]) || 0;
    const tierLabel = r[11];
    if (tierCounts.hasOwnProperty(tierLabel)) tierCounts[tierLabel]++;
    if (r[12] === true) reviewCount++;
  });

  const html = buildDigestHtml_({
    periodStart: weekAgo,
    periodEnd: now,
    uniqueUploaders: uniqueUploaders.size,
    invoiceCount: processedRows.length,
    totalBrutto,
    totalLegrand,
    tierCounts,
    reviewCount,
    newRegistrations: regRows.length,
  });

  const emails = (PROPS.getProperty('REPORT_EMAILS') || '').split(',').map((e) => e.trim()).filter(Boolean);
  if (emails.length === 0) throw new Error('Állítsd be a REPORT_EMAILS Script Property-t.');

  MailApp.sendEmail({
    to: emails.join(','),
    subject: 'Legrand Hűségprogram - heti állás (' + formatDate_(weekAgo) + ' - ' + formatDate_(now) + ')',
    htmlBody: html,
  });

  const logSheet = ss.getSheetByName(SHEET_WEEKLY_LOG);
  logSheet.appendRow([
    weekAgo, now, uniqueUploaders.size, processedRows.length, totalBrutto, totalLegrand,
    tierCounts['200.000 Ft felett'], tierCounts['400.000 Ft felett'], tierCounts['500.000 Ft felett'],
    reviewCount, regRows.length, new Date(),
  ]);
}

function readRowsSince_(sheet, dateColIdx, sinceDate) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  return values.filter((r) => {
    const d = r[dateColIdx];
    return d instanceof Date && d >= sinceDate;
  });
}

function buildDigestHtml_(d) {
  const fmtHuf = (n) => Math.round(n).toLocaleString('hu-HU') + ' Ft';
  return '' +
    '<h2>Legrand Hűségprogram – heti állás</h2>' +
    '<p>' + formatDate_(d.periodStart) + ' – ' + formatDate_(d.periodEnd) + '</p>' +
    '<ul>' +
    '<li><b>' + d.uniqueUploaders + '</b> egyedi feltöltő</li>' +
    '<li><b>' + d.invoiceCount + '</b> feldolgozott számla</li>' +
    '<li>Bruttó összeg összesen: <b>' + fmtHuf(d.totalBrutto) + '</b></li>' +
    '<li>Ebből Legrand-termék érték (AI szerint): <b>' + fmtHuf(d.totalLegrand) + '</b></li>' +
    '<li><b>' + d.newRegistrations + '</b> új regisztráció</li>' +
    '<li style="color:' + (d.reviewCount > 0 ? '#b00' : '#080') + '">' +
    '<b>' + d.reviewCount + '</b> számla igényel kézi ellenőrzést (lásd "' + SHEET_PROCESSED + '" fül,' +
    ' kezi_ellenorzes_szukseges = TRUE)</li>' +
    '</ul>' +
    '<h3>Ajándék-szintek ezen a héten</h3>' +
    '<ul>' +
    '<li>200.000 Ft felett: ' + d.tierCounts['200.000 Ft felett'] + '</li>' +
    '<li>400.000 Ft felett: ' + d.tierCounts['400.000 Ft felett'] + '</li>' +
    '<li>500.000 Ft felett: ' + d.tierCounts['500.000 Ft felett'] + '</li>' +
    '</ul>' +
    '<p style="color:#888;font-size:12px">Automatikus üzenet – a részletes, számlánkénti adatok a ' +
    'Google Sheetben (' + SpreadsheetApp.getActiveSpreadsheet().getUrl() + ') érhetők el.</p>';
}

function formatDate_(d) {
  return Utilities.formatDate(d, 'Europe/Budapest', 'yyyy.MM.dd.');
}
