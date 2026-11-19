// Shared storage keys
const STORAGE_KEY_CLOUD_CFG = 'not_found_cloud_config';
const STORAGE_KEY_OPERATOR = 'not_found_operator_name';
const STORAGE_KEY_ACTIVE_MODE = 'not_found_active_mode';
const STORAGE_KEY_USERS = 'not_found_users';
const STORAGE_KEY_AUTH_SESSION = 'not_found_auth_session';

// Per-mode isolated configuration (Not Found vs Others)
const MODES = {
  not_found: {
    id: 'not_found',
    label: 'Not Found',
    shortCode: 'NF',
    subtitle: 'Specialized intake & physical box aggregation for uncataloged / not found books',
    printHeader: 'NOT FOUND · BOX TERMINAL',
    exportPrefix: 'NotFound',
    tableName: 'not_found_reboxes',
    rpcName: 'claim_next_rebox',
    realtimeChannel: 'not_found_reboxes_changes',
    storageRegistry: 'not_found_reboxes',
    storageCounter: 'not_found_rb_counter',
    storageActive: 'not_found_active_session'
  },
  others: {
    id: 'others',
    label: 'Others',
    shortCode: 'OT',
    subtitle: 'Specialized intake & physical box aggregation for other / miscellaneous books',
    printHeader: 'OTHERS · BOX TERMINAL',
    exportPrefix: 'Others',
    tableName: 'others_reboxes',
    rpcName: 'claim_next_others_rebox',
    realtimeChannel: 'others_reboxes_changes',
    storageRegistry: 'others_reboxes',
    storageCounter: 'others_rb_counter',
    storageActive: 'others_active_session'
  }
};

function getSavedActiveMode() {
  const saved = localStorage.getItem(STORAGE_KEY_ACTIVE_MODE);
  return saved && MODES[saved] ? saved : 'not_found';
}

let activeMode = getSavedActiveMode();

function getModeConfig(modeId = activeMode) {
  return MODES[modeId] || MODES.not_found;
}

// Box Numbering Normalizer: Always enforces BOX-XXXX format (strictly 4 digits with BOX- prefix)
function normalizeBoxNumber(val, fallbackNum = 1) {
  if (val === null || val === undefined) {
    return `BOX-${String(fallbackNum).padStart(4, '0')}`;
  }
  const str = String(val).trim();
  const match = str.match(/\d+/);
  if (match) {
    const num = parseInt(match[0], 10);
    return `BOX-${String(num).padStart(4, '0')}`;
  }
  return `BOX-${String(fallbackNum).padStart(4, '0')}`;
}

// State
let currentScannedBooks = [];
let currentAssignedRebox = null; // null if pending, string e.g. "BOX-0001" if closed
let currentOperatorName = localStorage.getItem(STORAGE_KEY_OPERATOR) || '';
let sortOrder = 'newest'; // 'newest' | 'oldest'
let cameraStream = null;
let cameraInterval = null;

// Multi-User Cloud Realtime State (Supabase)
let isCloudConnected = false;
let supabaseClient = null;
let supabaseRealtimeChannel = null;
let modeCloudReady = { not_found: true, others: true };

function updateModeChrome() {
  const cfg = getModeConfig();
  document.body.classList.toggle('mode-others', cfg.id === 'others');
  document.title = `${cfg.label} — Box Terminal`;

  const tabNotFound = document.getElementById('modeTabNotFound');
  const tabOthers = document.getElementById('modeTabOthers');
  if (tabNotFound) {
    const isNf = cfg.id === 'not_found';
    tabNotFound.classList.toggle('active', isNf);
    tabNotFound.setAttribute('aria-selected', String(isNf));
  }
  if (tabOthers) {
    const isOt = cfg.id === 'others';
    tabOthers.classList.toggle('active', isOt);
    tabOthers.setAttribute('aria-selected', String(isOt));
  }

  const brandLogo = document.getElementById('brandLogo');
  if (brandLogo) brandLogo.textContent = cfg.shortCode;
  const brandTitleText = document.getElementById('brandTitleText');
  if (brandTitleText) brandTitleText.textContent = cfg.label;
  const brandSubtitle = document.getElementById('brandSubtitle');
  if (brandSubtitle) brandSubtitle.textContent = cfg.subtitle;

  const tracerTitle = document.getElementById('tracerModalTitle');
  if (tracerTitle) tracerTitle.textContent = `Manager Item Tracer — ${cfg.label}`;
  const tracerDesc = document.getElementById('tracerModalDesc');
  if (tracerDesc) {
    tracerDesc.textContent = `Instantly trace any ${cfg.label} book by ISBN barcode or Book Title to discover its assigned Box number and closure timestamp.`;
  }
  const registryTitle = document.getElementById('registryModalTitle');
  if (registryTitle) registryTitle.textContent = `Master Box Registry — ${cfg.label}`;
  const importTitle = document.getElementById('importModalTitle');
  if (importTitle) importTitle.textContent = `Import Existing Sheet / Box List — ${cfg.label}`;
  const printHeader = document.getElementById('printLabelHeader');
  if (printHeader) printHeader.textContent = cfg.printHeader;
}

function switchMode(modeId) {
  if (!MODES[modeId] || modeId === activeMode) return;

  // Persist current mode's in-progress session before switching
  saveActiveSession(activeMode);

  // Switch active mode
  activeMode = modeId;
  localStorage.setItem(STORAGE_KEY_ACTIVE_MODE, activeMode);

  // Clear transient UI inputs
  const scannerInput = document.getElementById('barcodeScannerInput');
  if (scannerInput) scannerInput.value = '';
  const searchRbInput = document.getElementById('searchRbInput');
  if (searchRbInput) searchRbInput.value = '';
  const boxDropdown = document.getElementById('boxSelectDropdown');
  if (boxDropdown) boxDropdown.value = '';
  const regFilter = document.getElementById('registryFilterInput');
  if (regFilter) regFilter.value = '';
  window._currentInspectBox = null;
  pendingDuplicateParsed = null;
  closeModal('duplicateIsbnModal');

  // Load new mode's isolated session and registry state
  loadSavedActiveSession(activeMode);
  const reg = getStoredRegistry(activeMode);
  if (reg.length === 0) {
    localStorage.setItem(getModeConfig(activeMode).storageCounter, '0');
  }

  updateModeChrome();
  updateUiState();
  updateReboxCountStat();
  setCloudStatus(isCloudConnected);

  if (isCloudConnected && supabaseClient) {
    fetchAndSyncSupabaseRegistry(activeMode);
  }

  if (document.getElementById('registryModal')?.classList.contains('active')) {
    renderMasterRegistry();
  }

  if (scannerInput) scannerInput.focus();
  showToast(`Switched to ${getModeConfig().label} terminal.`);
}

// Load state on startup
window.addEventListener('DOMContentLoaded', () => {
  updateModeChrome();
  loadSavedActiveSession(activeMode);

  // Ensure counter is clean if local registry is empty
  const reg = getStoredRegistry(activeMode);
  if (reg.length === 0) {
    localStorage.setItem(getModeConfig(activeMode).storageCounter, '0');
  }

  updateUiState();
  updateReboxCountStat();
  initCloudSync();
  initAuthState();
});

// ── Audio Feedback (Synthesized via Web Audio API) ──────────────────
let audioCtx = null;
function playBeep(type = 'success') {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (type === 'success') {
      osc.frequency.setValueAtTime(1760, audioCtx.currentTime); // High pitch POS beep
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.08);
    } else if (type === 'box_closed') {
      // Double pleasant chime
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      osc.frequency.setValueAtTime(1760, audioCtx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.28);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.28);
    } else if (type === 'error') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.22);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.22);
    }
  } catch (e) {
    // Audio optional
  }
}

// ── Toast Notifications ─────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'error' ? 'error' : ''}`;
  toast.innerHTML = `<span>${type === 'error' ? '⚠️' : '✅'}</span> <span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

// ── Local Storage & Persistence Helpers ─────────────────────────────
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getStoredRegistry(modeId = activeMode) {
  const cfg = getModeConfig(modeId);
  try {
    const raw = localStorage.getItem(cfg.storageRegistry);
    const list = raw ? JSON.parse(raw) : [];
    let needsResave = false;
    list.forEach(r => {
      if (r.rebox_number) {
        const norm = normalizeBoxNumber(r.rebox_number);
        if (norm !== r.rebox_number) {
          r.rebox_number = norm;
          needsResave = true;
        }
      }
    });
    if (needsResave) {
      localStorage.setItem(cfg.storageRegistry, JSON.stringify(list));
    }
    return list;
  } catch {
    return [];
  }
}

function saveRegistry(list, modeId = activeMode) {
  const cfg = getModeConfig(modeId);
  if (Array.isArray(list)) {
    list.forEach(r => {
      if (r.rebox_number) {
        r.rebox_number = normalizeBoxNumber(r.rebox_number);
      }
    });
  }
  localStorage.setItem(cfg.storageRegistry, JSON.stringify(list));
  if (modeId === activeMode) {
    updateReboxCountStat();
  }
}

function getNextIncrementalRbNumber(modeId = activeMode) {
  const cfg = getModeConfig(modeId);
  const registry = getStoredRegistry(modeId);
  let maxNum = 0;
  registry.forEach(r => {
    const match = (r.rebox_number || '').match(/\d+/);
    if (match) {
      const num = parseInt(match[0], 10);
      if (num > maxNum) maxNum = num;
    }
  });
  const nextNum = maxNum + 1;
  localStorage.setItem(cfg.storageCounter, String(nextNum));
  return `BOX-${String(nextNum).padStart(4, '0')}`;
}

function peekNextRbNumber(modeId = activeMode) {
  const registry = getStoredRegistry(modeId);
  let maxNum = 0;
  registry.forEach(r => {
    const match = (r.rebox_number || '').match(/\d+/);
    if (match) {
      const num = parseInt(match[0], 10);
      if (num > maxNum) maxNum = num;
    }
  });
  const nextNum = maxNum + 1;
  return `BOX-${String(nextNum).padStart(4, '0')}`;
}

function saveActiveSession(modeId = activeMode) {
  const cfg = getModeConfig(modeId);
  const session = {
    books: currentScannedBooks,
    assignedRebox: currentAssignedRebox ? normalizeBoxNumber(currentAssignedRebox) : null,
  };
  localStorage.setItem(cfg.storageActive, JSON.stringify(session));
}

function loadSavedActiveSession(modeId = activeMode) {
  const cfg = getModeConfig(modeId);
  currentScannedBooks = [];
  currentAssignedRebox = null;
  try {
    const raw = localStorage.getItem(cfg.storageActive);
    if (!raw) {
      updateUiState();
      return;
    }
    const session = JSON.parse(raw);
    if (Array.isArray(session.books)) {
      currentScannedBooks = session.books;
    }
    if (session.assignedRebox) {
      currentAssignedRebox = normalizeBoxNumber(session.assignedRebox);
    }
    updateUiState();
  } catch (e) {
    console.error('Error loading saved session:', e);
    updateUiState();
  }
}

// ── Book / Text Parsing Helpers ─────────────────────────────────────
function parseBookString(rawVal) {
  const trimmed = (rawVal || '').trim();
  if (!trimmed) return { isbn: 'NO-ISBN', title: 'Untitled Book', is_isbn: false };

  // Check for clean ISBN barcode (all digits or ending in X, length 8 to 18)
  const cleanDigits = trimmed.replace(/[^0-9X]/gi, '');
  const hasLettersOtherThanX = /[a-wy-z]/i.test(trimmed);

  if (!hasLettersOtherThanX && cleanDigits.length >= 8 && cleanDigits.length <= 18) {
    return {
      isbn: cleanDigits.toUpperCase(),
      title: `Physical Book (${cleanDigits.toUpperCase()})`,
      is_isbn: true
    };
  }

  // Check if title has an ISBN-13 or ISBN-10 embedded (e.g. "9780750300209 - Title" or "Title (9780750300209)")
  const isbnMatch = trimmed.match(/\b(97[89][0-9]{10}|[0-9]{9}[0-9Xx])\b/);
  if (isbnMatch) {
    const foundIsbn = isbnMatch[1].toUpperCase();
    const cleanTitle = trimmed
      .replace(isbnMatch[0], '')
      .replace(/^[-\s,:;()]+|[-\s,:;()]+$/g, '')
      .trim();
    return {
      isbn: foundIsbn,
      title: cleanTitle || `Physical Book (${foundIsbn})`,
      is_isbn: true
    };
  }

  // Otherwise it's a manual book title
  return {
    isbn: 'NO-ISBN',
    title: trimmed,
    is_isbn: false
  };
}

// ── Input & Barcode Handling ────────────────────────────────────────
function handleBarcodeKeyDown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const input = document.getElementById('barcodeScannerInput');
    const rawInput = (input.value || '').trim();
    if (rawInput) {
      processBookInput(rawInput);
      input.value = '';
    }
  }
}

// Alias for mobile camera scanner compatibility
function processScannedIsbn(rawVal) {
  processBookInput(rawVal);
}

function normalizeIsbn(val) {
  return String(val || '').replace(/[^0-9X]/gi, '').toUpperCase();
}

function isBookMatchingIsbn(book, targetIsbn) {
  return (
    book &&
    book.is_isbn !== false &&
    book.isbn &&
    book.isbn !== 'NO-ISBN' &&
    normalizeIsbn(book.isbn) === targetIsbn
  );
}

function findBoxesContainingIsbn(isbn, modeId = activeMode) {
  const target = normalizeIsbn(isbn);
  if (!target) return [];
  const registry = getStoredRegistry(modeId);
  return registry.filter(box =>
    (box.books || []).some(b => isBookMatchingIsbn(b, target))
  );
}

function findIsbnInOpenBox(isbn, modeId) {
  const target = normalizeIsbn(isbn);
  if (!target) return false;
  if (modeId === activeMode) {
    if (currentAssignedRebox) return false;
    return currentScannedBooks.some(b => isBookMatchingIsbn(b, target));
  }
  try {
    const raw = localStorage.getItem(getModeConfig(modeId).storageActive);
    if (!raw) return false;
    const session = JSON.parse(raw);
    if (session.assignedRebox || !Array.isArray(session.books)) return false;
    return session.books.some(b => isBookMatchingIsbn(b, target));
  } catch {
    return false;
  }
}

function findBoxesAcrossModes(isbn) {
  const results = [];
  Object.keys(MODES).forEach(modeId => {
    const boxes = findBoxesContainingIsbn(isbn, modeId);
    if (boxes.length > 0) {
      results.push({
        mode: getModeConfig(modeId),
        boxes
      });
    }
  });
  return results;
}

let pendingDuplicateParsed = null;

function findDuplicateLocations(isbn) {
  const locations = [];

  if (findIsbnInOpenBox(isbn, activeMode)) {
    locations.push(`${getModeConfig(activeMode).label} — Current Open Box`);
  }

  const otherModeId = activeMode === 'not_found' ? 'others' : 'not_found';
  if (findIsbnInOpenBox(isbn, otherModeId)) {
    locations.push(`${getModeConfig(otherModeId).label} — Open Box`);
  }

  findBoxesAcrossModes(isbn).forEach(m => {
    const boxNums = m.boxes.map(b => b.rebox_number || 'UNKNOWN').join(', ');
    locations.push(`${m.mode.label} — ${boxNums}`);
  });

  return locations;
}

function recordParsedBook(parsed) {
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];

  const book = {
    isbn: parsed.isbn,
    title: parsed.title,
    is_isbn: parsed.is_isbn,
    scanned_at: timeStr,
    timestamp: now.toISOString(),
    flag: 'normal',
  };

  currentScannedBooks.unshift(book);
  playBeep('success');

  if (parsed.is_isbn) {
    showToast(`Scanned ISBN: ${escapeHtml(parsed.isbn)}`);
  } else {
    showToast(`Recorded Title: "${escapeHtml(parsed.title)}"`);
  }

  saveActiveSession();
  updateUiState();
}

function openDuplicateIsbnModal(parsed, locations) {
  pendingDuplicateParsed = parsed;

  const isbnEl = document.getElementById('duplicateModalIsbn');
  if (isbnEl) isbnEl.textContent = parsed.isbn;

  const titleEl = document.getElementById('duplicateModalTitle');
  if (titleEl) {
    const hasCustomTitle = parsed.title && !parsed.title.startsWith('Physical Book (');
    if (hasCustomTitle) {
      titleEl.textContent = parsed.title;
      titleEl.style.display = 'block';
    } else {
      titleEl.textContent = '';
      titleEl.style.display = 'none';
    }
  }

  const listEl = document.getElementById('duplicateModalLocations');
  if (listEl) {
    listEl.innerHTML = locations.map(loc => `<li>${escapeHtml(loc)}</li>`).join('');
  }

  const scannerModalInput = document.getElementById('duplicateScannerInput');
  if (scannerModalInput) scannerModalInput.value = '';

  openModal('duplicateIsbnModal');
  if (scannerModalInput) {
    scannerModalInput.focus();
    setTimeout(() => scannerModalInput.focus(), 20);
  }
}

function handleDuplicateModalInput(val) {
  if (!document.getElementById('duplicateIsbnModal')?.classList.contains('active')) return;
  if (!pendingDuplicateParsed) return;

  const trimmed = (val || '').trim();
  if (!trimmed) return;

  const targetIsbn = normalizeIsbn(pendingDuplicateParsed.isbn);
  const parsedInput = parseBookString(trimmed);
  if (parsedInput.is_isbn && targetIsbn && normalizeIsbn(parsedInput.isbn) === targetIsbn) {
    confirmDuplicateScan();
  }
}

function handleDuplicateModalKeyDown(e) {
  if (!document.getElementById('duplicateIsbnModal')?.classList.contains('active')) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    const input = document.getElementById('duplicateScannerInput');
    const rawVal = (input && input.value ? input.value : '').trim();
    if (input) input.value = '';

    if (!rawVal) {
      cancelDuplicateScan();
      return;
    }

    const parsedConfirm = parseBookString(rawVal);
    if (
      parsedConfirm.is_isbn &&
      pendingDuplicateParsed &&
      normalizeIsbn(parsedConfirm.isbn) === normalizeIsbn(pendingDuplicateParsed.isbn)
    ) {
      confirmDuplicateScan();
    } else {
      // Different book scanned: cancel previous duplicate and process the new scan
      cancelDuplicateScan();
      processBookInput(rawVal);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancelDuplicateScan();
  }
}

function confirmDuplicateScan() {
  const parsed = pendingDuplicateParsed;
  pendingDuplicateParsed = null;
  const modalInput = document.getElementById('duplicateScannerInput');
  if (modalInput) modalInput.value = '';
  closeModal('duplicateIsbnModal');

  if (parsed && !currentAssignedRebox) {
    recordParsedBook(parsed);
  }

  const scannerInput = document.getElementById('barcodeScannerInput');
  if (scannerInput) scannerInput.focus();
}

function cancelDuplicateScan() {
  pendingDuplicateParsed = null;
  const modalInput = document.getElementById('duplicateScannerInput');
  if (modalInput) modalInput.value = '';
  closeModal('duplicateIsbnModal');

  const scannerInput = document.getElementById('barcodeScannerInput');
  if (scannerInput) scannerInput.focus();
}

if (typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', (e) => {
    const isDupOpen = document.getElementById('duplicateIsbnModal')?.classList.contains('active');
    if (!isDupOpen) return;
    if (e.key === 'Escape') {
      cancelDuplicateScan();
    } else if (
      e.key === 'Enter' &&
      document.activeElement?.id !== 'duplicateScannerInput' &&
      document.activeElement?.id !== 'duplicateProceedBtn'
    ) {
      e.preventDefault();
      cancelDuplicateScan();
    }
  });
}

function processBookInput(rawInput) {
  // If active box is already closed, remind user to start next box
  if (currentAssignedRebox) {
    playBeep('error');
    showToast(`Box ${currentAssignedRebox} is already closed. Click "Start Next Box" to begin a new package.`, 'error');
    return;
  }

  const trimmed = (rawInput || '').trim();
  if (!trimmed || trimmed.length < 2) {
    playBeep('error');
    showToast('Please enter an ISBN barcode or a book title (minimum 2 characters).', 'error');
    return;
  }

  const parsed = parseBookString(trimmed);

  // Check duplicate ISBN scans across open boxes and closed boxes in both modes
  if (parsed.is_isbn) {
    const locations = findDuplicateLocations(parsed.isbn);
    if (locations.length > 0) {
      playBeep('error');
      openDuplicateIsbnModal(parsed, locations);
      return;
    }
  }

  recordParsedBook(parsed);
}

// ── Multi-User Cloud Realtime Sync & Operator Handling ─────────────
function handleOperatorNameChange(val) {
  currentOperatorName = (val || '').trim();
  localStorage.setItem(STORAGE_KEY_OPERATOR, currentOperatorName);
  const cfgInput = document.getElementById('cfgStationName');
  if (cfgInput && cfgInput.value !== currentOperatorName) {
    cfgInput.value = currentOperatorName;
  }
}

// ── Supabase Setup SQL & Clipboard Helper ───────────────────────────
const SUPABASE_SETUP_SQL = `-- Run this in your Supabase SQL Editor:
-- 1. Create tables for closed Boxes (Not Found & Others)
create table if not exists not_found_reboxes (
  id bigint generated by default as identity primary key,
  rebox_number text unique not null,
  sealed_by text default 'Operator',
  assigned_at timestamptz not null default now(),
  assigned_at_formatted text,
  book_count integer not null default 0,
  status text default 'Closed',
  books jsonb not null default '[]'::jsonb
);

