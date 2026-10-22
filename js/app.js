// Storage keys
const STORAGE_KEY_REGISTRY = 'not_found_reboxes';
const STORAGE_KEY_COUNTER = 'not_found_rb_counter';
const STORAGE_KEY_ACTIVE = 'not_found_active_session';
const STORAGE_KEY_CLOUD_CFG = 'not_found_cloud_config';
const STORAGE_KEY_OPERATOR = 'not_found_operator_name';

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

// Load state on startup
window.addEventListener('DOMContentLoaded', () => {
  loadSavedActiveSession();

  // Restore Operator name
  const opInput = document.getElementById('operatorNameInput');
  if (opInput) opInput.value = currentOperatorName;

  // Ensure counter is clean if local registry is empty
  const reg = getStoredRegistry();
  if (reg.length === 0) {
    localStorage.setItem(STORAGE_KEY_COUNTER, '0');
  }

  updateUiState();
  updateReboxCountStat();
  initCloudSync();
  document.getElementById('barcodeScannerInput').focus();
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

function getStoredRegistry() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_REGISTRY);
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
      localStorage.setItem(STORAGE_KEY_REGISTRY, JSON.stringify(list));
    }
    return list;
  } catch {
    return [];
  }
}

function saveRegistry(list) {
  if (Array.isArray(list)) {
    list.forEach(r => {
      if (r.rebox_number) {
        r.rebox_number = normalizeBoxNumber(r.rebox_number);
      }
    });
  }
  localStorage.setItem(STORAGE_KEY_REGISTRY, JSON.stringify(list));
  updateReboxCountStat();
}

function getNextIncrementalRbNumber() {
  const registry = getStoredRegistry();
  let maxNum = 0;
  registry.forEach(r => {
    const match = (r.rebox_number || '').match(/\d+/);
    if (match) {
      const num = parseInt(match[0], 10);
      if (num > maxNum) maxNum = num;
    }
  });
  const nextNum = maxNum + 1;
  localStorage.setItem(STORAGE_KEY_COUNTER, String(nextNum));
  return `BOX-${String(nextNum).padStart(4, '0')}`;
}

function peekNextRbNumber() {
  const registry = getStoredRegistry();
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

function saveActiveSession() {
  const session = {
    books: currentScannedBooks,
    assignedRebox: currentAssignedRebox ? normalizeBoxNumber(currentAssignedRebox) : null,
  };
  localStorage.setItem(STORAGE_KEY_ACTIVE, JSON.stringify(session));
}

function loadSavedActiveSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ACTIVE);
    if (!raw) return;
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

  // Check duplicate ISBN scans within current package (only if it's a barcode)
  if (parsed.is_isbn) {
    const cleanIsbnDigits = parsed.isbn.replace(/[^0-9X]/gi, '');
    const exists = currentScannedBooks.some(b => 
      b.is_isbn !== false && b.isbn && b.isbn !== 'NO-ISBN' && b.isbn.replace(/[^0-9X]/gi, '') === cleanIsbnDigits
    );
    if (exists) {
      playBeep('error');
      showToast(`ISBN ${parsed.isbn} is ALREADY scanned in this current package!`, 'error');
      return;
    }
  }

  // Create new book entry
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
    showToast(`Scanned ISBN: ${parsed.isbn}`);
  } else {
    showToast(`Recorded Title: "${parsed.title}"`);
  }

  saveActiveSession();
  updateUiState();
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
-- 1. Create table for closed Boxes (if not exists)
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

-- Disable Row Level Security so all warehouse stations can sync and read boxes
alter table not_found_reboxes disable row level security;

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
end $$;

-- 3. Reset table identity and clear test rows for fresh start at 1
truncate table not_found_reboxes restart identity;

-- 4. Atomic Stored Procedure: Claim Single Box strictly sequentially (BOX-0001, BOX-0002, ...)
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
    max(nullif(regexp_replace(rebox_number, '\D', '', 'g'), '')::integer),
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
$$;`;

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
    setCloudStatus(true, config);

    // Fetch initial registry & attach realtime subscription
    await fetchAndSyncSupabaseRegistry();
    attachSupabaseRealtime();
    console.log('Multi-user Supabase cloud sync connected successfully!');
  } catch (err) {
    console.error('Failed to connect to Supabase:', err);
    setCloudStatus(false);
    showToast('Supabase connection error: ' + err.message, 'error');
  }
}

async function fetchAndSyncSupabaseRegistry() {
  if (!isCloudConnected || !supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('not_found_reboxes')
      .select('*')
      .order('id', { ascending: false });

    if (!error && Array.isArray(data)) {
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

      localStorage.setItem(STORAGE_KEY_REGISTRY, JSON.stringify(data));
      localStorage.setItem(STORAGE_KEY_COUNTER, String(maxCloudNum));
      updateReboxCountStat();
      updateUiState();
      if (document.getElementById('registryModal')?.classList.contains('active')) {
        renderMasterRegistry();
      }

      // Lazily fix any legacy RB- rows in Supabase table
      if (hasRbRows.length > 0) {
        hasRbRows.forEach(async item => {
          if (item.id && item.newNum) {
            await supabaseClient.from('not_found_reboxes').update({ rebox_number: item.newNum }).eq('id', item.id);
          }
        });
      }
    }
  } catch (err) {
    console.warn('Error fetching Supabase registry:', err);
  }
}

function attachSupabaseRealtime() {
  if (!isCloudConnected || !supabaseClient) return;

  if (supabaseRealtimeChannel) {
    supabaseClient.removeChannel(supabaseRealtimeChannel);
  }

  supabaseRealtimeChannel = supabaseClient
    .channel('not_found_reboxes_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'not_found_reboxes' },
      (payload) => {
        console.log('Supabase realtime payload:', payload);
        fetchAndSyncSupabaseRegistry();
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('Connected to Supabase Realtime.');
      }
    });
}

function setCloudStatus(connected, config = null) {
  isCloudConnected = connected;
  const dot = document.getElementById('cloudStatusDot');
  const text = document.getElementById('cloudStatusText');
  const banner = document.getElementById('cloudStatusBanner');
  const bannerIcon = document.getElementById('cloudBannerIcon');
  const bannerText = document.getElementById('cloudBannerText');

  if (connected) {
    dot.style.background = '#10b981';
    text.textContent = 'Cloud: Live (Supabase)';
    if (banner) {
      banner.style.background = '#ecfdf5';
      banner.style.borderColor = '#a7f3d0';
      banner.style.color = '#065f46';
      bannerIcon.textContent = '🟢';
      bannerText.textContent = 'Supabase Cloud Connected! Atomic box assignment active across all 10 operators.';
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
    const opInput = document.getElementById('operatorNameInput');
    if (opInput) opInput.value = station;
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

  const btnAssign = document.getElementById('btnAssignBox');
  const originalText = btnAssign.innerHTML;
  btnAssign.disabled = true;
  btnAssign.textContent = '⏳ Claiming Box #...';

  let nextRb = null;

  try {
    const operator = currentOperatorName || 'Operator';
    const now = new Date();
    let newReboxRecord = null;

    if (isCloudConnected && supabaseClient) {
      // ATOMIC TRANSACTION: PostgreSQL sequence nextval('rebox_counter_seq')
      // Server serializes concurrent requests across all 10 users with zero collisions!
      const { data: rpcResult, error: rpcError } = await supabaseClient.rpc('claim_next_rebox', {
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
            await supabaseClient.from('not_found_reboxes').update({ rebox_number: cleanRb }).eq('id', rpcResult.id);
          }
          newReboxRecord.rebox_number = cleanRb;
          nextRb = cleanRb;
        }
      } else {
        console.warn('claim_next_rebox RPC unavailable or errored; falling back to direct table query/insert:', rpcError);
        const { data: existingRows } = await supabaseClient
          .from('not_found_reboxes')
          .select('rebox_number')
          .order('id', { ascending: false })
          .limit(100);

        let maxNum = 0;
        (existingRows || []).forEach(r => {
          const m = (r.rebox_number || '').match(/\d+/);
          if (m) maxNum = Math.max(maxNum, parseInt(m[0], 10));
        });
        const nextNum = maxNum + 1;
        nextRb = `BOX-${String(nextNum).padStart(4, '0')}`;
        localStorage.setItem(STORAGE_KEY_COUNTER, String(nextNum));

        newReboxRecord = {
          rebox_number: nextRb,
          sealed_by: operator,
          assigned_at: now.toISOString(),
          assigned_at_formatted: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
          book_count: currentScannedBooks.length,
          status: 'Closed',
          books: [...currentScannedBooks]
        };

        const { data: insData, error: insErr } = await supabaseClient
          .from('not_found_reboxes')
          .insert([newReboxRecord])
          .select()
          .single();

        if (insErr) {
          throw new Error('Supabase insert error: ' + insErr.message);
        }
        if (insData) newReboxRecord = insData;
      }
    } else {
      // Local fallback
      nextRb = getNextIncrementalRbNumber();
      newReboxRecord = {
        rebox_number: nextRb,
        sealed_by: operator,
        assigned_at: now.toISOString(),
        assigned_at_formatted: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        book_count: currentScannedBooks.length,
        status: 'Closed',
        books: [...currentScannedBooks]
      };
    }

    currentAssignedRebox = nextRb;

    // Save into historical Rebox Registry cache
    const registry = getStoredRegistry();
    if (!registry.some(r => r.rebox_number === nextRb)) {
      registry.unshift(newReboxRecord);
      saveRegistry(registry);
    }

    // Play success chime
    playBeep('box_closed');

    // Update UI
    updateUiState();
    saveActiveSession();

    showToast(`🎉 Box assigned: ${nextRb} (${newReboxRecord.book_count} books by ${operator}). Package is CLOSED.`);

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
      boxStatus.innerHTML = `<span class="status-dot" style="background:#6366f1;"></span> Pending Assignment`;
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
          ${!currentAssignedRebox ? `
            <button class="btn-delete-book" title="Remove Entry" onclick="removeBookByIndex(${actualIndex})">
              🗑️
            </button>
          ` : ''}
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

function removeBookByIndex(idx) {
  if (currentAssignedRebox) {
    showToast('Cannot delete from an already closed box.', 'error');
    return;
  }
  if (currentScannedBooks[idx]) {
    const removed = currentScannedBooks.splice(idx, 1)[0];
    saveActiveSession();
    updateUiState();
    showToast(`Removed "${removed.title || removed.isbn}"`);
  }
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

function openInspectModalForBox(boxRecord) {
  document.getElementById('inspectModalTitle').textContent = `Box ${boxRecord.rebox_number} Manifest`;
  document.getElementById('inspectBoxNumber').textContent = boxRecord.rebox_number;
  document.getElementById('inspectBookCount').textContent = boxRecord.book_count || (boxRecord.books || []).length;
  document.getElementById('inspectOperator').textContent = boxRecord.sealed_by || 'Operator';
  document.getElementById('inspectAssignedAt').textContent = `Closed on ${boxRecord.assigned_at_formatted || new Date(boxRecord.assigned_at).toLocaleString()}`;

  // Set print details
  document.getElementById('printRbNumber').textContent = boxRecord.rebox_number;
  document.getElementById('printDetails').innerHTML = `
    TOTAL BOOKS: ${boxRecord.book_count || (boxRecord.books || []).length}<br>
    SEALED BY: ${(boxRecord.sealed_by || 'OPERATOR').toUpperCase()}<br>
    DATE: ${new Date(boxRecord.assigned_at).toLocaleDateString()}<br>
    STATUS: SEALED & AUDITED
  `;

  // Render books
  const listEl = document.getElementById('inspectBooksList');
  let html = '';
  (boxRecord.books || []).forEach((b, idx) => {
    const isBarcode = b.is_isbn !== false && b.isbn && b.isbn !== 'NO-ISBN';
    html += `
      <div class="book-item" style="padding: 8px 12px;">
        <div class="book-left">
          <span class="book-index" style="width:22px; height:22px; font-size:10px;">#${idx + 1}</span>
          <div class="book-details">
            ${isBarcode ? `
              <span class="book-isbn" style="font-size:13px;">${b.isbn}</span>
              <span class="book-title" style="font-size:11px;">${b.title}</span>
            ` : `
              <span class="book-title" style="font-size:13px; font-weight:700; color:var(--text-main);">${b.title}</span>
              <span style="font-size:10px; font-weight:600; color:#d97706;">📖 Manual Title (No ISBN)</span>
            `}
          </div>
        </div>
        <div class="book-right">
          ${b.flag && b.flag !== 'normal' ? `<span style="font-size:10px; font-weight:700; color:#d97706; background:#fef3c7; padding:2px 6px; border-radius:4px;">${b.flag.toUpperCase()}</span>` : ''}
          <span class="book-time">${b.scanned_at || ''}</span>
        </div>
      </div>
    `;
  });
  listEl.innerHTML = html;

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
  a.download = `${box.rebox_number}-manifest.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${box.rebox_number} CSV.`);
}

function printBoxLabel() {
  window.print();
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
    <div style="font-size: 12px; font-weight: 700; color: #4338ca; background: #eef2ff; border: 1px solid #c7d2fe; padding: 8px 12px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center;">
      <span>⚡ Found in <strong>${matches.length}</strong> Different Box${matches.length === 1 ? '' : 'es'}</span>
      <span style="font-size: 11px; color: #6366f1;">Total copies recorded: ${totalCopies}</span>
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
        ? `<strong style="font-family:var(--font-mono); color:#4338ca;">${escapeHtml(bk.isbn)}</strong> — ${escapeHtml(bk.title || 'Physical Book')}`
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
      <div style="background: #f8fafc; border: 1.5px solid #c7d2fe; border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 10px; font-weight: 800; color: #4338ca; text-transform: uppercase; letter-spacing: 0.5px;">BOX ASSIGNED</span>
            <span style="font-size: 16px; font-weight: 800; font-family: var(--font-mono); color: #4f46e5; background: #ffffff; padding: 3px 10px; border-radius: 6px; border: 1px solid #c7d2fe;">
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
function openMasterRegistryModal() {
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
        <td style="padding: 10px 14px; font-weight:700; font-family:var(--font-mono); color:#4f46e5;">${escapeHtml(r.rebox_number)}</td>
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
  a.download = `NotFound-All-Boxes-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported Master Box Registry.');
}