create table if not exists others_reboxes (
  id bigint generated by default as identity primary key,
  rebox_number text unique not null,
  sealed_by text default 'Operator',
  assigned_at timestamptz not null default now(),
  assigned_at_formatted text,
  book_count integer not null default 0,
  status text default 'Closed',
  books jsonb not null default '[]'::jsonb
);

create table if not exists app_users (
  id bigint generated by default as identity primary key,
  username text not null,
  username_lower text unique not null,
  password_hash text not null,
  role text not null default 'staff',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by text
);

-- Upgrade existing tables if columns are missing
alter table app_users add column if not exists role text not null default 'staff';
alter table app_users add column if not exists status text not null default 'pending';
alter table app_users add column if not exists approved_at timestamptz;
alter table app_users add column if not exists approved_by text;

-- Disable Row Level Security so all warehouse stations can sync and read boxes
alter table not_found_reboxes disable row level security;
alter table others_reboxes disable row level security;
alter table app_users disable row level security;

-- 2. Enable Realtime updates (idempotent)
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'not_found_reboxes'
  ) then
    alter publication supabase_realtime add table not_found_reboxes;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'others_reboxes'
  ) then
    alter publication supabase_realtime add table others_reboxes;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_users'
  ) then
    alter publication supabase_realtime add table app_users;
  end if;
end $$;