async function confirmResetAllData() {
  const confirmed = confirm(
    '⚠️ RESET ALL BOX DATA?\n\n' +
    'This will permanently delete all recorded boxes from Supabase and local storage, restarting the counter at BOX-0001.\n\n' +
    'Are you sure you want a fresh start?'
  );

  if (!confirmed) return;

  try {
    if (isCloudConnected && supabaseClient) {
      const { error } = await supabaseClient
        .from('not_found_reboxes')
        .delete()
        .gt('id', 0);

      if (error) {
        console.warn('Supabase delete error:', error);
      }
    }

    localStorage.setItem(STORAGE_KEY_REGISTRY, '[]');
    localStorage.setItem(STORAGE_KEY_COUNTER, '0');
    currentScannedBooks = [];
    currentAssignedRebox = null;
    saveActiveSession();

    updateUiState();
    updateReboxCountStat();
    renderFeed();
    populateBoxDropdown();

    if (document.getElementById('registryModal')?.classList.contains('active')) {
      renderMasterRegistry();
    }

    playBeep('success');
    showToast('✨ All box records wiped! Starting fresh at BOX-0001.');
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
  let colIsbn = -1;
  let colTitle = -1;
  let colBox = -1;

  const header = rawRows[0].map(h => (h || '').toLowerCase().trim());
  const isHeader = header.some(h => 
    h.includes('isbn') || h.includes('barcode') || h.includes('title') || 
    h.includes('book') || h.includes('box') || h.includes('count') || h === '#'
  );

  if (isHeader) {
    startIndex = 1;
    colIsbn = header.findIndex(h => h.includes('isbn') || h.includes('barcode') || h.includes('ean'));
    colTitle = header.findIndex(h => h.includes('title') || h.includes('book') || h.includes('item') || h.includes('name'));
    colBox = header.findIndex(h => h.includes('box') || h.includes('package') || h.includes('bin') || h.includes('rebox'));
  }

  // Smart column mapping if no explicit headers found
  if (colBox === -1 && colIsbn === -1 && colTitle === -1) {
    const sample = rawRows[startIndex] || [];
    if (sample.length === 1) {
      colIsbn = 0;
      colBox = -1;
    } else if (sample.length === 2) {
      const c0 = (sample[0] || '').trim();
      const c1 = (sample[1] || '').trim();
      const c0IsBox = /^(box[-\s]?)?\d{1,4}$/i.test(c0) || /^RB[-\s]?\d{1,4}$/i.test(c0);
      const c1IsBox = /^(box[-\s]?)?\d{1,4}$/i.test(c1) || /^RB[-\s]?\d{1,4}$/i.test(c1);

      if (c0IsBox && !c1IsBox) {
        colBox = 0;
        colIsbn = 1;
      } else if (c1IsBox && !c0IsBox) {
        colBox = 1;
        colIsbn = 0;
      } else if (/^\d{8,14}$/.test(c0.replace(/[^0-9X]/gi, ''))) {
        colIsbn = 0;
        colBox = 1;
      } else if (/^\d{8,14}$/.test(c1.replace(/[^0-9X]/gi, ''))) {
        colIsbn = 1;
        colBox = 0;
      } else {
        colIsbn = 0;
        colBox = 1;
      }
    } else if (sample.length >= 3) {
      sample.forEach((cell, idx) => {
        const val = cell.trim();
        if (colBox === -1 && (/^(box[-\s]?)?\d{1,4}$/i.test(val) || /^RB[-\s]?\d{1,4}$/i.test(val))) {
          colBox = idx;
        } else if (colIsbn === -1 && /^\d{8,14}$/.test(val.replace(/[^0-9X]/gi, ''))) {
          colIsbn = idx;
        }
      });
      if (colBox === -1) colBox = sample.length - 1;
      if (colIsbn === -1) colIsbn = (colBox === 0 ? 1 : 0);
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
    <span style="font-size:11px; font-weight:700; color:#4338ca; background:#eef2ff; padding:3px 8px; border-radius:4px; border:1px solid #c7d2fe;">
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
            ? '<span style="color:#4f46e5; font-weight:700;">Barcode/ISBN</span>' 
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
      const registry = getStoredRegistry();
      const now = new Date();
      const operator = currentOperatorName || 'Import';

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

        if (isCloudConnected && supabaseClient) {
          // Check if box already exists in Supabase
          const { data: existingBox, error: fetchErr } = await supabaseClient
            .from('not_found_reboxes')
            .select('*')
            .eq('rebox_number', boxName)
            .maybeSingle();

          if (!fetchErr && existingBox) {
            // Merge books into existing box
            const existingBooks = Array.isArray(existingBox.books) ? existingBox.books : [];
            const mergedBooks = [...existingBooks, ...books];
            const { data: updatedBox, error: upErr } = await supabaseClient
              .from('not_found_reboxes')
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
              .from('not_found_reboxes')
              .insert([newBoxRecord])
              .select()
              .single();

            if (insErr) throw new Error(`Failed to insert ${boxName}: ${insErr.message}`);
            newRecords.push(insertedBox || newBoxRecord);
          }
        } else {
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

      if (isCloudConnected && supabaseClient) {
        await fetchAndSyncSupabaseRegistry();
      } else {
        saveRegistry(registry);
      }

      // Update counter based on highest imported box number
      let maxNum = 0;
      assignedBoxNames.forEach(name => {
        const m = name.match(/\d+/);
        if (m) maxNum = Math.max(maxNum, parseInt(m[0], 10));
      });
      const curStored = parseInt(localStorage.getItem(STORAGE_KEY_COUNTER) || '0', 10);
      localStorage.setItem(STORAGE_KEY_COUNTER, String(Math.max(curStored, maxNum)));

      updateUiState();
      closeModal('importModal');
      playBeep('box_closed');

      showToast(`📥 Successfully imported ${currentParsedImportItems.length} books into ${importedBoxesCount} Box${importedBoxesCount === 1 ? '' : 'es'} (${assignedBoxNames.join(', ')})!`);
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