-- 3. Atomic Stored Procedure: Claim Single Box for Not Found (BOX-0001, BOX-0002, ...)
create or replace function claim_next_rebox(p_operator text, p_books jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  max_num integer;
  next_val integer;
  box_str text;
  now_ts timestamptz := now();
  fmt_date text;
  new_row not_found_reboxes%rowtype;
begin
  -- Advisory xact lock guarantees strictly serialized box assignment across all operators
  perform pg_advisory_xact_lock(424242);

  -- Determine highest existing box number
  select coalesce(
    max(nullif(regexp_replace(rebox_number, '\\D', '', 'g'), '')::integer),
    0
  ) into max_num
  from not_found_reboxes;

  next_val := max_num + 1;
  box_str := 'BOX-' || lpad(next_val::text, 4, '0');
  fmt_date := to_char(now_ts, 'Mon DD, YYYY, HH12:MI AM');

  insert into not_found_reboxes (
    rebox_number, sealed_by, assigned_at, assigned_at_formatted, book_count, status, books
  ) values (
    box_str, coalesce(p_operator, 'Operator'), now_ts, fmt_date, jsonb_array_length(p_books), 'Closed', p_books
  ) returning * into new_row;

  return to_jsonb(new_row);
end;
$$;

-- 4. Atomic Stored Procedure: Claim Single Box for Others (BOX-0001, BOX-0002, ...)
create or replace function claim_next_others_rebox(p_operator text, p_books jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  max_num integer;
  next_val integer;
  box_str text;
  now_ts timestamptz := now();
  fmt_date text;
  new_row others_reboxes%rowtype;
begin
  -- Advisory xact lock guarantees strictly serialized box assignment across all operators
  perform pg_advisory_xact_lock(424243);

  -- Determine highest existing box number
  select coalesce(
    max(nullif(regexp_replace(rebox_number, '\\D', '', 'g'), '')::integer),
    0
  ) into max_num
  from others_reboxes;

  next_val := max_num + 1;
  box_str := 'BOX-' || lpad(next_val::text, 4, '0');
  fmt_date := to_char(now_ts, 'Mon DD, YYYY, HH12:MI AM');

  insert into others_reboxes (
    rebox_number, sealed_by, assigned_at, assigned_at_formatted, book_count, status, books
  ) values (
    box_str, coalesce(p_operator, 'Operator'), now_ts, fmt_date, jsonb_array_length(p_books), 'Closed', p_books
  ) returning * into new_row;

  return to_jsonb(new_row);
end;
$$;`;

function isMissingTableError(err) {
  if (!err) return false;
  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || '').toLowerCase();
  return code === 'PGRST205' || code === '42P01' || msg.includes('could not find the table') || msg.includes('does not exist');
}

function copySupabaseSql() {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(SUPABASE_SETUP_SQL).then(() => {
      showToast('📋 Copied Supabase SQL setup to clipboard! Paste it into Supabase SQL Editor.');
    }).catch(() => {
      prompt('Copy this SQL and run it in Supabase SQL Editor:', SUPABASE_SETUP_SQL);
    });
  } else {
    prompt('Copy this SQL and run it in Supabase SQL Editor:', SUPABASE_SETUP_SQL);
  }
}

const DEFAULT_SUPABASE_URL = 'https://paizlgzyylvcwfwfwusw.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_ijU8ECGh2hKAZo1FUmPTaw_koet73o7';

function cleanSupabaseUrl(url) {
  if (!url) return '';
  let u = url.trim();
  u = u.replace(/\/rest\/v1\/?$/, '');
  u = u.replace(/\/+$/, '');
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    u = 'https://' + u;
  }
  return u;
}

async function initCloudSync() {
  let cloudConfig = null;

  // 1. Check if Vercel serverless API has environment variables
  try {
    const resp = await fetch('/api/config');
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.enabled && data.config) {
        cloudConfig = data.config;
        console.log('Detected Supabase config from Vercel endpoint.');
      }
    }
  } catch (e) {
    // Running statically or locally
  }

  // 2. Fallback to localStorage saved config
  if (!cloudConfig) {
    cloudConfig = getSavedCloudConfig();
  }

  // 3. Fallback to project defaults
  if (!cloudConfig || !cloudConfig.supabaseUrl) {
    cloudConfig = {
      supabaseUrl: DEFAULT_SUPABASE_URL,
      supabaseAnonKey: DEFAULT_SUPABASE_ANON_KEY
    };
  }

  if (cloudConfig && cloudConfig.supabaseUrl && cloudConfig.supabaseAnonKey) {
    connectToSupabase(cloudConfig);
  } else {
    setCloudStatus(false);
  }
}

async function connectToSupabase(config) {
  try {
    if (!window.supabase || !window.supabase.createClient) {
      console.warn('Supabase SDK not yet loaded.');
      setCloudStatus(false);
      return;
    }

    const validUrl = cleanSupabaseUrl(config.supabaseUrl);
    supabaseClient = window.supabase.createClient(validUrl, config.supabaseAnonKey);
    isCloudConnected = true;
    modeCloudReady = { not_found: true, others: true };
    setCloudStatus(true, config);

    // Fetch initial registries for both modes & attach realtime subscriptions
    await Promise.all([
      fetchAndSyncSupabaseRegistry('not_found'),
      fetchAndSyncSupabaseRegistry('others')
    ]);
    attachSupabaseRealtime();
    fetchAndSyncUsers();
    console.log('Multi-user Supabase cloud sync connected successfully!');
  } catch (err) {
    console.error('Failed to connect to Supabase:', err);
    setCloudStatus(false);
    showToast('Supabase connection error: ' + err.message, 'error');
  }
}

async function fetchAndSyncSupabaseRegistry(targetMode = activeMode) {
  if (!isCloudConnected || !supabaseClient) return;
  const cfg = getModeConfig(targetMode);
  try {
    const { data, error } = await supabaseClient
      .from(cfg.tableName)
      .select('*')
      .order('id', { ascending: false });

    if (error) {
      if (isMissingTableError(error)) {
        modeCloudReady[targetMode] = false;
        if (targetMode === activeMode) {
          setCloudStatus(true);
        }
        console.warn(`Supabase table "${cfg.tableName}" not found yet; using local storage for ${cfg.label}.`);
      } else {
        console.warn(`Error fetching Supabase registry for ${cfg.label}:`, error);
      }
      return;
    }

    modeCloudReady[targetMode] = true;
    if (targetMode === activeMode) {
      setCloudStatus(true);
    }

    if (Array.isArray(data)) {
      let maxCloudNum = 0;
      let hasRbRows = [];
      data.forEach(r => {
        if (r.rebox_number) {
          if (r.rebox_number.startsWith('RB-') || !r.rebox_number.startsWith('BOX-')) {
            hasRbRows.push({ id: r.id, newNum: normalizeBoxNumber(r.rebox_number) });
          }
          r.rebox_number = normalizeBoxNumber(r.rebox_number);
        }
        const match = (r.rebox_number || '').match(/\d+/);
        if (match) {
          const num = parseInt(match[0], 10);
          if (num > maxCloudNum) maxCloudNum = num;
        }
      });

      localStorage.setItem(cfg.storageRegistry, JSON.stringify(data));
      localStorage.setItem(cfg.storageCounter, String(maxCloudNum));

      if (targetMode === activeMode) {
        updateReboxCountStat();
        updateUiState();
        if (document.getElementById('registryModal')?.classList.contains('active')) {
          renderMasterRegistry();
        }
      }

      // Lazily fix any legacy RB- rows in Supabase table
      if (hasRbRows.length > 0) {
        hasRbRows.forEach(async item => {
          if (item.id && item.newNum) {
            await supabaseClient.from(cfg.tableName).update({ rebox_number: item.newNum }).eq('id', item.id);
          }
        });
      }
    }
  } catch (err) {
    console.warn(`Error fetching Supabase registry for ${cfg.label}:`, err);
  }
}

function attachSupabaseRealtime() {
  if (!isCloudConnected || !supabaseClient) return;

  if (supabaseRealtimeChannel) {
    supabaseClient.removeChannel(supabaseRealtimeChannel);
    supabaseRealtimeChannel = null;
  }

  supabaseRealtimeChannel = supabaseClient
    .channel('all_reboxes_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: MODES.not_found.tableName },
      (payload) => {
        console.log('Supabase realtime payload (Not Found):', payload);
        fetchAndSyncSupabaseRegistry('not_found');
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: MODES.others.tableName },
      (payload) => {
        console.log('Supabase realtime payload (Others):', payload);
        fetchAndSyncSupabaseRegistry('others');
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'app_users' },
      (payload) => {
        console.log('Supabase realtime payload (app_users):', payload);
        fetchAndSyncUsers();
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('Connected to Supabase Realtime (Not Found & Others).');
      }
    });
}

function setCloudStatus(connected, config = null) {
  isCloudConnected = connected;
  const cfg = getModeConfig();
  const tableReady = modeCloudReady[cfg.id] !== false;
  const dot = document.getElementById('cloudStatusDot');
  const text = document.getElementById('cloudStatusText');
  const banner = document.getElementById('cloudStatusBanner');
  const bannerIcon = document.getElementById('cloudBannerIcon');
  const bannerText = document.getElementById('cloudBannerText');

  if (connected && tableReady) {
    dot.style.background = '#10b981';
    text.textContent = 'Cloud: Live (Supabase)';
    if (banner) {
      banner.style.background = '#ecfdf5';
      banner.style.borderColor = '#a7f3d0';
      banner.style.color = '#065f46';
      bannerIcon.textContent = '🟢';
      bannerText.textContent = `Supabase Cloud Connected! Atomic box assignment active for ${cfg.label}.`;
    }
  } else if (connected && !tableReady) {
    dot.style.background = '#f59e0b';
    text.textContent = `Cloud: ${cfg.label} SQL Needed`;
    if (banner) {
      banner.style.background = '#fffbeb';
      banner.style.borderColor = '#fde68a';
      banner.style.color = '#92400e';
      bannerIcon.textContent = '⚠️';
      bannerText.textContent = `Connected to Supabase, but table "${cfg.tableName}" is not created yet. Click "Copy Supabase Setup SQL" and run it in Supabase SQL Editor. Saving locally until then.`;
    }
  } else {
    dot.style.background = '#94a3b8';
    text.textContent = 'Cloud: Local Mode';
    if (banner) {
      banner.style.background = '#f1f5f9';
      banner.style.borderColor = '#cbd5e1';
      banner.style.color = '#475569';
      bannerIcon.textContent = 'ℹ️';
      bannerText.textContent = 'Running in local standalone mode. Multiple users will have isolated counters unless connected to Supabase.';
    }
  }
}

function openCloudConfigModal() {
  const cfg = getSavedCloudConfig() || {};
  document.getElementById('cfgSupabaseUrl').value = cfg.supabaseUrl || DEFAULT_SUPABASE_URL;
  document.getElementById('cfgSupabaseAnonKey').value = cfg.supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY;
  document.getElementById('cfgStationName').value = currentOperatorName;
  setCloudStatus(isCloudConnected);
  openModal('cloudConfigModal');
}

function getSavedCloudConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CLOUD_CFG);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveAndConnectCloud() {
  const supUrl = cleanSupabaseUrl(document.getElementById('cfgSupabaseUrl').value || '');
  const anonKey = (document.getElementById('cfgSupabaseAnonKey').value || '').trim();
  const station = (document.getElementById('cfgStationName').value || '').trim();

  if (!supUrl || !anonKey) {
    showToast('Please enter both Supabase Project URL and Anon Key.', 'error');
    return;
  }

  if (station) {
    handleOperatorNameChange(station);
  }

  const config = {
    supabaseUrl: supUrl,
    supabaseAnonKey: anonKey
  };

  localStorage.setItem(STORAGE_KEY_CLOUD_CFG, JSON.stringify(config));
  connectToSupabase(config);
  closeModal('cloudConfigModal');
  showToast('Connecting to Supabase Multi-User Sync...');
}

function disconnectCloud() {
  localStorage.removeItem(STORAGE_KEY_CLOUD_CFG);
  if (supabaseRealtimeChannel && supabaseClient) {
    supabaseClient.removeChannel(supabaseRealtimeChannel);
    supabaseRealtimeChannel = null;
  }
  supabaseClient = null;
  setCloudStatus(false);
  closeModal('cloudConfigModal');
  showToast('Switched to local offline mode.');
}

function buildLocalBoxRecord(boxNumber, operator, now, books) {
  return {
    rebox_number: boxNumber,
    sealed_by: operator,
    assigned_at: now.toISOString(),
    assigned_at_formatted: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    book_count: books.length,
    status: 'Closed',
    books: [...books]
  };
}

// ── Rebox Assignment & Closure (Core User Functionality) ────────────
async function assignBoxAndClose() {
  if (currentScannedBooks.length === 0) {
    showToast('Cannot close an empty box. Please scan or record at least 1 book.', 'error');
    return;
  }
  if (currentAssignedRebox) {
    showToast(`This box is already assigned as ${currentAssignedRebox}.`, 'error');
    return;
  }

  const modeCfg = getModeConfig();
  const btnAssign = document.getElementById('btnAssignBox');
  const originalText = btnAssign.innerHTML;
  btnAssign.disabled = true;
  btnAssign.textContent = '⏳ Claiming Box #...';

  let nextRb = null;
  let savedLocallyDueToMissingTable = false;

  try {
    const operator = currentOperatorName || 'Operator';
    const now = new Date();
    let newReboxRecord = null;

    if (isCloudConnected && supabaseClient && modeCloudReady[modeCfg.id] !== false) {
      // ATOMIC TRANSACTION: PostgreSQL advisory-locked sequential box assignment
      const { data: rpcResult, error: rpcError } = await supabaseClient.rpc(modeCfg.rpcName, {
        p_operator: operator,
        p_books: currentScannedBooks
      });

      if (!rpcError && rpcResult && rpcResult.rebox_number) {
        newReboxRecord = rpcResult;
        nextRb = rpcResult.rebox_number;
        // Defensive: If database function returned 'RB-XXXX', convert to 'BOX-XXXX'
        if (nextRb.startsWith('RB-') || !nextRb.startsWith('BOX-')) {
          const cleanRb = normalizeBoxNumber(nextRb);
          if (rpcResult.id) {
            await supabaseClient.from(modeCfg.tableName).update({ rebox_number: cleanRb }).eq('id', rpcResult.id);
          }
          newReboxRecord.rebox_number = cleanRb;
          nextRb = cleanRb;
        }
      } else {
        console.warn(`${modeCfg.rpcName} RPC unavailable or errored; falling back to direct table query/insert:`, rpcError);
        const { data: existingRows, error: queryErr } = await supabaseClient
          .from(modeCfg.tableName)
          .select('rebox_number')
          .order('id', { ascending: false })
          .limit(100);

        if (isMissingTableError(queryErr)) {
          modeCloudReady[modeCfg.id] = false;
          setCloudStatus(true);
          savedLocallyDueToMissingTable = true;
          nextRb = getNextIncrementalRbNumber(modeCfg.id);
          newReboxRecord = buildLocalBoxRecord(nextRb, operator, now, currentScannedBooks);
        } else {
          let maxNum = 0;
          (existingRows || []).forEach(r => {
            const m = (r.rebox_number || '').match(/\d+/);
            if (m) maxNum = Math.max(maxNum, parseInt(m[0], 10));
          });
          const nextNum = maxNum + 1;
          nextRb = `BOX-${String(nextNum).padStart(4, '0')}`;
          localStorage.setItem(modeCfg.storageCounter, String(nextNum));

          newReboxRecord = buildLocalBoxRecord(nextRb, operator, now, currentScannedBooks);

          const { data: insData, error: insErr } = await supabaseClient
            .from(modeCfg.tableName)
            .insert([newReboxRecord])
            .select()
            .single();

          if (insErr) {
            if (isMissingTableError(insErr)) {
              modeCloudReady[modeCfg.id] = false;
              setCloudStatus(true);
              savedLocallyDueToMissingTable = true;
              nextRb = getNextIncrementalRbNumber(modeCfg.id);
              newReboxRecord = buildLocalBoxRecord(nextRb, operator, now, currentScannedBooks);
            } else {
              throw new Error('Supabase insert error: ' + insErr.message);
            }
          } else if (insData) {
            newReboxRecord = insData;
          }
        }
      }
    } else {
      // Local fallback
      if (isCloudConnected && modeCloudReady[modeCfg.id] === false) {
        savedLocallyDueToMissingTable = true;
      }
      nextRb = getNextIncrementalRbNumber(modeCfg.id);
      newReboxRecord = buildLocalBoxRecord(nextRb, operator, now, currentScannedBooks);
    }

    currentAssignedRebox = nextRb;

    // Save into historical Rebox Registry cache for this mode
    const registry = getStoredRegistry(modeCfg.id);
    if (!registry.some(r => r.rebox_number === nextRb)) {
      registry.unshift(newReboxRecord);
      saveRegistry(registry, modeCfg.id);
    }

    // Play success chime
    playBeep('box_closed');

    // Update UI
    updateUiState();
    saveActiveSession(modeCfg.id);

    // Pre-populate print label container with newly closed box details
    const printHeaderEl = document.getElementById('printLabelHeader');
    if (printHeaderEl) printHeaderEl.textContent = modeCfg.printHeader;
    const printRbEl = document.getElementById('printRbNumber');
    if (printRbEl) printRbEl.textContent = nextRb;
    const printDetEl = document.getElementById('printDetails');
    if (printDetEl) {
      printDetEl.innerHTML = `
        TOTAL BOOKS: ${newReboxRecord.book_count || (newReboxRecord.books || []).length}<br>
        SEALED BY: ${(newReboxRecord.sealed_by || operator).toUpperCase()}<br>
        DATE: ${now.toLocaleDateString()}<br>
        STATUS: SEALED & AUDITED
      `;
    }

    if (savedLocallyDueToMissingTable) {
      showToast(`📦 ${modeCfg.label} ${nextRb} saved locally. Run updated Supabase SQL in Cloud Sync to enable cloud sync for ${modeCfg.label}.`);
    } else {
      showToast(`🎉 [${modeCfg.label}] Box assigned: ${nextRb} (${newReboxRecord.book_count} books by ${operator}). Package is CLOSED.`);
    }

  } catch (err) {
    console.error('Error assigning box:', err);
    showToast('Error claiming box number: ' + err.message, 'error');
    btnAssign.disabled = false;
    btnAssign.innerHTML = originalText;
  }
}

function startNextBox() {
  if (!currentAssignedRebox) {
    showToast('Please assign and close the current box before starting a new box.', 'error');
    return;
  }

  // Clear active session
  currentScannedBooks = [];
  currentAssignedRebox = null;
  saveActiveSession();
  updateUiState();

  document.getElementById('barcodeScannerInput').value = '';
  document.getElementById('barcodeScannerInput').focus();
  showToast('Started new Box. Terminal ready for next books.');
}

// ── UI State Synchronizer ───────────────────────────────────────────
// ── UI State Synchronizer ───────────────────────────────────────────
function updateUiState() {
  const count = currentScannedBooks.length;
  const countEl = document.getElementById('currentBoxCount');
  if (countEl) countEl.textContent = count;
  const feedBadgeEl = document.getElementById('feedCountBadge');
  if (feedBadgeEl) feedBadgeEl.textContent = `Total: ${count}`;

  // Update Next Box Preview
  const nextPreviewEl = document.getElementById('nextReboxPreview');
  if (nextPreviewEl) {
    nextPreviewEl.textContent = peekNextRbNumber();
  }

  // Update Active Box Package Card
  const packageCard = document.getElementById('activeReboxCard');
  const packageTitle = document.getElementById('activeReboxTitle');
  const packageSub = document.getElementById('activeReboxSub');
  const boxStatus = document.getElementById('boxScanStatus');
  const btnAssign = document.getElementById('btnAssignBox');
  const btnStartNext = document.getElementById('btnStartNextBox');

  if (packageCard && packageTitle && packageSub && boxStatus && btnAssign) {
    if (currentAssignedRebox) {
      packageCard.classList.add('assigned');
      packageTitle.textContent = currentAssignedRebox;
      packageSub.textContent = `Assigned & Closed (${count} books sealed)`;
      boxStatus.innerHTML = `<span class="status-dot" style="background:#10b981;"></span> Sealed: ${currentAssignedRebox}`;
      btnAssign.disabled = true;
      btnAssign.textContent = `✓ ${currentAssignedRebox} Closed`;

      if (btnStartNext) {
        btnStartNext.disabled = false;
        btnStartNext.title = 'Start next box';
      }
    } else {
      packageCard.classList.remove('assigned');
      packageTitle.textContent = count > 0 ? `NOT ASSIGNED (${count})` : 'NOT ASSIGNED';
      packageSub.textContent = 'Books scanned will be grouped into this box.';
      boxStatus.innerHTML = `<span class="status-dot" style="background: var(--border-focus); box-shadow: 0 0 0 3px var(--focus-ring);"></span> Pending Assignment`;
      btnAssign.disabled = count === 0;
      btnAssign.innerHTML = `📦 Assign Box No. & Close`;

      if (btnStartNext) {
        btnStartNext.disabled = true;
        btnStartNext.title = 'Assign and close current box first before starting next box';
      }
    }
  }

  populateBoxDropdown();
  renderFeed();
}

function updateCounterDisplay() {
  const el = document.getElementById('currentBoxCount');
  if (el) el.textContent = currentScannedBooks.length;
}

function updateReboxCountStat() {
  const registry = getStoredRegistry();
  const count = registry.length;
  const statEl = document.getElementById('reboxCountStat');
  if (statEl) {
    statEl.textContent = `${count} Closed Box${count === 1 ? '' : 'es'}`;
  }
  populateBoxDropdown();
}

function populateBoxDropdown() {
  const select = document.getElementById('boxSelectDropdown');
  const datalist = document.getElementById('boxDatalistOptions');
  const registry = getStoredRegistry();

  if (select) {
    const currentVal = select.value;
    let selectHtml = `<option value="">-- Choose from ${registry.length} Closed Box${registry.length === 1 ? '' : 'es'} --</option>`;
    registry.forEach(r => {
      const num = r.rebox_number || '';
      const bCount = r.book_count || (r.books || []).length;
      const op = r.sealed_by || 'Operator';
      const selected = (currentVal && currentVal === num) ? 'selected' : '';
      selectHtml += `<option value="${escapeHtml(num)}" ${selected}>${escapeHtml(num)} — ${bCount} books (${escapeHtml(op)})</option>`;
    });
    select.innerHTML = selectHtml;
  }

  if (datalist) {
    let dlHtml = '';
    registry.forEach(r => {
      const num = r.rebox_number || '';
      const bCount = r.book_count || (r.books || []).length;
      const op = r.sealed_by || 'Operator';
      dlHtml += `<option value="${escapeHtml(num)}">${escapeHtml(num)} — ${bCount} books (${escapeHtml(op)})</option>`;
    });
    datalist.innerHTML = dlHtml;
  }
}

function findBoxInRegistry(query) {
  if (!query) return null;
  const registry = getStoredRegistry();
  const raw = query.trim().toUpperCase();
  const clean = raw.replace(/[^A-Z0-9]/g, '');

  return registry.find(r => {
    const num = (r.rebox_number || '').toUpperCase();
    const cleanNum = num.replace(/[^A-Z0-9]/g, '');
    if (num === raw || cleanNum === clean) return true;

    // Check numeric match e.g. "1" matches "BOX-0001" or "RB-0001"
    const m1 = num.match(/\d+/);
    const m2 = raw.match(/\d+/);
    if (m1 && m2 && parseInt(m1[0], 10) === parseInt(m2[0], 10)) {
      return true;
    }
    return false;
  });
}

function handleDropdownSelect(val) {
  if (!val) return;
  const searchInput = document.getElementById('searchRbInput');
  if (searchInput) searchInput.value = val;
  const matched = findBoxInRegistry(val);
  if (matched) {
    openInspectModalForBox(matched);
  }
}

function handleBoxSelect(val) {
  if (!val) return;
  const select = document.getElementById('boxSelectDropdown');
  if (select) select.value = val;
  const matched = findBoxInRegistry(val);
  if (matched) {
    openInspectModalForBox(matched);
  }
}

// ── Feed Rendering ──────────────────────────────────────────────────
function renderFeed() {
  const listContainer = document.getElementById('feedList');
  if (!listContainer) return;

  if (currentScannedBooks.length === 0) {
    listContainer.innerHTML = `
      <div id="emptyFeedState" class="empty-state">
        <div class="empty-icon">📚</div>
        <h3 class="empty-title">No Books Scanned Yet</h3>
        <p class="empty-desc">Scan a barcode, enter an ISBN, or type a book title to record books into this box.</p>
      </div>
    `;
    return;
  }

  // Sort items
  const items = [...currentScannedBooks];
  if (sortOrder === 'oldest') {
    items.reverse();
  }

  let html = '';
  items.forEach((book, idx) => {
    const itemIdx = sortOrder === 'newest' ? currentScannedBooks.length - idx : idx + 1;
    const actualIndex = sortOrder === 'newest' ? idx : currentScannedBooks.length - 1 - idx;
    const isBarcode = book.is_isbn !== false && book.isbn && book.isbn !== 'NO-ISBN';

    html += `
      <div class="book-item">
        <div class="book-left">
          <span class="book-index">#${itemIdx}</span>
          <div class="book-details">
            ${isBarcode ? `
              <span class="book-isbn">${escapeHtml(book.isbn)}</span>
              <span class="book-title">${escapeHtml(book.title && !book.title.startsWith('Physical Book') ? book.title : 'Physical Barcode')}</span>
            ` : `
              <span class="book-title" style="font-size:13px; font-weight:700; color:var(--text-main);">${escapeHtml(book.title)}</span>
              <span style="font-size:11px; font-weight:600; color:#d97706; display:flex; align-items:center; gap:4px;">
                <span>📖</span> Manual Title (No ISBN)
              </span>
            `}
          </div>
        </div>
        <div class="book-right">
          <span class="book-time">${escapeHtml(book.scanned_at)}</span>
          <select class="flag-select" onchange="changeBookFlag(${actualIndex}, this.value)" ${currentAssignedRebox ? 'disabled' : ''}>
            <option value="normal" ${book.flag === 'normal' ? 'selected' : ''}>Normal</option>
            <option value="brittle" ${book.flag === 'brittle' ? 'selected' : ''}>⚠️ Brittle</option>
            <option value="torn" ${book.flag === 'torn' ? 'selected' : ''}>⚠️ Torn Pages</option>
            <option value="stained" ${book.flag === 'stained' ? 'selected' : ''}>⚠️ Stained</option>
            <option value="mismatch" ${book.flag === 'mismatch' ? 'selected' : ''}>🔄 Mismatch</option>
          </select>
          <button class="btn-delete-book" title="${currentAssignedRebox ? 'Remove from closed box' : 'Remove Entry'}" onclick="removeBookByIndex(${actualIndex})">
            🗑️
          </button>
        </div>
      </div>
    `;
  });

  listContainer.innerHTML = html;
}

function toggleSortOrder() {
  sortOrder = sortOrder === 'newest' ? 'oldest' : 'newest';
  const labelEl = document.getElementById('sortOrderLabel');
  if (labelEl) labelEl.textContent = sortOrder === 'newest' ? 'Newest First' : 'Oldest First';
  renderFeed();
}

function changeBookFlag(idx, flag) {
  if (currentScannedBooks[idx]) {
    currentScannedBooks[idx].flag = flag;
    saveActiveSession();
  }
}

async function removeBookByIndex(idx) {
  if (currentAssignedRebox) {
    await deleteBookFromClosedBox(currentAssignedRebox, activeMode, idx);
    return;
  }
  if (currentScannedBooks[idx]) {
    const removed = currentScannedBooks.splice(idx, 1)[0];
    saveActiveSession();
    updateUiState();
    showToast(`Removed "${escapeHtml(removed.title || removed.isbn)}"`);
  }
}

async function deleteBookFromClosedBox(boxNumber, modeId, bookIndex) {
  const cfg = getModeConfig(modeId);
  const registry = getStoredRegistry(modeId);
  const boxIdx = registry.findIndex(r => normalizeBoxNumber(r.rebox_number) === normalizeBoxNumber(boxNumber));
  if (boxIdx === -1) {
    showToast(`Box ${boxNumber} not found in ${cfg.label}.`, 'error');
    return;
  }

  const box = registry[boxIdx];
  const books = Array.isArray(box.books) ? [...box.books] : [];
  const targetBook = books[bookIndex];
  if (!targetBook) {
    showToast('Book entry not found in this box.', 'error');
    return;
  }

  const isBarcode = targetBook.is_isbn !== false && targetBook.isbn && targetBook.isbn !== 'NO-ISBN';
  const label = isBarcode ? targetBook.isbn : (targetBook.title || 'Untitled Book');
  const lastBookNote = books.length === 1
    ? '\n\nNote: This is the last item in the box, so removing it will leave 0 books.'
    : '';

  const confirmed = confirm(
    `Remove "${label}" from closed box ${box.rebox_number} (${cfg.label})?${lastBookNote}`
  );
  if (!confirmed) return;

  books.splice(bookIndex, 1);

  try {
    if (isCloudConnected && supabaseClient && modeCloudReady[cfg.id] !== false) {
      let query = supabaseClient
        .from(cfg.tableName)
        .update({
          books,
          book_count: books.length
        });

      if (box.id) {
        query = query.eq('id', box.id);
      } else {
        query = query.eq('rebox_number', box.rebox_number);
      }

      const { error } = await query;
      if (error && !isMissingTableError(error)) {
        throw new Error(error.message);
      }
    }

    const updatedBox = {
      ...box,
      books,
      book_count: books.length,
      _modeId: modeId
    };
    registry[boxIdx] = updatedBox;
    saveRegistry(registry, modeId);

    // Keep active working session in sync if this closed box is currently loaded
    if (modeId === activeMode && currentAssignedRebox === updatedBox.rebox_number) {
      currentScannedBooks = [...books];
      saveActiveSession(modeId);
      updateUiState();
    }

    if (window._currentInspectBox && window._currentInspectBox.rebox_number === updatedBox.rebox_number) {
      openInspectModalForBox(updatedBox, modeId);
    }

    if (document.getElementById('registryModal')?.classList.contains('active')) {
      renderMasterRegistry();
    }

    playBeep('success');
    showToast(`🗑️ Removed "${escapeHtml(label)}" from ${escapeHtml(updatedBox.rebox_number)}.`);
  } catch (err) {
    console.error('Error removing book from closed box:', err);
    showToast('Failed to update closed box: ' + err.message, 'error');
  }
}

async function removeBookFromInspectBox(bookIndex) {
  const box = window._currentInspectBox;
  if (!box || !box.rebox_number) return;
  await deleteBookFromClosedBox(box.rebox_number, box._modeId || activeMode, bookIndex);
}

function handleRbSearchInput(e) {
  const searchInput = document.getElementById('searchRbInput');
  const query = (searchInput && searchInput.value ? searchInput.value : '').trim();
  const select = document.getElementById('boxSelectDropdown');
  if (select && query) {
    const matched = findBoxInRegistry(query);
    if (matched && matched.rebox_number) {
      select.value = matched.rebox_number;
    }
  }
  if (e && e.key === 'Enter') {
    inspectSearchedRbBox();
  }
}

function inspectSearchedRbBox() {
  const input = document.getElementById('searchRbInput');
  const select = document.getElementById('boxSelectDropdown');
  const term = (input && input.value ? input.value : (select ? select.value : '')).trim();
  if (!term) {
    showToast('Please select or type a Box number (e.g. BOX-0001).', 'error');
    if (input) input.focus();
    return;
  }

  const matched = findBoxInRegistry(term);

  if (!matched) {
    showToast(`No record found for Box "${term}".`, 'error');
    return;
  }

  openInspectModalForBox(matched);
}

function openInspectModalForBox(boxRecord, modeId = activeMode) {
  boxRecord._modeId = modeId || boxRecord._modeId || activeMode;
  document.getElementById('inspectModalTitle').textContent = `Box ${boxRecord.rebox_number} Manifest`;
  document.getElementById('inspectBoxNumber').textContent = boxRecord.rebox_number;
  document.getElementById('inspectBookCount').textContent = boxRecord.book_count || (boxRecord.books || []).length;
  document.getElementById('inspectOperator').textContent = boxRecord.sealed_by || 'Operator';
  document.getElementById('inspectAssignedAt').textContent = `Closed on ${boxRecord.assigned_at_formatted || new Date(boxRecord.assigned_at).toLocaleString()}`;

  // Set print details
  const printHeaderEl = document.getElementById('printLabelHeader');
  if (printHeaderEl) printHeaderEl.textContent = getModeConfig().printHeader;
  document.getElementById('printRbNumber').textContent = boxRecord.rebox_number;
  document.getElementById('printDetails').innerHTML = `
    TOTAL BOOKS: ${boxRecord.book_count || (boxRecord.books || []).length}<br>
    SEALED BY: ${(boxRecord.sealed_by || 'OPERATOR').toUpperCase()}<br>
    DATE: ${new Date(boxRecord.assigned_at).toLocaleDateString()}<br>
    STATUS: SEALED & AUDITED
  `;

  // Setup transfer button
  const transferBtn = document.getElementById('btnTransferBox');
  if (transferBtn) {
    const srcMode = boxRecord._modeId || activeMode;
    const targetMode = srcMode === 'not_found' ? 'others' : 'not_found';
    transferBtn.textContent = `🔄 Transfer to ${MODES[targetMode].label}`;
    transferBtn.title = `Transfer this box to ${MODES[targetMode].label}`;
  }

  // Render books
  const listEl = document.getElementById('inspectBooksList');
  const boxBooks = Array.isArray(boxRecord.books) ? boxRecord.books : [];
  if (boxBooks.length === 0) {
    listEl.innerHTML = `
      <div style="text-align: center; padding: 24px 12px; color: #94a3b8; font-size: 13px; background: #f8fafc; border: 1px dashed var(--border-color); border-radius: 8px;">
        No books remaining in this box.
      </div>
    `;
  } else {
    let html = '';
    boxBooks.forEach((b, idx) => {
      const isBarcode = b.is_isbn !== false && b.isbn && b.isbn !== 'NO-ISBN';
      html += `
        <div class="book-item" style="padding: 8px 12px;">
          <div class="book-left">
            <span class="book-index" style="width:22px; height:22px; font-size:10px;">#${idx + 1}</span>
            <div class="book-details">
              ${isBarcode ? `
                <span class="book-isbn" style="font-size:13px;">${escapeHtml(b.isbn)}</span>
                <span class="book-title" style="font-size:11px;">${escapeHtml(b.title)}</span>
              ` : `
                <span class="book-title" style="font-size:13px; font-weight:700; color:var(--text-main);">${escapeHtml(b.title)}</span>
                <span style="font-size:10px; font-weight:600; color:#d97706;">📖 Manual Title (No ISBN)</span>
              `}
            </div>
          </div>
          <div class="book-right">
            ${b.flag && b.flag !== 'normal' ? `<span style="font-size:10px; font-weight:700; color:#d97706; background:#fef3c7; padding:2px 6px; border-radius:4px;">${escapeHtml(b.flag.toUpperCase())}</span>` : ''}
            <span class="book-time">${escapeHtml(b.scanned_at || '')}</span>
            <button class="btn-delete-book" title="Delete from closed box" onclick="removeBookFromInspectBox(${idx})">
              🗑️
            </button>
          </div>
        </div>
      `;
    });
    listEl.innerHTML = html;
  }

  // Store current inspect record for export
  window._currentInspectBox = boxRecord;

  openModal('inspectModal');
}

function exportBoxCsv() {
  const box = window._currentInspectBox;
  if (!box || !box.books) return;

  let csv = 'Index,ISBN,Title,Scanned_Time,Flag,Rebox_Number,Sealed_By\n';
  box.books.forEach((b, i) => {
    csv += `"${i + 1}","${b.isbn || 'NO-ISBN'}","${(b.title || '').replace(/"/g, '""')}","${b.scanned_at || ''}","${b.flag || 'normal'}","${box.rebox_number}","${(box.sealed_by || 'Operator').replace(/"/g, '""')}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${getModeConfig().exportPrefix}-${box.rebox_number}-manifest.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${box.rebox_number} CSV.`);
}

function printBoxLabel(boxRecord) {
  if (boxRecord && boxRecord.rebox_number) {
    const printHeaderEl = document.getElementById('printLabelHeader');
    if (printHeaderEl) printHeaderEl.textContent = getModeConfig().printHeader;
    const printRbEl = document.getElementById('printRbNumber');
    if (printRbEl) printRbEl.textContent = boxRecord.rebox_number;
    const printDetEl = document.getElementById('printDetails');
    if (printDetEl) {
      printDetEl.innerHTML = `
        TOTAL BOOKS: ${boxRecord.book_count || (boxRecord.books || []).length}<br>
        SEALED BY: ${(boxRecord.sealed_by || 'OPERATOR').toUpperCase()}<br>
        DATE: ${new Date(boxRecord.assigned_at).toLocaleDateString()}<br>
        STATUS: SEALED & AUDITED
      `;
    }
  }
  window.print();
}

async function transferCurrentInspectBox() {
  const box = window._currentInspectBox;
  if (!box || !box.rebox_number) return;

  const srcModeId = box._modeId || activeMode;
  const targetModeId = srcModeId === 'not_found' ? 'others' : 'not_found';
  const srcConfig = getModeConfig(srcModeId);
  const targetConfig = getModeConfig(targetModeId);

  const transferBtn = document.getElementById('btnTransferBox');
  if (transferBtn) {
    transferBtn.disabled = true;
    transferBtn.textContent = 'Calculating...';
  }

  // Calculate highest existing box number in destination mode
  let maxNum = 0;
  if (isCloudConnected && supabaseClient && modeCloudReady[targetConfig.id] !== false) {
    try {
      const { data, error } = await supabaseClient
        .from(targetConfig.tableName)
        .select('rebox_number');
      if (!error && Array.isArray(data)) {
        data.forEach(b => {
          const digits = String(b.rebox_number || '').replace(/[^0-9]/g, '');
          const n = parseInt(digits, 10);
          if (!isNaN(n) && n > maxNum) maxNum = n;
        });
      }
    } catch (e) {
      console.warn('Error fetching target box count:', e);
    }
  }

  const localTargetReg = getStoredRegistry(targetModeId);
  localTargetReg.forEach(b => {
    const digits = String(b.rebox_number || '').replace(/[^0-9]/g, '');
    const n = parseInt(digits, 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  });

  const nextBoxNum = 'BOX-' + String(maxNum + 1).padStart(4, '0');
  const bookCount = box.book_count || (box.books || []).length;

  if (transferBtn) {
    transferBtn.disabled = false;
    transferBtn.textContent = `🔄 Transfer to ${targetConfig.label}`;
  }

  const confirmed = confirm(
    `Transfer ${box.rebox_number} from "${srcConfig.label}" to "${targetConfig.label}"?\n\n` +
    `• Target Category: ${targetConfig.label}\n` +
    `• New Sequential Box: ${nextBoxNum}\n` +
    `• Total Books: ${bookCount}\n` +
    `• Sealed By: ${box.sealed_by || 'Operator'}\n\n` +
    `The box will be safely transferred to ${targetConfig.label} as ${nextBoxNum}. Continue?`
  );

  if (!confirmed) return;

  if (transferBtn) {
    transferBtn.disabled = true;
    transferBtn.textContent = 'Transferring...';
  }

  try {
    const newRecord = {
      rebox_number: nextBoxNum,
      sealed_by: box.sealed_by || 'Operator',
      assigned_at: box.assigned_at || new Date().toISOString(),
      assigned_at_formatted: box.assigned_at_formatted || '',
      book_count: bookCount,
      status: 'Closed',
      books: box.books || []
    };

    if (isCloudConnected && supabaseClient && modeCloudReady[targetConfig.id] !== false && modeCloudReady[srcConfig.id] !== false) {
      const { error: insErr } = await supabaseClient
        .from(targetConfig.tableName)
        .insert(newRecord);
      if (insErr) throw insErr;

      const { error: delErr } = await supabaseClient
        .from(srcConfig.tableName)
        .delete()
        .eq('rebox_number', box.rebox_number);
      if (delErr) {
        console.warn('Supabase delete error during transfer:', delErr);
      }
    }

    // Update local storage registries for both modes
    const srcReg = getStoredRegistry(srcModeId).filter(b => b.rebox_number !== box.rebox_number);
    localStorage.setItem(srcConfig.storageRegistry, JSON.stringify(srcReg));

    const targetReg = getStoredRegistry(targetModeId).filter(b => b.rebox_number !== nextBoxNum);
    targetReg.unshift(newRecord);
    localStorage.setItem(targetConfig.storageRegistry, JSON.stringify(targetReg));

    closeModal('inspectModal');

    if (isCloudConnected && supabaseClient) {
      await Promise.all([
        fetchAndSyncSupabaseRegistry(srcModeId),
        fetchAndSyncSupabaseRegistry(targetModeId)
      ]);
    }

    playBeep('success');
    showToast(`✅ Successfully transferred ${box.rebox_number} to ${targetConfig.label} as ${nextBoxNum}!`);

    // Switch view to target mode so operator sees the new box immediately
    switchMode(targetModeId);
  } catch (err) {
    console.error('Transfer failed:', err);
    playBeep('error');
    showToast('Failed to transfer box: ' + err.message, 'error');
  } finally {
    if (transferBtn) {
      transferBtn.disabled = false;
      transferBtn.textContent = `🔄 Transfer to ${targetConfig.label}`;
    }
  }
}

// ── Manager Item Tracer ─────────────────────────────────────────────
function openIsbnTracerModal() {
  openModal('tracerModal');
  const input = document.getElementById('tracerSearchInput');
  if (input) input.value = '';
  const container = document.getElementById('tracerResultsContainer');
  if (container) {
    container.style.display = 'none';
    container.innerHTML = '';
  }
  const empty = document.getElementById('tracerEmptyState');
  if (empty) {
    empty.style.display = 'block';
    empty.textContent = 'Type an ISBN or Book Title above to search across all historical Box manifests.';
  }
  setTimeout(() => { if (input) input.focus(); }, 100);
}

function traceBook(query) {
  const term = (query || '').trim().toLowerCase();
  const container = document.getElementById('tracerResultsContainer');
  const empty = document.getElementById('tracerEmptyState');
  if (!container || !empty) return;

  if (term.length < 2) {
    container.style.display = 'none';
    container.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = 'Type an ISBN or Book Title above to search across all historical Box manifests.';
    return;
  }

  const cleanQueryDigits = term.replace(/[^0-9X]/gi, '');
  const registry = getStoredRegistry();
  const matches = [];

  for (const box of registry) {
    const matchingBooks = [];
    for (const book of (box.books || [])) {
      const bookIsbnClean = (book.isbn || '').replace(/[^0-9X]/gi, '').toLowerCase();
      const matchesIsbn = cleanQueryDigits.length >= 4 && bookIsbnClean.includes(cleanQueryDigits);
      const matchesTitle = (book.title || '').toLowerCase().includes(term);

      if (matchesIsbn || matchesTitle) {
        matchingBooks.push(book);
      }
    }

    if (matchingBooks.length > 0) {
      matches.push({
        box: box,
        matchedBooks: matchingBooks
      });
    }
  }

  if (matches.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = `No Box record found matching "${escapeHtml(query)}".`;
    return;
  }

  empty.style.display = 'none';
  container.style.display = 'flex';

  const totalCopies = matches.reduce((acc, m) => acc + m.matchedBooks.length, 0);

  let html = `
    <div style="font-size: 12px; font-weight: 700; color: var(--primary-hover); background: var(--primary-light); border: 1px solid var(--primary-border); padding: 8px 12px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center;">
      <span>⚡ Found in <strong>${matches.length}</strong> Different Box${matches.length === 1 ? '' : 'es'}</span>
      <span style="font-size: 11px; color: var(--border-focus);">Total copies recorded: ${totalCopies}</span>
    </div>
  `;

  matches.forEach(item => {
    const b = item.box;
    const boxNum = b.rebox_number || 'UNKNOWN';
    const totalInBox = b.book_count || (b.books || []).length;
    const sealedBy = b.sealed_by || 'Operator';
    const dateFormatted = b.assigned_at_formatted || (b.assigned_at ? new Date(b.assigned_at).toLocaleDateString() : 'N/A');

    const booksList = item.matchedBooks.map(bk => {
      const isBarcode = bk.is_isbn !== false && bk.isbn && bk.isbn !== 'NO-ISBN';
      const label = isBarcode
        ? `<strong style="font-family:var(--font-mono); color: var(--primary-hover);">${escapeHtml(bk.isbn)}</strong> — ${escapeHtml(bk.title || 'Physical Book')}`
        : `📖 <strong>${escapeHtml(bk.title)}</strong> <span style="font-size:10px; color:#d97706;">(Manual Entry)</span>`;
      const flagBadge = (bk.flag && bk.flag !== 'normal') ? `<span style="font-size:10px; color:#d97706; background:#fef3c7; padding:2px 6px; border-radius:4px; font-weight:600;">⚠️ ${escapeHtml(bk.flag)}</span>` : '';
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#ffffff; border:1px solid #e2e8f0; border-radius:6px; padding:6px 10px; font-size:12px; margin-top:4px;">
          <div>${label}</div>
          <div>${flagBadge}</div>
        </div>
      `;
    }).join('');

    html += `
      <div style="background: #f8fafc; border: 1.5px solid var(--primary-border); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 10px; font-weight: 800; color: var(--primary-hover); text-transform: uppercase; letter-spacing: 0.5px;">BOX ASSIGNED</span>
            <span style="font-size: 16px; font-weight: 800; font-family: var(--font-mono); color: var(--primary); background: #ffffff; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--primary-border);">
              ${escapeHtml(boxNum)}
            </span>
          </div>
          <button class="nav-btn primary" style="font-size: 11px; padding: 4px 10px;" onclick="viewRegistryBox('${escapeHtml(boxNum)}')">
            📦 Inspect Manifest
          </button>
        </div>

        <div>
          <div style="font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase;">MATCHED COPIES IN THIS BOX (${item.matchedBooks.length}):</div>
          ${booksList}
        </div>

        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 4px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: 11px;">
          <div>
            <div style="font-size: 9px; color:#64748b; font-weight:700; text-transform:uppercase;">TOTAL IN BOX</div>
            <div style="font-size: 13px; font-weight:700; color:#10b981;">${totalInBox} books</div>
          </div>
          <div>
            <div style="font-size: 9px; color:#64748b; font-weight:700; text-transform:uppercase;">SEALED BY</div>
            <div style="font-size: 12px; font-weight:600; color:#1e293b;">${escapeHtml(sealedBy)}</div>
          </div>
          <div>
            <div style="font-size: 9px; color:#64748b; font-weight:700; text-transform:uppercase;">DATE SEALED</div>
            <div style="font-size: 11px; font-weight:600; color:#0f172a;">${escapeHtml(dateFormatted)}</div>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function traceIsbn(query) {
  traceBook(query);
}

// ── Master Box Registry ─────────────────────────────────────────────
function isAdminUser() {
  return Boolean(currentAuthUser && currentAuthUser.role === 'admin');
}

function updateAdminControlsVisibility() {
  const isAdmin = isAdminUser();
  const adminBtn = document.getElementById('btnUserManagement');
  if (adminBtn) {
    adminBtn.style.display = isAdmin ? 'inline-flex' : 'none';
  }
  const resetBtn = document.getElementById('btnResetAllData');
  if (resetBtn) {
    resetBtn.style.display = isAdmin ? 'inline-flex' : 'none';
  }
}

function openMasterRegistryModal() {
  updateAdminControlsVisibility();
  renderMasterRegistry();
  openModal('registryModal');
}

function renderMasterRegistry() {
  const registry = getStoredRegistry();
  const filter = (document.getElementById('registryFilterInput')?.value || '').trim().toLowerCase();
  const tbody = document.getElementById('registryTableBody');

  let filtered = registry;
  if (filter) {
    filtered = registry.filter(r => 
      (r.rebox_number || '').toLowerCase().includes(filter) ||
      (r.sealed_by || '').toLowerCase().includes(filter) ||
      (r.books || []).some(b => 
        (b.isbn || '').toLowerCase().includes(filter) || 
        (b.title || '').toLowerCase().includes(filter)
      )
    );
  }

  document.getElementById('registryTotalCount').textContent = `${filtered.length} of ${registry.length} Boxes`;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding: 24px; text-align: center; color: #94a3b8;">No Box packages recorded yet.</td></tr>`;
    return;
  }

  let html = '';
  filtered.forEach(r => {
    html += `
      <tr style="border-bottom: 1px solid var(--border-color);">
        <td style="padding: 10px 14px; font-weight:700; font-family:var(--font-mono); color: var(--primary);">${escapeHtml(r.rebox_number)}</td>
        <td style="padding: 10px 14px; font-family:var(--font-mono); font-weight:600; color:#10b981;">${r.book_count || (r.books || []).length}</td>
        <td style="padding: 10px 14px; font-size:12px; color:#64748b;">${r.assigned_at_formatted || new Date(r.assigned_at).toLocaleDateString()}</td>
        <td style="padding: 10px 14px; font-size:12px; font-weight:600; color:#334155;">${escapeHtml(r.sealed_by || 'Operator')}</td>
        <td style="padding: 10px 14px; text-align:right;">
          <button class="nav-btn" style="padding: 4px 8px; font-size:11px;" onclick="viewRegistryBox('${escapeHtml(r.rebox_number)}')">
            Inspect ➔
          </button>
        </td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
}

function viewRegistryBox(rbNumber) {
  const registry = getStoredRegistry();
  const box = registry.find(r => r.rebox_number === rbNumber);
  if (box) {
    closeModal('registryModal');
    closeModal('tracerModal');
    openInspectModalForBox(box);
  }
}

function exportAllRegistryCsv() {
  const registry = getStoredRegistry();
  if (registry.length === 0) {
    showToast('No Box records to export.', 'error');
    return;
  }

  let csv = 'Box_Number,Book_Count,Date_Closed,Sealed_By,ISBN_And_Titles_List\n';
  registry.forEach(r => {
    const isbns = (r.books || []).map(b => b.is_isbn !== false && b.isbn && b.isbn !== 'NO-ISBN' ? b.isbn : `[Title] ${b.title}`).join('; ');
    csv += `"${r.rebox_number}","${r.book_count || (r.books || []).length}","${r.assigned_at}","${(r.sealed_by || 'Operator').replace(/"/g, '""')}","${isbns.replace(/"/g, '""')}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${getModeConfig().exportPrefix}-All-Boxes-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${getModeConfig().label} Master Box Registry.`);
}

async function confirmResetAllData() {
  if (!isAdminUser()) {
    showToast('Administrator privileges required to reset box data.', 'error');
    return;
  }

  const modeCfg = getModeConfig();
  const confirmed = confirm(
    `⚠️ RESET ALL "${modeCfg.label.toUpperCase()}" BOX DATA?\n\n` +
    `This will permanently delete all recorded ${modeCfg.label} boxes from Supabase and local storage, restarting the ${modeCfg.label} counter at BOX-0001.\n\n` +
    'Are you sure you want a fresh start?'
  );

  if (!confirmed) return;

  try {
    if (isCloudConnected && supabaseClient && modeCloudReady[modeCfg.id] !== false) {
      const { error } = await supabaseClient
        .from(modeCfg.tableName)
        .delete()
        .gt('id', 0);

      if (error) {
        console.warn('Supabase delete error:', error);
      }
    }

    localStorage.setItem(modeCfg.storageRegistry, '[]');
    localStorage.setItem(modeCfg.storageCounter, '0');
    currentScannedBooks = [];
    currentAssignedRebox = null;
    saveActiveSession(modeCfg.id);

    updateUiState();
    updateReboxCountStat();
    renderFeed();
    populateBoxDropdown();

    if (document.getElementById('registryModal')?.classList.contains('active')) {
      renderMasterRegistry();
    }

    playBeep('success');
    showToast(`✨ All ${modeCfg.label} box records wiped! Starting fresh at BOX-0001.`);
  } catch (err) {
    console.error('Error resetting data:', err);
    showToast('Reset error: ' + err.message, 'error');
  }
}

// ── Sheet / CSV Import Logic ────────────────────────────────────────
let currentParsedImportItems = [];

function openImportModal() {
  currentParsedImportItems = [];
  document.getElementById('importTextarea').value = '';
  document.getElementById('importFileInput').value = '';
  document.getElementById('importSelectedFileName').style.display = 'none';
  document.getElementById('importPreviewContainer').style.display = 'none';
  document.getElementById('btnExecuteImport').disabled = true;
  document.getElementById('btnExecuteImport').textContent = '📥 Complete Import (0 Books)';
  switchImportTab('paste');
  openModal('importModal');
}

function switchImportTab(tab) {
  const tabPaste = document.getElementById('importTabPaste');
  const tabFile = document.getElementById('importTabFile');
  const sectionPaste = document.getElementById('importPasteSection');
  const sectionFile = document.getElementById('importFileSection');

  if (tab === 'paste') {
    tabPaste.className = 'nav-btn primary';
    tabFile.className = 'nav-btn';
    sectionPaste.style.display = 'flex';
    sectionFile.style.display = 'none';
    setTimeout(() => document.getElementById('importTextarea').focus(), 50);
  } else {
    tabPaste.className = 'nav-btn';
    tabFile.className = 'nav-btn primary';
    sectionPaste.style.display = 'none';
    sectionFile.style.display = 'flex';
  }
}

function handleImportTextChange() {
  const text = document.getElementById('importTextarea').value;
  const parsed = parseSheetData(text);
  currentParsedImportItems = parsed;
  renderImportPreview(parsed);
}

function handleImportFileSelect(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const nameLabel = document.getElementById('importSelectedFileName');
  nameLabel.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
  nameLabel.style.display = 'block';

  const reader = new FileReader();
  reader.onload = function(evt) {
    const content = evt.target.result || '';
    document.getElementById('importTextarea').value = content;
    const parsed = parseSheetData(content);
    currentParsedImportItems = parsed;
    renderImportPreview(parsed);
  };
  reader.readAsText(file);
}

function parseSheetData(rawText) {
  if (!rawText || !rawText.trim()) return [];

  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return [];

  // Detect delimiter: tab, comma, or semicolon
  const firstLine = lines[0];
  let delimiter = ',';
  if (firstLine.includes('\t')) {
    delimiter = '\t';
  } else if (firstLine.includes(';') && !firstLine.includes(',')) {
    delimiter = ';';
  }

  function splitLine(line, delim) {
    if (delim === '\t') return line.split('\t').map(s => s.trim().replace(/^["']|["']$/g, ''));
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === delim && !inQuotes) {
        result.push(cur.trim().replace(/^["']|["']$/g, ''));
        cur = '';
      } else {
        cur += c;
      }
    }
    result.push(cur.trim().replace(/^["']|["']$/g, ''));
    return result;
  }

  const rawRows = lines.map(l => splitLine(l, delimiter));
  if (rawRows.length === 0) return [];

  // Check header row
  let startIndex = 0;
  let colIndex = -1;
  let colIsbn = -1;
  let colTitle = -1;
  let colBox = -1;

  const header = rawRows[0].map(h => (h || '').toLowerCase().trim());
  const isHeader = header.some(h => 
    h.includes('isbn') || h.includes('barcode') || h.includes('title') || 
    h.includes('book') || h.includes('box') || h === '#' || h === 'no' || h === 'no.' || h === 'count'
  );

  if (isHeader) {
    startIndex = 1;
    colIndex = header.findIndex(h => h === '#' || h === 'no' || h === 'no.' || h === 'count' || h === 'item' || h === 'index');
    colIsbn = header.findIndex(h => h.includes('isbn') || h.includes('barcode') || h.includes('ean'));
    colTitle = header.findIndex(h => h.includes('title') || h.includes('book') || h.includes('name'));
    colBox = header.findIndex(h => h.includes('box') || h.includes('package') || h.includes('bin') || h.includes('rebox'));
  }

  // Automatic multi-row heuristic column detection if columns unassigned
  if (colBox === -1 || (colIsbn === -1 && colTitle === -1)) {
    const dataRows = rawRows.slice(startIndex, Math.min(startIndex + 15, rawRows.length));
    const numCols = dataRows.reduce((max, r) => Math.max(max, r.length), 0);

    const colProfiles = [];
    for (let c = 0; c < numCols; c++) {
      let isSequential = true;
      let isbnMatchCount = 0;
      let titleMatchCount = 0;
      let smallIntCount = 0;
      let distinctValues = new Set();

      dataRows.forEach((r, idx) => {
        const val = (r[c] || '').trim();
        distinctValues.add(val);
        const intVal = parseInt(val, 10);
        // Sequential check (e.g. 1, 2, 3...)
        if (intVal !== idx + 1 && intVal !== idx) {
          isSequential = false;
        }
        // Small int check (e.g. 1, 2, ... <= 500)
        if (/^\d{1,4}$/.test(val)) {
          smallIntCount++;
        }
        // Clean ISBN check (8 to 18 digits or ending with X)
        const cleanD = val.replace(/[^0-9X]/gi, '');
        if (cleanD.length >= 8 && cleanD.length <= 18 && !/[a-wy-z]/i.test(val)) {
          isbnMatchCount++;
        }
        // Title check (contains multiple letters or words)
        if (/[a-zA-Z]{3,}/.test(val)) {
          titleMatchCount++;
        }
      });

      colProfiles.push({
        col: c,
        isSequential: isSequential && dataRows.length > 1,
        isbnRatio: isbnMatchCount / (dataRows.length || 1),
        titleRatio: titleMatchCount / (dataRows.length || 1),
        smallIntRatio: smallIntCount / (dataRows.length || 1),
        distinctCount: distinctValues.size
      });
    }

    // 1. Identify Row Index Column (1, 2, 3, 4...)
    let identifiedIndexCol = colIndex;
    if (identifiedIndexCol === -1) {
      const idxCandidate = colProfiles.find(p => p.isSequential && p.isbnRatio < 0.5 && p.col === 0);
      if (idxCandidate) {
        identifiedIndexCol = idxCandidate.col;
      }
    }

    // 2. Identify ISBN Column
    if (colIsbn === -1) {
      const isbnCandidate = colProfiles.find(p => p.col !== identifiedIndexCol && p.isbnRatio >= 0.5);
      if (isbnCandidate) {
        colIsbn = isbnCandidate.col;
      }
    }

    // 3. Identify Title Column
    if (colTitle === -1) {
      const titleCandidate = colProfiles.find(p => p.col !== identifiedIndexCol && p.col !== colIsbn && p.titleRatio >= 0.5);
      if (titleCandidate) {
        colTitle = titleCandidate.col;
      }
    }

    // 4. Identify Box Column
    if (colBox === -1) {
      const boxCandidates = colProfiles.filter(p => p.col !== identifiedIndexCol && p.col !== colIsbn && p.col !== colTitle);
      if (boxCandidates.length > 0) {
        const smallIntCol = boxCandidates.find(p => p.smallIntRatio >= 0.5);
        if (smallIntCol) {
          colBox = smallIntCol.col;
        } else {
          colBox = boxCandidates[boxCandidates.length - 1].col;
        }
      } else if (numCols === 2) {
        if (colIsbn === 0) colBox = 1;
        else if (colIsbn === 1) colBox = 0;
      }
    }

    // Fallback if ISBN/Title still not mapped
    if (colIsbn === -1 && colTitle === -1) {
      const remainingCols = colProfiles.filter(p => p.col !== identifiedIndexCol && p.col !== colBox);
      if (remainingCols.length > 0) {
        colIsbn = remainingCols[0].col;
      } else {
        colIsbn = (colBox === 0 ? 1 : 0);
      }
    }
  }

  const parsedItems = [];
  for (let i = startIndex; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (row.length === 0 || (row.length === 1 && !row[0])) continue;

    let rawVal = '';
    let parsedBook = null;

    if (colIsbn !== -1 && colTitle !== -1 && row[colIsbn] !== undefined && row[colTitle] !== undefined) {
      const isbnVal = row[colIsbn].trim();
      const titleVal = row[colTitle].trim();
      const isbnObj = parseBookString(isbnVal);
      if (isbnObj.is_isbn) {
        parsedBook = {
          isbn: isbnObj.isbn,
          title: titleVal || isbnObj.title,
          is_isbn: true
        };
        rawVal = `${isbnObj.isbn} - ${titleVal}`;
      } else {
        parsedBook = {
          isbn: 'NO-ISBN',
          title: titleVal || isbnVal || 'Untitled Book',
          is_isbn: false
        };
        rawVal = titleVal || isbnVal;
      }
    } else {
      const col = colIsbn !== -1 ? colIsbn : (colTitle !== -1 ? colTitle : 0);
      rawVal = (row[col] !== undefined ? row[col] : row[0] || '').trim();
      if (!rawVal) continue;
      parsedBook = parseBookString(rawVal);
    }

    let boxVal = colBox >= 0 && row[colBox] !== undefined ? row[colBox].trim() : '1';
    if (!boxVal) boxVal = '1';
    const normBox = normalizeBoxNumber(boxVal, 1);

    parsedItems.push({
      raw: rawVal,
      isbn: parsedBook.isbn,
      title: parsedBook.title,
      is_isbn: parsedBook.is_isbn,
      box_num: normBox
    });
  }

  return parsedItems;
}

function renderImportPreview(items) {
  const previewContainer = document.getElementById('importPreviewContainer');
  const badgesContainer = document.getElementById('importSummaryBadges');
  const tbody = document.getElementById('importPreviewTableBody');
  const btnExecute = document.getElementById('btnExecuteImport');

  if (!items || items.length === 0) {
    previewContainer.style.display = 'none';
    btnExecute.disabled = true;
    btnExecute.textContent = '📥 Complete Import (0 Books)';
    return;
  }

  previewContainer.style.display = 'flex';
  btnExecute.disabled = false;
  btnExecute.textContent = `📥 Complete Import (${items.length} Books)`;

  // Count stats
  const uniqueBoxes = new Set(items.map(i => i.box_num));
  const isbnCount = items.filter(i => i.is_isbn).length;
  const titleCount = items.length - isbnCount;

  badgesContainer.innerHTML = `
    <span style="font-size:11px; font-weight:700; color: var(--primary-hover); background: var(--primary-light); padding:3px 8px; border-radius:4px; border:1px solid var(--primary-border);">
      ${items.length} Books
    </span>
    <span style="font-size:11px; font-weight:700; color:#065f46; background:#ecfdf5; padding:3px 8px; border-radius:4px; border:1px solid #a7f3d0;">
      ${uniqueBoxes.size} Box${uniqueBoxes.size === 1 ? '' : 'es'}
    </span>
    ${titleCount > 0 ? `
      <span style="font-size:11px; font-weight:700; color:#92400e; background:#fef3c7; padding:3px 8px; border-radius:4px; border:1px solid #fde68a;">
        ${titleCount} Manual Title${titleCount === 1 ? '' : 's'}
      </span>
    ` : ''}
  `;

  // Render up to 50 preview rows
  let rowsHtml = '';
  items.slice(0, 50).forEach((item, idx) => {
    rowsHtml += `
      <tr style="border-bottom: 1px solid var(--border-color);">
        <td style="padding: 6px 10px; color:#64748b; font-weight:600;">#${idx + 1}</td>
        <td style="padding: 6px 10px; font-weight:600; color:#0f172a;">${escapeHtml(item.is_isbn ? item.isbn : item.title)}</td>
        <td style="padding: 6px 10px;">
          ${item.is_isbn 
            ? '<span style="color: var(--primary); font-weight:700;">Barcode/ISBN</span>' 
            : '<span style="color:#d97706; font-weight:700;">📖 Manual Title</span>'}
        </td>
        <td style="padding: 6px 10px; font-family:var(--font-mono); font-weight:700; color:#475569;">${escapeHtml(item.box_num)}</td>
      </tr>
    `;
  });

  if (items.length > 50) {
    rowsHtml += `
      <tr>
        <td colspan="4" style="padding: 8px 10px; text-align: center; color: #64748b; font-weight:600; font-style: italic;">
          ...and ${items.length - 50} more items
        </td>
      </tr>
    `;
  }

  tbody.innerHTML = rowsHtml;
}

async function executeImport() {
  if (!currentParsedImportItems || currentParsedImportItems.length === 0) {
    showToast('No books to import.', 'error');
    return;
  }

  const targetOption = document.querySelector('input[name="importTargetOption"]:checked')?.value || 'registry';

  if (targetOption === 'active') {
    // Import into current working package
    if (currentAssignedRebox) {
      showToast(`Active box ${currentAssignedRebox} is closed. Please start a next box first.`, 'error');
      return;
    }

    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];

    currentParsedImportItems.forEach(item => {
      currentScannedBooks.unshift({
        isbn: item.isbn,
        title: item.title,
        is_isbn: item.is_isbn,
        scanned_at: timeStr,
        timestamp: now.toISOString(),
        flag: 'normal'
      });
    });

    saveActiveSession();
    updateUiState();
    closeModal('importModal');
    playBeep('success');
    showToast(`📥 Successfully imported ${currentParsedImportItems.length} books into current working box!`);

  } else {
    // Import as sealed Boxes into Master Registry
    const importBtn = document.getElementById('btnExecuteImport');
    const originalBtnText = importBtn ? importBtn.innerHTML : '';
    if (importBtn) {
      importBtn.disabled = true;
      importBtn.textContent = '⏳ Importing Boxes...';
    }

    try {
      const modeCfg = getModeConfig();
      const registry = getStoredRegistry(modeCfg.id);
      const now = new Date();
      const operator = currentOperatorName || 'Import';
      let useCloudForImport = isCloudConnected && supabaseClient && modeCloudReady[modeCfg.id] !== false;

      // Group items by normalized box number
      const boxMap = new Map();
      currentParsedImportItems.forEach(item => {
        const normBox = normalizeBoxNumber(item.box_num, 1);
        if (!boxMap.has(normBox)) boxMap.set(normBox, []);
        boxMap.get(normBox).push(item);
      });

      let importedBoxesCount = 0;
      let assignedBoxNames = [];
      let newRecords = [];

      for (const [boxName, boxItems] of boxMap.entries()) {
        const books = boxItems.map(b => ({
          isbn: b.isbn || '',
          title: b.title || b.isbn || 'Unknown Book',
          is_isbn: Boolean(b.is_isbn),
          scanned_at: 'Imported',
          timestamp: now.toISOString(),
          flag: 'normal'
        }));

        const newBoxRecord = {
          rebox_number: boxName,
          sealed_by: operator,
          assigned_at: now.toISOString(),
          assigned_at_formatted: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
          book_count: books.length,
          status: 'Closed',
          books: books
        };

        if (useCloudForImport) {
          // Check if box already exists in Supabase
          const { data: existingBox, error: fetchErr } = await supabaseClient
            .from(modeCfg.tableName)
            .select('*')
            .eq('rebox_number', boxName)
            .maybeSingle();

          if (isMissingTableError(fetchErr)) {
            modeCloudReady[modeCfg.id] = false;
            setCloudStatus(true);
            useCloudForImport = false;
          } else if (!fetchErr && existingBox) {
            // Merge books into existing box
            const existingBooks = Array.isArray(existingBox.books) ? existingBox.books : [];
            const mergedBooks = [...existingBooks, ...books];
            const { data: updatedBox, error: upErr } = await supabaseClient
              .from(modeCfg.tableName)
              .update({
                books: mergedBooks,
                book_count: mergedBooks.length,
                assigned_at_formatted: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
              })
              .eq('id', existingBox.id)
              .select()
              .single();

            if (upErr) throw new Error(`Failed to update ${boxName}: ${upErr.message}`);
            newRecords.push(updatedBox || newBoxRecord);
          } else {
            // Insert new box with exact boxName
            const { data: insertedBox, error: insErr } = await supabaseClient
              .from(modeCfg.tableName)
              .insert([newBoxRecord])
              .select()
              .single();

            if (insErr) {
              if (isMissingTableError(insErr)) {
                modeCloudReady[modeCfg.id] = false;
                setCloudStatus(true);
                useCloudForImport = false;
              } else {
                throw new Error(`Failed to insert ${boxName}: ${insErr.message}`);
              }
            } else {
              newRecords.push(insertedBox || newBoxRecord);
            }
          }
        }

        if (!useCloudForImport) {
          // Local fallback
          const existingIdx = registry.findIndex(r => normalizeBoxNumber(r.rebox_number) === boxName);
          if (existingIdx !== -1) {
            const existingBooks = Array.isArray(registry[existingIdx].books) ? registry[existingIdx].books : [];
            registry[existingIdx].books = [...existingBooks, ...books];
            registry[existingIdx].book_count = registry[existingIdx].books.length;
            newRecords.push(registry[existingIdx]);
          } else {
            registry.unshift(newBoxRecord);
            newRecords.push(newBoxRecord);
          }
        }

        importedBoxesCount++;
        assignedBoxNames.push(boxName);
      }

      if (useCloudForImport) {
        await fetchAndSyncSupabaseRegistry(modeCfg.id);
      } else {
        saveRegistry(registry, modeCfg.id);
      }

      // Update counter based on highest imported box number
      let maxNum = 0;
      assignedBoxNames.forEach(name => {
        const m = name.match(/\d+/);
        if (m) maxNum = Math.max(maxNum, parseInt(m[0], 10));
      });
      const curStored = parseInt(localStorage.getItem(modeCfg.storageCounter) || '0', 10);
      localStorage.setItem(modeCfg.storageCounter, String(Math.max(curStored, maxNum)));

      updateUiState();
      closeModal('importModal');
      playBeep('box_closed');

      showToast(`📥 [${modeCfg.label}] Successfully imported ${currentParsedImportItems.length} books into ${importedBoxesCount} Box${importedBoxesCount === 1 ? '' : 'es'} (${assignedBoxNames.join(', ')})!`);
    } catch (err) {
      console.error('Import error:', err);
      showToast('Import failed: ' + err.message, 'error');
    } finally {
      if (importBtn) {
        importBtn.disabled = false;
        importBtn.innerHTML = originalBtnText;
      }
    }
  }
}

// ── Mobile / Camera Scanner ─────────────────────────────────────────
async function openCameraScanner() {
  openModal('cameraModal');
  const video = document.getElementById('cameraVideo');
  const statusText = document.getElementById('cameraStatusText');

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
    video.srcObject = cameraStream;
    await video.play();

    // Check if native BarcodeDetector API is available (Chrome / Edge / Android)
    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'qr_code', 'upc_a'] });
      cameraInterval = setInterval(async () => {
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0) {
            const detectedIsbn = barcodes[0].rawValue;
            closeCameraScanner();
            processScannedIsbn(detectedIsbn);
          }
        } catch (err) {}
      }, 300);
    } else {
      statusText.textContent = 'Camera active. For automated scanning, use a USB/Bluetooth barcode scanner or Chrome/Edge mobile.';
    }
  } catch (err) {
    statusText.textContent = 'Camera access denied or unavailable.';
  }
}

function closeCameraScanner() {
  if (cameraInterval) clearInterval(cameraInterval);
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  closeModal('cameraModal');
}

// ── Modal Generic Helpers ───────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

// ── User Authentication & Role Authorization (Staff & Admin) ────────
let currentAuthUser = null;
let cachedUsersList = [];
let activeUserFilter = 'all';

function getStoredLocalUsers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USERS);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveLocalUsers(users) {
  localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(users));
}

async function getTotalUserCount() {
  if (isCloudConnected && supabaseClient) {
    try {
      const { count, error } = await supabaseClient
        .from('app_users')
        .select('*', { count: 'exact', head: true });
      if (!error && typeof count === 'number') {
        return count;
      }
    } catch {
      // fallback to local count
    }
  }
  const local = getStoredLocalUsers();
  return local.length;
}

async function checkFirstUserSetup() {
  const notice = document.getElementById('firstUserAdminNotice');
  const roleSelect = document.getElementById('authRegRole');
  if (!notice) return;

  const count = await getTotalUserCount();
  if (count === 0) {
    notice.style.display = 'block';
    if (roleSelect) roleSelect.value = 'admin';
  } else {
    notice.style.display = 'none';
  }
}

async function hashPassword(password, usernameLower) {
  const input = `${usernameLower}:${password}`;
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fallback deterministic hash for non-HTTPS / file:// contexts
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'fb-' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function setAuthMessage(msg = '', type = 'error') {
  const box = document.getElementById('authMessageBox');
  if (!box) return;
  if (!msg) {
    box.style.display = 'none';
    box.textContent = '';
    box.className = 'auth-message';
    return;
  }
  box.textContent = msg;
  box.className = `auth-message ${type === 'error' ? '' : type}`.trim();
  box.style.display = 'block';
}

function switchAuthTab(tab) {
  const isSignIn = tab !== 'signup';
  const tabIn = document.getElementById('authTabSignIn');
  const tabUp = document.getElementById('authTabSignUp');
  const formIn = document.getElementById('authSignInForm');
  const formUp = document.getElementById('authSignUpForm');

  if (tabIn) {
    tabIn.classList.toggle('active', isSignIn);
    tabIn.setAttribute('aria-selected', String(isSignIn));
  }
  if (tabUp) {
    tabUp.classList.toggle('active', !isSignIn);
    tabUp.setAttribute('aria-selected', String(!isSignIn));
  }
  if (formIn) formIn.style.display = isSignIn ? 'flex' : 'none';
  if (formUp) formUp.style.display = isSignIn ? 'none' : 'flex';

  setAuthMessage('');

  if (!isSignIn) {
    checkFirstUserSetup();
  }

  const focusId = isSignIn ? 'authLoginUsername' : 'authRegUsername';
  const focusEl = document.getElementById(focusId);
  if (focusEl) setTimeout(() => focusEl.focus(), 20);
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  if (btn) btn.textContent = show ? '🙈' : '👁️';
}

function handleForgotPassword() {
  setAuthMessage(
    'Please contact a warehouse Administrator to reset or approve your account credentials.',
    'info'
  );
}

function applySignedInUser(user) {
  const role = (user.role || 'staff').toLowerCase();
  const status = (user.status || 'approved').toLowerCase();

  currentAuthUser = {
    username: user.username,
    role: role,
    status: status
  };

  localStorage.setItem(STORAGE_KEY_AUTH_SESSION, JSON.stringify({
    username: user.username,
    role: role,
    status: status,
    signedInAt: new Date().toISOString()
  }));

  const badge = document.getElementById('authUserBadge');
  const nameLabel = document.getElementById('authUserNameLabel');
  const roleBadge = document.getElementById('authUserRoleBadge');
  const adminBtn = document.getElementById('btnUserManagement');

  if (nameLabel) nameLabel.textContent = user.username;
  if (roleBadge) {
    roleBadge.textContent = role.toUpperCase();
    roleBadge.className = `auth-role-tag ${role === 'admin' ? 'admin' : 'staff'}`;
  }
  if (badge) badge.style.display = 'inline-flex';

  // Toggle Admin capabilities
  updateAdminControlsVisibility();

  if (role === 'admin') {
    fetchAndSyncUsers();
  }

  // Auto-populate operator name so sealed boxes track the signed-in user
  handleOperatorNameChange(user.username);

  const overlay = document.getElementById('authOverlay');
  if (overlay) overlay.classList.remove('active');

  const scannerInput = document.getElementById('barcodeScannerInput');
  if (scannerInput) scannerInput.focus();
}

function initAuthState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_AUTH_SESSION);
    if (raw) {
      const session = JSON.parse(raw);
      if (session && session.username) {
        // Quick local check if user was rejected or demoted
        const localUsers = getStoredLocalUsers();
        const matched = localUsers.find(u => u.username_lower === session.username.toLowerCase());
        if (matched) {
          if (matched.status === 'pending' || matched.status === 'rejected') {
            signOutUser();
            return;
          }
          applySignedInUser({
            username: matched.username,
            role: matched.role || session.role || 'staff',
            status: matched.status || 'approved'
          });
          return;
        }

        applySignedInUser({
          username: session.username,
          role: session.role || 'staff',
          status: session.status || 'approved'
        });
        return;
      }
    }
  } catch {
    // Invalid saved session; require sign in
  }

  const overlay = document.getElementById('authOverlay');
  if (overlay) overlay.classList.add('active');
  switchAuthTab('signin');
}

function signOutUser() {
  currentAuthUser = null;
  localStorage.removeItem(STORAGE_KEY_AUTH_SESSION);

  const badge = document.getElementById('authUserBadge');
  if (badge) badge.style.display = 'none';

  const adminBtn = document.getElementById('btnUserManagement');
  if (adminBtn) adminBtn.style.display = 'none';
  const resetBtn = document.getElementById('btnResetAllData');
  if (resetBtn) resetBtn.style.display = 'none';

  const loginPass = document.getElementById('authLoginPassword');
  if (loginPass) loginPass.value = '';
  const regPass = document.getElementById('authRegPassword');
  if (regPass) regPass.value = '';
  const regConfirm = document.getElementById('authRegConfirmPassword');
  if (regConfirm) regConfirm.value = '';

  const overlay = document.getElementById('authOverlay');
  if (overlay) overlay.classList.add('active');
  switchAuthTab('signin');
  showToast('Signed out.');
}

async function handleSignInSubmit(e) {
  if (e) e.preventDefault();
  setAuthMessage('');

  const usernameInput = document.getElementById('authLoginUsername');
  const passwordInput = document.getElementById('authLoginPassword');
  const submitBtn = document.getElementById('btnSignInSubmit');

  const username = (usernameInput?.value || '').trim();
  const password = passwordInput?.value || '';
  const usernameLower = username.toLowerCase();

  if (!username || !password) {
    setAuthMessage('Please enter both your username and password.');
    return;
  }

  const originalHtml = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing In...';
  }

  try {
    const passHash = await hashPassword(password, usernameLower);
    let matchedUser = null;
    let checkedCloud = false;

    if (isCloudConnected && supabaseClient) {
      const { data: cloudUser, error } = await supabaseClient
        .from('app_users')
        .select('*')
        .eq('username_lower', usernameLower)
        .maybeSingle();

      if (!error) {
        checkedCloud = true;
        if (cloudUser) {
          if (cloudUser.password_hash !== passHash) {
            setAuthMessage('Incorrect password. Please try again.');
            return;
          }
          matchedUser = {
            id: cloudUser.id,
            username: cloudUser.username,
            username_lower: cloudUser.username_lower,
            role: cloudUser.role || 'staff',
            status: cloudUser.status || 'approved'
          };
        }
      } else if (!isMissingTableError(error)) {
        console.warn('Supabase auth lookup error:', error);
      }
    }

    if (!matchedUser) {
      const localUsers = getStoredLocalUsers();
      const localUser = localUsers.find(u => u.username_lower === usernameLower);
      if (localUser) {
        if (localUser.password_hash !== passHash) {
          setAuthMessage('Incorrect password. Please try again.');
          return;
        }
        matchedUser = {
          id: localUser.id,
          username: localUser.username,
          username_lower: localUser.username_lower,
          role: localUser.role || 'staff',
          status: localUser.status || 'approved'
        };
      } else if (checkedCloud || !isCloudConnected) {
        setAuthMessage('Account not found. Check your username or register a new account.');
        return;
      } else {
        setAuthMessage('Account not found. Please sign up first.');
        return;
      }
    }

    // Role & Approval verification:
    if (matchedUser.status === 'pending') {
      setAuthMessage('⏳ Account Pending Approval: An administrator must approve your account before you can sign in. Please contact your supervisor.');
      playBeep('error');
      return;
    }

    if (matchedUser.status === 'rejected') {
      setAuthMessage('🚫 Account Inactive: Your account has been rejected or disabled by an administrator.');
      playBeep('error');
      return;
    }

    if (passwordInput) passwordInput.value = '';
    applySignedInUser(matchedUser);
    playBeep('success');
    showToast(`Welcome back, ${escapeHtml(matchedUser.username)} (${matchedUser.role.toUpperCase()})!`);
  } catch (err) {
    console.error('Sign in error:', err);
    setAuthMessage('Unable to sign in: ' + err.message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalHtml;
    }
  }
}

async function handleSignUpSubmit(e) {
  if (e) e.preventDefault();
  setAuthMessage('');

  const usernameInput = document.getElementById('authRegUsername');
  const passwordInput = document.getElementById('authRegPassword');
  const confirmInput = document.getElementById('authRegConfirmPassword');
  const roleSelect = document.getElementById('authRegRole');
  const submitBtn = document.getElementById('btnSignUpSubmit');

  const username = (usernameInput?.value || '').trim();
  const password = passwordInput?.value || '';
  const confirmPass = confirmInput?.value || '';
  const requestedRole = (roleSelect?.value || 'staff') === 'admin' ? 'admin' : 'staff';
  const usernameLower = username.toLowerCase();

  if (username.length < 2) {
    setAuthMessage('Username must be at least 2 characters.');
    return;
  }
  if (password.length < 4) {
    setAuthMessage('Password must be at least 4 characters.');
    return;
  }
  if (password !== confirmPass) {
    setAuthMessage('Passwords do not match.');
    return;
  }

  const originalHtml = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating Account...';
  }

  try {
    const passHash = await hashPassword(password, usernameLower);
    const localUsers = getStoredLocalUsers();

    if (localUsers.some(u => u.username_lower === usernameLower)) {
      setAuthMessage('That username is already registered. Please sign in instead.');
      return;
    }

    // Determine if this is the bootstrap user (first user = approved admin)
    const totalUsers = await getTotalUserCount();
    const isFirstUser = totalUsers === 0;

    const userRole = isFirstUser ? 'admin' : requestedRole;
    const userStatus = isFirstUser ? 'approved' : 'pending';

    const newUser = {
      username,
      username_lower: usernameLower,
      password_hash: passHash,
      role: userRole,
      status: userStatus,
      created_at: new Date().toISOString(),
      approved_at: isFirstUser ? new Date().toISOString() : null,
      approved_by: isFirstUser ? 'System Bootstrap' : null
    };

    if (isCloudConnected && supabaseClient) {
      const { data: existingCloud, error: checkErr } = await supabaseClient
        .from('app_users')
        .select('username_lower')
        .eq('username_lower', usernameLower)
        .maybeSingle();

      if (!checkErr && existingCloud) {
        setAuthMessage('That username is already taken. Please choose another or sign in.');
        return;
      }

      if (!checkErr) {
        const { error: insErr } = await supabaseClient
          .from('app_users')
          .insert([newUser]);
        if (insErr && !isMissingTableError(insErr)) {
          if (String(insErr.code) === '23505') {
            setAuthMessage('That username is already taken. Please sign in instead.');
            return;
          }
          throw new Error(insErr.message);
        }
      }
    }

    localUsers.push(newUser);
    saveLocalUsers(localUsers);

    if (passwordInput) passwordInput.value = '';
    if (confirmInput) confirmInput.value = '';

    if (isFirstUser) {
      applySignedInUser(newUser);
      showToast(`👑 Welcome Administrator! You are the first registered user.`);
    } else {
      // Do NOT sign in pending users. Redirect to sign in with message.
      switchAuthTab('signin');
      setAuthMessage(
        `✅ Registration successful for "${escapeHtml(username)}"! Your account is pending Administrator approval before you can sign in.`,
        'success'
      );
      showToast('Registration submitted! Pending admin approval.', 'warning');
      const loginUserInput = document.getElementById('authLoginUsername');
      if (loginUserInput) loginUserInput.value = username;
    }
  } catch (err) {
    console.error('Sign up error:', err);
    setAuthMessage('Unable to create account: ' + err.message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalHtml;
    }
  }
}

// ── Admin User Management & Approvals ───────────────────────────────
function openUserManagementModal() {
  if (!currentAuthUser || currentAuthUser.role !== 'admin') {
    showToast('Administrator privileges required to manage users.', 'error');
    return;
  }
  openModal('userManagementModal');
  fetchAndSyncUsers();
  renderUserManagementList();
}

async function fetchAndSyncUsers() {
  let loaded = [];
  if (isCloudConnected && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('app_users')
        .select('id, username, username_lower, role, status, created_at, approved_at, approved_by')
        .order('created_at', { ascending: false });

      if (!error && Array.isArray(data)) {
        loaded = data;
        // Merge into local storage so offline cache stays fresh
        const local = getStoredLocalUsers();
        const merged = [...local];
        data.forEach(cloudUser => {
          const idx = merged.findIndex(u => u.username_lower === cloudUser.username_lower);
          if (idx >= 0) {
            merged[idx] = { ...merged[idx], ...cloudUser };
          } else {
            merged.push(cloudUser);
          }
        });
        saveLocalUsers(merged);
      }
    } catch (e) {
      console.warn('Error syncing users from Supabase:', e);
    }
  }

  if (loaded.length === 0) {
    loaded = getStoredLocalUsers();
  }

  cachedUsersList = loaded;
  refreshPendingUsersCount();
  if (document.getElementById('userManagementModal')?.classList.contains('active')) {
    renderUserManagementList();
  }
}

function refreshPendingUsersCount() {
  const users = cachedUsersList.length > 0 ? cachedUsersList : getStoredLocalUsers();
  const pendingCount = users.filter(u => u.status === 'pending').length;

  const navBadge = document.getElementById('pendingUsersCountBadge');
  if (navBadge) {
    navBadge.textContent = String(pendingCount);
    navBadge.style.display = pendingCount > 0 ? 'inline-flex' : 'none';
  }

  const tabBadge = document.getElementById('userFilterPendingBadge');
  if (tabBadge) {
    tabBadge.textContent = String(pendingCount);
    tabBadge.style.display = pendingCount > 0 ? 'inline-flex' : 'none';
  }
}

function filterUserList(filter) {
  activeUserFilter = filter || 'all';
  const buttons = document.querySelectorAll('.user-filter-btn');
  buttons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === activeUserFilter);
  });
  renderUserManagementList();
}

function renderUserManagementList() {
  const users = cachedUsersList.length > 0 ? cachedUsersList : getStoredLocalUsers();
  const search = (document.getElementById('userSearchInput')?.value || '').trim().toLowerCase();
  const tbody = document.getElementById('userManagementTableBody');
  if (!tbody) return;

  // Compute stat cards
  const total = users.length;
  const pendingCount = users.filter(u => u.status === 'pending').length;
  const approvedStaffCount = users.filter(u => u.status === 'approved' && (u.role || 'staff') === 'staff').length;
  const adminCount = users.filter(u => (u.role || 'staff') === 'admin').length;

  document.getElementById('userStatTotal').textContent = String(total);
  document.getElementById('userStatPending').textContent = String(pendingCount);
  document.getElementById('userStatStaff').textContent = String(approvedStaffCount);
  document.getElementById('userStatAdmin').textContent = String(adminCount);

  // Apply filter
  let filtered = users;
  if (activeUserFilter !== 'all') {
    filtered = filtered.filter(u => (u.status || 'approved') === activeUserFilter);
  }

  if (search) {
    filtered = filtered.filter(u =>
      (u.username || '').toLowerCase().includes(search) ||
      (u.role || '').toLowerCase().includes(search) ||
      (u.status || '').toLowerCase().includes(search)
    );
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding: 24px; text-align: center; color: #94a3b8;">No users found matching filter.</td></tr>`;
    return;
  }

  let html = '';
  filtered.forEach(u => {
    const role = (u.role || 'staff').toLowerCase();
    const status = (u.status || 'approved').toLowerCase();
    const isSelf = currentAuthUser && u.username_lower === currentAuthUser.username.toLowerCase();

    let statusPillHtml = '';
    if (status === 'approved') {
      statusPillHtml = '<span class="user-status-pill status-approved">🟢 Approved</span>';
    } else if (status === 'pending') {
      statusPillHtml = '<span class="user-status-pill status-pending">🟡 Pending Approval</span>';
    } else {
      statusPillHtml = '<span class="user-status-pill status-rejected">🔴 Rejected</span>';
    }

    const createdStr = u.created_at ? new Date(u.created_at).toLocaleDateString() : 'N/A';
    const approvedInfo = u.approved_by ? `<div style="font-size:10px; color:#64748b;">By: ${escapeHtml(u.approved_by)}</div>` : '';

    let actionsHtml = '';
    if (status === 'pending') {
      actionsHtml = `
        <div style="display: flex; gap: 6px; justify-content: flex-end;">
          <button class="btn-approve" onclick="approveUser('${escapeHtml(u.username)}', 'staff')" title="Approve as Staff Operator">
            ✅ Approve Staff
          </button>
          <button class="btn-approve" style="background:#eff6ff; border-color:#93c5fd; color:#1d4ed8;" onclick="approveUser('${escapeHtml(u.username)}', 'admin')" title="Approve as Administrator">
            👑 Approve Admin
          </button>
          <button class="btn-reject" onclick="rejectUser('${escapeHtml(u.username)}')" title="Reject Application">
            ✕ Reject
          </button>
        </div>
      `;
    } else if (status === 'approved') {
      actionsHtml = `
        <div style="display: flex; gap: 6px; justify-content: flex-end; align-items: center;">
          <select class="role-select-inline" onchange="changeUserRole('${escapeHtml(u.username)}', this.value)" title="Change Role">
            <option value="staff" ${role === 'staff' ? 'selected' : ''}>Staff</option>
            <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
          <button class="btn-action-sm" style="color:#b91c1c;" onclick="rejectUser('${escapeHtml(u.username)}')" title="Deactivate / Suspend User" ${isSelf ? 'disabled' : ''}>
            Suspend
          </button>
          <button class="btn-action-sm" onclick="deleteUserAccount('${escapeHtml(u.username)}')" title="Delete User" ${isSelf ? 'disabled' : ''}>
            🗑️
          </button>
        </div>
      `;
    } else {
      actionsHtml = `
        <div style="display: flex; gap: 6px; justify-content: flex-end; align-items: center;">
          <button class="btn-approve" onclick="approveUser('${escapeHtml(u.username)}', '${role}')" title="Re-activate User">
            ✅ Re-approve
          </button>
          <button class="btn-action-sm" onclick="deleteUserAccount('${escapeHtml(u.username)}')" title="Delete User">
            🗑️
          </button>
        </div>
      `;
    }

    html += `
      <tr style="border-bottom: 1px solid var(--border-color);">
        <td style="padding: 10px 14px; font-weight: 700; color: #0f172a;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span>${escapeHtml(u.username)}</span>
            ${isSelf ? '<span style="font-size:10px; font-weight:700; color:#4f46e5; background:#eef2ff; padding:1px 6px; border-radius:4px;">YOU</span>' : ''}
          </div>
        </td>
        <td style="padding: 10px 14px;">
          <span class="auth-role-tag ${role}">${role.toUpperCase()}</span>
        </td>
        <td style="padding: 10px 14px;">
          ${statusPillHtml}
        </td>
        <td style="padding: 10px 14px; font-size: 12px; color: #64748b;">
          <div>${createdStr}</div>
          ${approvedInfo}
        </td>
        <td style="padding: 10px 14px; text-align: right;">
          ${actionsHtml}
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

async function approveUser(username, role = 'staff') {
  if (!currentAuthUser || currentAuthUser.role !== 'admin') {
    showToast('Administrator privileges required.', 'error');
    return;
  }

  const usernameLower = username.toLowerCase();
  const updateData = {
    status: 'approved',
    role: role,
    approved_at: new Date().toISOString(),
    approved_by: currentAuthUser.username
  };

  try {
    if (isCloudConnected && supabaseClient) {
      const { error } = await supabaseClient
        .from('app_users')
        .update(updateData)
        .eq('username_lower', usernameLower);
      if (error && !isMissingTableError(error)) throw error;
    }

    // Update local storage
    const local = getStoredLocalUsers();
    const idx = local.findIndex(u => u.username_lower === usernameLower);
    if (idx >= 0) {
      local[idx] = { ...local[idx], ...updateData };
      saveLocalUsers(local);
    }

    // Update memory cache
    const cIdx = cachedUsersList.findIndex(u => u.username_lower === usernameLower);
    if (cIdx >= 0) {
      cachedUsersList[cIdx] = { ...cachedUsersList[cIdx], ...updateData };
    }

    playBeep('success');
    showToast(`✅ Approved user "${username}" as ${role.toUpperCase()}!`);
    refreshPendingUsersCount();
    renderUserManagementList();
  } catch (err) {
    console.error('Approval failed:', err);
    showToast('Failed to approve user: ' + err.message, 'error');
  }
}

async function rejectUser(username) {
  if (!currentAuthUser || currentAuthUser.role !== 'admin') {
    showToast('Administrator privileges required.', 'error');
    return;
  }

  const usernameLower = username.toLowerCase();
  if (currentAuthUser && usernameLower === currentAuthUser.username.toLowerCase()) {
    showToast('You cannot reject or suspend your own account.', 'error');
    return;
  }

  const confirmed = confirm(`Reject / suspend account for "${username}"? They will not be able to sign in.`);
  if (!confirmed) return;

  const updateData = {
    status: 'rejected'
  };

  try {
    if (isCloudConnected && supabaseClient) {
      const { error } = await supabaseClient
        .from('app_users')
        .update(updateData)
        .eq('username_lower', usernameLower);
      if (error && !isMissingTableError(error)) throw error;
    }

    const local = getStoredLocalUsers();
    const idx = local.findIndex(u => u.username_lower === usernameLower);
    if (idx >= 0) {
      local[idx] = { ...local[idx], ...updateData };
      saveLocalUsers(local);
    }

    const cIdx = cachedUsersList.findIndex(u => u.username_lower === usernameLower);
    if (cIdx >= 0) {
      cachedUsersList[cIdx] = { ...cachedUsersList[cIdx], ...updateData };
    }

    showToast(`User "${username}" rejected/suspended.`);
    refreshPendingUsersCount();
    renderUserManagementList();
  } catch (err) {
    console.error('Reject failed:', err);
    showToast('Failed to reject user: ' + err.message, 'error');
  }
}

async function changeUserRole(username, newRole) {
  if (!currentAuthUser || currentAuthUser.role !== 'admin') {
    showToast('Administrator privileges required.', 'error');
    return;
  }

  const usernameLower = username.toLowerCase();
  const isSelf = currentAuthUser && usernameLower === currentAuthUser.username.toLowerCase();

  if (isSelf && newRole !== 'admin') {
    const confirmed = confirm('Demoting yourself from Administrator will remove your access to User Management. Are you sure?');
    if (!confirmed) {
      renderUserManagementList();
      return;
    }
  }

  const updateData = { role: newRole };

  try {
    if (isCloudConnected && supabaseClient) {
      const { error } = await supabaseClient
        .from('app_users')
        .update(updateData)
        .eq('username_lower', usernameLower);
      if (error && !isMissingTableError(error)) throw error;
    }

    const local = getStoredLocalUsers();
    const idx = local.findIndex(u => u.username_lower === usernameLower);
    if (idx >= 0) {
      local[idx] = { ...local[idx], ...updateData };
      saveLocalUsers(local);
    }

    const cIdx = cachedUsersList.findIndex(u => u.username_lower === usernameLower);
    if (cIdx >= 0) {
      cachedUsersList[cIdx] = { ...cachedUsersList[cIdx], ...updateData };
    }

    if (isSelf) {
      currentAuthUser.role = newRole;
      applySignedInUser(currentAuthUser);
    }

    showToast(`Role for "${username}" updated to ${newRole.toUpperCase()}.`);
    refreshPendingUsersCount();
    renderUserManagementList();
  } catch (err) {
    console.error('Role change failed:', err);
    showToast('Failed to update role: ' + err.message, 'error');
  }
}

async function deleteUserAccount(username) {
  if (!currentAuthUser || currentAuthUser.role !== 'admin') {
    showToast('Administrator privileges required.', 'error');
    return;
  }

  const usernameLower = username.toLowerCase();
  if (currentAuthUser && usernameLower === currentAuthUser.username.toLowerCase()) {
    showToast('You cannot delete your own account.', 'error');
    return;
  }

  const confirmed = confirm(`Are you sure you want to permanently delete user "${username}"?`);
  if (!confirmed) return;

  try {
    if (isCloudConnected && supabaseClient) {
      const { error } = await supabaseClient
        .from('app_users')
        .delete()
        .eq('username_lower', usernameLower);
      if (error && !isMissingTableError(error)) throw error;
    }

    let local = getStoredLocalUsers();
    local = local.filter(u => u.username_lower !== usernameLower);
    saveLocalUsers(local);

    cachedUsersList = cachedUsersList.filter(u => u.username_lower !== usernameLower);

    showToast(`Deleted user "${username}".`);
    refreshPendingUsersCount();
    renderUserManagementList();
  } catch (err) {
    console.error('Delete failed:', err);
    showToast('Failed to delete user: ' + err.message, 'error');
  }
}
