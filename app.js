(() => {
  'use strict';

  const BIBLE = window.BIBLE_CONTENT;
  const PLAN = window.STUDY_PLAN;
  const BOOKS = BIBLE.books;
  const BOOK_BY_ID = Object.fromEntries(BOOKS.map(book => [book.id, book]));
  const LOCAL_KEY = 'caminoPalabraBibleStateV2';
  const LEGACY_LOCAL_KEY = 'caminoPalabraGenesisStateV1';
  const AUTH_KEY = 'caminoPalabraAuthV1';
  const CLIENT_KEY = 'caminoPalabraClientIdV1';
  let authSession = null;
  let pendingLegacyState = null;
  function getLegacyClientId() { let id=localStorage.getItem(CLIENT_KEY); if(!id){ id=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():'cp-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2); localStorage.setItem(CLIENT_KEY,id); } return id; }
  const REVIEW_INTERVALS = [1, 3, 7, 14, 30];
  const DEFAULT_SETTINGS = {
    studyMode: 'full',
    fontScale: '1',
    audioProvider: '',
    audioVoice: 'female',
    speechRate: '1',
    rosaryIntention: '',
    rosaryMysteryType: '',
    theme: 'light',
    lastLessonId: 'day-001',
    selectedBookId: 'genesis'
  };
  const SPIRITUAL_AUDIO_INTRO = 'Antes de comenzar, haz una pausa. Respira con calma y abre tu corazón. Hoy Dios quiere encontrarse contigo en su Palabra. Escucha con atención y permite que su voz ilumine tu vida.';
  const DEFAULT_AUDIO_CONFIG = Object.freeze({
    mode: 'device',
    configured: false,
    voice: 'device',
    model: '',
    aiGenerated: false
  });
  const NEURAL_AUDIO_CHUNK_LIMIT = 700;
  const DEVICE_AUDIO_CHUNK_LIMIT = 230;

  let appState = {progress: {}, journal: {}, reviews: [], settings: {...DEFAULT_SETTINGS}};
  let currentView = 'dashboard';
  let previousView = 'dashboard';
  let currentLesson = PLAN.lessons[0];
  let currentMode = 'full';
  let directReading = null;
  let lessonStartedAt = Date.now();
  let visitedTabs = new Set(['reading']);
  let notesExpanded = false;
  let journalTimer = null;
  let toastTimer = null;
  let searchTimer = null;
  let speechQueue = [];
  let speechIndex = 0;
  let speechPlaying = false;
  let speechPaused = false;
  let speechLoading = false;
  let audioConfig = {...DEFAULT_AUDIO_CONFIG};
  let audioMode = 'device';
  let audioContext = null;
  let audioSource = null;
  let audioSessionId = 0;
  let rosaryMysteryIndex = 0;
  let rosaryBeadProgress = new Set();
  let rosaryAudio = null;
  let rosaryAudioUrl = null;

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
  const hasAppsScript = () => Boolean(window.CAMINO_CONFIG && window.CAMINO_CONFIG.SCRIPT_URL && !window.CAMINO_CONFIG.SCRIPT_URL.includes('REEMPLAZA_CON_'));
  let backendReady = false;
  function localStateKey() { return LOCAL_KEY + ':' + (authSession && authSession.user && authSession.user.userId || 'guest'); }
  function legacyLocalStateKey() { return LEGACY_LOCAL_KEY + ':' + (authSession && authSession.user && authSession.user.userId || 'guest'); }
  function readAuth() { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (_) { return null; } }
  function saveAuth(value) { authSession = value; if (value) localStorage.setItem(AUTH_KEY, JSON.stringify(value)); else localStorage.removeItem(AUTH_KEY); }

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindEvents();
    bindAuthEvents();
    renderOrientation();
    authSession = readAuth();
    if (authSession && authSession.token) {
      try {
        const checked = await authCall('authValidate', {});
        authSession.user = checked.user;
        await enterAuthenticatedApp();
      } catch (error) {
        saveAuth(null);
        showAuthScreen('Tu sesión terminó. Inicia sesión nuevamente.');
      }
    } else {
      showAuthScreen('Inicia sesión o crea una cuenta para comenzar.');
    }
    window.setTimeout(() => $('#appLoader').classList.add('done'), 260);
  }

  function bindAuthEvents() {
    $('#loginForm').addEventListener('submit', async event => {
      event.preventDefault();
      await submitAuth('authLogin');
    });
    $('#registerForm').addEventListener('submit', async event => {
      event.preventDefault();
      await submitAuth('authRegister');
    });
    $('#showRegister').addEventListener('click', () => toggleAuthForms(true));
    $('#showLogin').addEventListener('click', () => toggleAuthForms(false));
    $('#logoutButton').addEventListener('click', logout);
  }

  function showAuthScreen(message) {
    $('#authScreen').classList.remove('hidden');
    $('.app-shell').classList.add('hidden');
    $('#authMessage').textContent = message || '';
  }
  function toggleAuthForms(register) {
    $('#loginPanel').classList.toggle('hidden', register);
    $('#registerPanel').classList.toggle('hidden', !register);
    $('#authMessage').textContent = '';
  }
  async function authCall(action, payload) {
    if (!hasAppsScript()) throw new Error('Primero configura la URL /exec en config.js.');
    const response = await fetch(window.CAMINO_CONFIG.SCRIPT_URL, {
      method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
      body:JSON.stringify({action, payload:Object.assign({}, payload || {}, {authToken: authSession && authSession.token || ''})}), cache:'no-store'
    });
    if (!response.ok) throw new Error('No se pudo conectar con Apps Script (HTTP '+response.status+').');
    const result = await response.json();
    if (result && result.success === false) throw new Error(result.error || 'Error del servidor.');
    if (result && result.ok === false) throw new Error(result.error || 'Error del servidor.');
    return result;
  }
  async function submitAuth(action) {
    const isRegister = action === 'authRegister';
    const form = isRegister ? $('#registerForm') : $('#loginForm');
    const button = form.querySelector('button[type="submit"]');
    const original = button.textContent;
    button.disabled = true; button.textContent = 'Conectando…';
    $('#authMessage').textContent = '';
    try {
      const payload = isRegister
        ? {name:$('#registerName').value.trim(), email:$('#registerEmail').value.trim(), password:$('#registerPassword').value, legacyClientId:getLegacyClientId()}
        : {email:$('#loginEmail').value.trim(), password:$('#loginPassword').value};
      const legacySnapshot = isRegister && !localStorage.getItem('caminoPalabraLegacyClaimedV1')
        ? (localStorage.getItem(LOCAL_KEY) || localStorage.getItem(LEGACY_LOCAL_KEY)) : null;
      const result = await authCall(action, payload);
      saveAuth({token:result.token, user:result.user, expires:result.expires});
      if (legacySnapshot) {
        try { pendingLegacyState = JSON.parse(legacySnapshot); localStorage.setItem('caminoPalabraLegacyClaimedV1','1'); } catch (_) { pendingLegacyState = null; }
      }
      await enterAuthenticatedApp();
    } catch (error) { $('#authMessage').textContent = error.message; }
    finally { button.disabled = false; button.textContent = original; }
  }
  async function enterAuthenticatedApp() {
    $('#authScreen').classList.add('hidden');
    $('.app-shell').classList.remove('hidden');
    $('#currentUserName').textContent = authSession.user.name || authSession.user.email;
    await loadState();
    if (pendingLegacyState) {
      const legacy = normalizeState(pendingLegacyState);
      appState = mergeStates_(appState, legacy);
      persistLocal();
      if (backendReady) {
        try { await syncWholeState_(); setSyncStatus('synced','Sincronizado'); }
        catch (error) { setSyncStatus('error','Pendiente'); console.warn('Migración local pendiente', error); }
      }
      pendingLegacyState = null;
    }
    applySettings();
    initializeLibrarySelectors();
    renderAll();
  }
  async function logout() {
    try { await authCall('authLogout', {}); } catch (_) {}
    stopAudio(); saveAuth(null); appState = {progress:{},journal:{},reviews:[],settings:{...DEFAULT_SETTINGS}};
    showAuthScreen('Has cerrado sesión. Puedes ingresar con otra cuenta.');
    toggleAuthForms(false);
  }

  function bindEvents() {
    $$('[data-nav]').forEach(button => button.addEventListener('click', () => showView(button.dataset.nav)));
    $('#continueButton').addEventListener('click', () => openLesson(getNextLesson().id, appState.settings.studyMode || 'full'));
    $('#quickButton').addEventListener('click', () => openLesson(getNextLesson().id, 'quick'));
    $('#backFromStudy').addEventListener('click', () => showView(previousView === 'study' ? 'dashboard' : previousView));
    $('#openSettings').addEventListener('click', openSettings);
    $('#saveSettingsButton').addEventListener('click', saveSettingsFromDialog);
    $('#openOrientation').addEventListener('click', () => $('#orientationDialog').showModal());
    $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $('#' + button.dataset.closeDialog).close()));
    $$('.study-tab').forEach(button => button.addEventListener('click', () => switchStudyTab(button.dataset.tab)));
    $('#modeFull').addEventListener('click', () => changeMode('full'));
    $('#modeQuick').addEventListener('click', () => changeMode('quick'));
    $('#audioToggle').addEventListener('click', toggleAudio);
    $('#audioStop').addEventListener('click', stopAudio);
    $('#speechRate').addEventListener('change', onSpeechRateChange);
    $('#audioProvider').addEventListener('change', onAudioProviderChange);
    $('#audioVoice').addEventListener('change', onAudioVoiceChange);
    $('#testGeminiVoicesButton').addEventListener('click', testGeminiVoicesFromUi);
    $('#rosaryMysterySelect').addEventListener('change', onRosaryMysteryChange);
    setupGuidedRosary();
    $('#rosaryPrevMystery').addEventListener('click', () => moveRosaryMystery(-1));
    $('#rosaryCompleteDecade').addEventListener('click', completeRosaryDecade);
    $('#rosarySpeakButton').addEventListener('click', speakRosaryMeditation);
    $('#rosaryBeads').addEventListener('click', onRosaryBeadClick);
    $('#rosaryIntention').addEventListener('input', () => { appState.settings.rosaryIntention = $('#rosaryIntention').value; persistLocal(); $('#rosaryIntentionStatus').textContent = 'Cambios pendientes de guardar.'; });
    $('#saveRosaryIntention').addEventListener('click', () => persistRosaryIntention());
    $$('[data-rosary-prayer]').forEach(button => button.addEventListener('click', () => showRosaryPrayer(button.dataset.rosaryPrayer))); 
    $('#readerModeButton').addEventListener('click', enterReadingMode);
    $('#exitReaderMode').addEventListener('click', exitReadingMode);
    $('#fontDecrease').addEventListener('click', () => adjustReaderFont(-0.05));
    $('#fontIncrease').addEventListener('click', () => adjustReaderFont(0.05));
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('reading-mode')) exitReadingMode(false); });
    $('#toggleAllNotes').addEventListener('click', toggleNotes);
    $('#saveJournalButton').addEventListener('click', () => saveCurrentJournal(true));
    $('#journalInput').addEventListener('input', scheduleJournalSave);
    $('#quizForm').addEventListener('submit', submitQuiz);
    $('#completeLesson').addEventListener('click', completeCurrentLesson);
    $('#testamentSelect').addEventListener('change', onTestamentChange);
    $('#bookSelect').addEventListener('change', onBookChange);
    $('#librarySearch').addEventListener('input', event => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => renderSearch(event.target.value.trim()), 180);
    });
    $('#askChatGpt').addEventListener('click', openAiDialog);
    $('#launchChatGpt').addEventListener('click', launchChatGpt);
    window.addEventListener('beforeunload', () => {
      stopAudio();
      saveCurrentJournal(false);
    });
  }

  async function loadState() {
    backendReady = false;
    setSyncStatus('loading', 'Sincronizando');
    if (hasAppsScript()) {
      try {
        const result = await gasCall('getBootstrapData');
        appState = normalizeState(result && result.state ? result.state : {});
        audioConfig = {...DEFAULT_AUDIO_CONFIG, ...((result && result.audio) || {})};
        setSyncStatus('synced', 'Sincronizado');
        return;
      } catch (error) {
        console.error(error);
        showToast('No se pudo conectar. Se usará el guardado de este dispositivo.');
      }
    }
    appState = normalizeState(readLocalState());
    audioConfig = {...DEFAULT_AUDIO_CONFIG};
    setSyncStatus('local', 'En este dispositivo');
  }

  function mergeStates_(serverState, localState) {
    const merged = normalizeState(serverState || {});
    const local = normalizeState(localState || {});
    Object.keys(local.progress).forEach(key => { if (!merged.progress[key]) merged.progress[key] = local.progress[key]; });
    Object.keys(local.journal).forEach(key => { if (!merged.journal[key]) merged.journal[key] = local.journal[key]; });
    local.reviews.forEach(item => { if (!merged.reviews.some(existing => existing.questionId === item.questionId)) merged.reviews.push(item); });
    const serverSettings = (serverState && serverState.settings) || {};
    Object.keys(local.settings).forEach(key => { if (!Object.prototype.hasOwnProperty.call(serverSettings, key)) merged.settings[key] = local.settings[key]; });
    return merged;
  }
  async function syncWholeState_() {
    for (const item of Object.values(appState.progress)) await gasCall('saveProgress', item);
    for (const [lessonId, item] of Object.entries(appState.journal)) await gasCall('saveJournal', {lessonId, note:item && item.note || ''});
    for (const item of appState.reviews) await gasCall('saveReview', item);
    await gasCall('saveSettings', appState.settings);
  }

  function normalizeState(raw) {
    const migrated = migrateLegacyState(raw || {});
    return {
      progress: migrated.progress && typeof migrated.progress === 'object' ? migrated.progress : {},
      journal: migrated.journal && typeof migrated.journal === 'object' ? migrated.journal : {},
      reviews: Array.isArray(migrated.reviews) ? migrated.reviews : [],
      settings: {...DEFAULT_SETTINGS, ...(migrated.settings || {})}
    };
  }

  function migrateLegacyState(raw) {
    const lessonId = value => /^gn-\d{2}$/.test(String(value || ''))
      ? `day-${String(Number(String(value).slice(3))).padStart(3, '0')}`
      : value;
    const questionId = value => String(value || '').replace(/^gn-?(\d{2})-q/, (_, day) => `day-${String(Number(day)).padStart(3, '0')}-q`);
    const progress = {};
    Object.entries(raw.progress || {}).forEach(([key, value]) => {
      const id = lessonId(key);
      progress[id] = {...value, lessonId: lessonId(value && value.lessonId) || id};
    });
    const journal = {};
    Object.entries(raw.journal || {}).forEach(([key, value]) => { journal[lessonId(key)] = value; });
    const reviews = (raw.reviews || []).map(item => ({
      ...item,
      lessonId: lessonId(item.lessonId),
      questionId: questionId(item.questionId)
    }));
    const settings = {...(raw.settings || {})};
    settings.lastLessonId = lessonId(settings.lastLessonId) || DEFAULT_SETTINGS.lastLessonId;
    return {...raw, progress, journal, reviews, settings};
  }

  function readLocalState() {
    try {
      const current = localStorage.getItem(localStateKey());
      if (current) return JSON.parse(current);
      const legacy = localStorage.getItem(legacyLocalStateKey());
      return legacy ? JSON.parse(legacy) : {};
    } catch (error) {
      return {};
    }
  }

  function persistLocal() {
    localStorage.setItem(localStateKey(), JSON.stringify(appState));
  }

  // API directa POST: mismo patrón de conexión que Facilities KTMEX.
  async function gasCall(method, payload) {
    if (!hasAppsScript()) throw new Error('Configura SCRIPT_URL en config.js con la URL /exec de Apps Script.');
    const body = Object.assign({}, payload || {}, {authToken: authSession && authSession.token || ''});
    const response = await fetch(window.CAMINO_CONFIG.SCRIPT_URL, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify({action: method, payload: body}),
      cache: 'no-store'
    });
    if (!response.ok) throw new Error('Error HTTP ' + response.status + ' al conectar con Apps Script.');
    let result;
    try { result = await response.json(); }
    catch (error) { throw new Error('La respuesta de Apps Script no es JSON válido. Revisa la URL /exec.'); }
    if (result && result.success === false) throw new Error(result.error || 'Error del servidor.');
    if (result && result.ok === false) throw new Error(result.error || 'Error del servidor.');
    backendReady = true;
    return result;
  }

  function renderAll() {
    renderDashboard();
    renderRoute();
    renderLibrary();
    renderReviews();
    updateReviewBadge();
    renderRosary();
  }

  function showView(name) {
    if (name !== 'study') stopAudio();
    if (name !== 'rosary') { stopRosaryAudio(); if (window.speechSynthesis) speechSynthesis.cancel(); }
    $$('.app-view').forEach(view => view.classList.toggle('active', view.id === 'view-' + name));
    $$('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === name));
    if (name !== 'study') previousView = name;
    currentView = name;
    if (name === 'dashboard') renderDashboard();
    if (name === 'route') renderRoute();
    if (name === 'library') renderLibrary();
    if (name === 'reviews') renderReviews();
    if (name === 'rosary') renderRosary();
    window.scrollTo({top: 0, behavior: 'smooth'});
    $('#mainContent').focus({preventScroll: true});
  }

  function renderDashboard() {
    const next = getNextLesson();
    const completed = getCompletedLessons();
    const due = getDueReviews();
    const totalMinutes = Object.values(appState.progress).reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
    const percent = Math.round((completed.length / PLAN.lessons.length) * 100);
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';

    $('#dashboardTitle').textContent = greeting;
    $('#todayLabel').textContent = formatLongDate(new Date());
    $('#streakValue').textContent = calculateStreak();
    $('#continueDay').textContent = `Día ${next.day} de ${PLAN.totalLessons}`;
    $('#continueEstimate').textContent = appState.settings.studyMode === 'quick' ? `${PLAN.quickModeMinutes} min` : `${next.estimatedMinutes || PLAN.fullModeMinutes} min`;
    $('#continueTitle').textContent = next.title;
    $('#continueReference').textContent = next.reference;
    $('#continueButton').innerHTML = completed.length === PLAN.lessons.length ? 'Repasar la ruta <span>→</span>' : 'Continuar estudio <span>→</span>';
    $('#progressPercent').textContent = percent + '%';
    $('#progressDetail').textContent = `${completed.length} de ${PLAN.lessons.length} sesiones`;
    $('#dueReviews').textContent = due.length;
    $('#totalMinutes').textContent = totalMinutes < 60 ? `${totalMinutes} min` : `${Math.floor(totalMinutes / 60)} h ${totalMinutes % 60} min`;
    renderRoutePreview(next);
  }

  function renderRoutePreview(next) {
    const startIndex = Math.max(0, PLAN.lessons.findIndex(item => item.id === next.id) - 1);
    const items = PLAN.lessons.slice(startIndex, startIndex + 4);
    $('#routePreview').innerHTML = items.map(lesson => {
      const progress = appState.progress[lesson.id];
      const stateClass = progress && progress.status === 'completed' ? 'completed' : lesson.id === next.id ? 'current' : '';
      return `<button class="preview-step ${stateClass}" data-open-lesson="${lesson.id}">
        <span class="step-day">Día ${lesson.day}</span><strong>${escapeHtml(lesson.title)}</strong>
      </button>`;
    }).join('');
    $$('[data-open-lesson]', $('#routePreview')).forEach(button => button.addEventListener('click', () => openLesson(button.dataset.openLesson)));
  }

  function renderRoute() {
    const next = getNextLesson();
    const completed = getCompletedLessons();
    const percent = Math.round((completed.length / PLAN.lessons.length) * 100);
    $('#routeProgressRing').style.setProperty('--value', `${percent * 3.6}deg`);
    $('#routeProgressRing span').textContent = percent + '%';
    $('#routeList').innerHTML = PLAN.lessons.map(lesson => {
      const progress = appState.progress[lesson.id];
      const isComplete = progress && progress.status === 'completed';
      const isCurrent = lesson.id === next.id && !isComplete;
      const status = isComplete ? (progress.mode === 'quick' ? 'Rápido' : `Completado · ${progress.score || 0}%`) : isCurrent ? 'Siguiente' : 'Pendiente';
      const chapterCount = lesson.readings.reduce((sum, reading) => sum + reading.chapters.length, 0);
      return `<button class="route-card ${isComplete ? 'completed' : ''} ${isCurrent ? 'current' : ''}" data-route-lesson="${lesson.id}">
        <span class="route-day">${isComplete ? '✓' : lesson.day}</span>
        <span class="route-card-copy"><strong>${escapeHtml(lesson.title)}</strong><span>${escapeHtml(lesson.reference)} · ${chapterCount} ${chapterCount === 1 ? 'capítulo' : 'capítulos'}</span></span>
        <span class="route-card-meta"><span>${lesson.estimatedMinutes || PLAN.fullModeMinutes} min</span><span class="status-tag">${status}</span></span>
      </button>`;
    }).join('');
    $$('[data-route-lesson]').forEach(button => button.addEventListener('click', () => openLesson(button.dataset.routeLesson)));
  }

  function initializeLibrarySelectors() {
    const selected = BOOK_BY_ID[appState.settings.selectedBookId] ? appState.settings.selectedBookId : BOOKS[0].id;
    appState.settings.selectedBookId = selected;
    const book = BOOK_BY_ID[selected];
    $('#testamentSelect').value = book.testament;
    populateBookSelect(book.testament, selected);
  }

  function populateBookSelect(testament, preferredBookId) {
    const available = testament === 'all' ? BOOKS : BOOKS.filter(book => book.testament === testament);
    const sections = [...new Set(available.map(book => book.section))];
    $('#bookSelect').innerHTML = sections.map(section => {
      const options = available.filter(book => book.section === section)
        .map(book => `<option value="${book.id}">${escapeHtml(book.name)}</option>`).join('');
      return `<optgroup label="${escapeHtml(section)}">${options}</optgroup>`;
    }).join('');
    const selection = available.some(book => book.id === preferredBookId) ? preferredBookId : available[0].id;
    $('#bookSelect').value = selection;
    appState.settings.selectedBookId = selection;
    return BOOK_BY_ID[selection];
  }

  function onTestamentChange(event) {
    const book = populateBookSelect(event.target.value, appState.settings.selectedBookId);
    persistSetting('selectedBookId', book.id);
    clearLibrarySearch();
    renderLibrary();
  }

  function onBookChange(event) {
    persistSetting('selectedBookId', event.target.value);
    clearLibrarySearch();
    renderLibrary();
  }

  function clearLibrarySearch() {
    $('#librarySearch').value = '';
    $('#searchResults').classList.add('hidden');
    $('#searchResults').innerHTML = '';
  }

  function getSelectedBook() {
    return BOOK_BY_ID[$('#bookSelect').value] || BOOK_BY_ID[appState.settings.selectedBookId] || BOOKS[0];
  }

  function renderLibrary() {
    const book = getSelectedBook();
    if ($('#bookSelect').value !== book.id) $('#bookSelect').value = book.id;
    $('#libraryDescription').textContent = `${book.name}: texto completo y notas esenciales para la comprensión.`;
    $('#selectedBookMeta').innerHTML = `<strong>${escapeHtml(book.name)}</strong><span>${escapeHtml(book.testament)} · ${escapeHtml(book.section)} · ${book.chapterCount} ${book.chapterCount === 1 ? 'capítulo' : 'capítulos'}</span>`;
    $('#chapterGrid').innerHTML = book.chapters.map(chapter => {
      const lesson = findLessonByPassage(book.id, chapter.number);
      const isRead = lesson && appState.progress[lesson.id] && appState.progress[lesson.id].status === 'completed';
      return `<button class="chapter-button ${isRead ? 'read' : ''}" data-book-id="${book.id}" data-chapter="${chapter.number}" aria-label="Abrir ${escapeHtml(book.name)} ${chapter.number}">${chapter.number}</button>`;
    }).join('');
    $$('[data-chapter]', $('#chapterGrid')).forEach(button => button.addEventListener('click', () => openChapter(button.dataset.bookId, Number(button.dataset.chapter))));
  }

  function renderSearch(query) {
    const container = $('#searchResults');
    const book = getSelectedBook();
    if (!query) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }
    const normalized = normalizeText(query);
    let results = [];
    if (/^\d{1,3}$/.test(query)) {
      const number = Number(query);
      const chapter = book.chapters.find(item => item.number === number);
      if (chapter) results.push(chapter);
    }
    book.chapters.forEach(chapter => {
      if (results.includes(chapter)) return;
      if (normalizeText(chapter.text).includes(normalized)) results.push(chapter);
    });
    results = results.slice(0, 12);
    container.classList.remove('hidden');
    if (!results.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">⌕</div><h2>Sin coincidencias en ${escapeHtml(book.name)}</h2><p>Prueba con otra palabra o con el número del capítulo.</p></div>`;
      return;
    }
    container.innerHTML = results.map(chapter => {
      const snippet = makeSnippet(chapter.text, query);
      return `<button class="search-result" data-search-book="${book.id}" data-search-chapter="${chapter.number}"><strong>${escapeHtml(book.name)} ${chapter.number}</strong><p>${snippet}</p></button>`;
    }).join('');
    $$('[data-search-chapter]', container).forEach(button => button.addEventListener('click', () => openChapter(button.dataset.searchBook, Number(button.dataset.searchChapter))));
  }

  function openChapter(bookId, chapterNumber) {
    const lesson = findLessonByPassage(bookId, chapterNumber) || PLAN.lessons[0];
    previousView = 'library';
    openLesson(lesson.id, 'full', {bookId, chapter: chapterNumber});
  }

  function openLesson(lessonId, mode, direct = null) {
    const lesson = PLAN.lessons.find(item => item.id === lessonId) || PLAN.lessons[0];
    stopAudio();
    if (currentView !== 'study') previousView = currentView;
    currentLesson = lesson;
    currentMode = mode || appState.settings.studyMode || 'full';
    directReading = direct;
    lessonStartedAt = Date.now();
    visitedTabs = new Set(['reading']);
    notesExpanded = false;
    appState.settings.lastLessonId = lesson.id;
    persistSetting('lastLessonId', lesson.id);
    renderStudy();
    showView('study');
  }

  function renderStudy() {
    const isDirect = Boolean(directReading);
    const directBook = isDirect ? BOOK_BY_ID[directReading.bookId] : null;
    $('#studyDay').textContent = isDirect ? 'Biblioteca' : `Día ${currentLesson.day} de ${PLAN.totalLessons}`;
    $('#studyTitle').textContent = isDirect ? `${directBook.name} ${directReading.chapter}` : currentLesson.title;
    $('#studyReference').textContent = isDirect ? `Capítulo ${directReading.chapter}` : currentLesson.reference;
    $('#studyModeLabel').textContent = isDirect ? 'Consulta directa' : currentMode === 'quick' ? 'Modo rápido' : 'Modo completo';
    $('#readingRange').textContent = getReadingReference();
    $('#lessonObjective').textContent = currentLesson.objective;
    $('#lessonContext').textContent = currentLesson.context;
    $('#lessonIdeas').innerHTML = currentLesson.keyIdeas.map(item => `<li>${escapeHtml(item)}</li>`).join('');
    $('#lessonMeditate').textContent = currentLesson.meditate;
    $('#lessonPrayer').textContent = currentLesson.prayer;
    $('#lessonAction').textContent = currentLesson.action;
    $('#journalInput').value = appState.journal[currentLesson.id] ? appState.journal[currentLesson.id].note : '';
    $('#journalStatus').textContent = 'Se guarda automáticamente';
    $('#modeFull').classList.toggle('active', currentMode === 'full');
    $('#modeQuick').classList.toggle('active', currentMode === 'quick');
    $('#modeDescription').textContent = currentMode === 'quick'
      ? 'Lectura central y claves esenciales para mantener la constancia.'
      : 'Lectura completa, contexto, Catecismo y preguntas.';
    $('#completeLesson').classList.toggle('hidden', isDirect);
    $('#completeHint').classList.toggle('hidden', isDirect);
    $('#modeFull').disabled = isDirect;
    $('#modeQuick').disabled = isDirect;
    renderReading();
    renderNotes();
    renderCatechism();
    renderQuiz();
    switchStudyTab('reading');
    updateSessionProgress();
  }

  function renderReading() {
    $('#readingChapters').innerHTML = getDisplayedChapterRecords().map(({book, chapter}) =>
      `<article class="chapter-article"><header class="chapter-heading"><h2>${escapeHtml(book.name)} ${chapter.number}</h2><span>${estimateReadingTime(chapter.text)} min de lectura</span></header><div class="scripture-text">${formatScripture(chapter.text)}</div></article>`
    ).join('');
  }

  function renderNotes() {
    const notes = getDisplayedChapterRecords().flatMap(({book, chapter}) =>
      (book.notesByChapter[String(chapter.number)] || []).map(note => ({...note, bookName: book.name, chapter: chapter.number}))
    );
    const container = $('#chapterNotes');
    container.classList.toggle('notes-fade', !notesExpanded && notes.length > 5);
    container.innerHTML = notes.length
      ? notes.map(note => `<article class="study-note"><strong>${escapeHtml(note.reference || `${note.bookName} ${note.chapter}`)}</strong><p>${escapeHtml(note.text)}</p></article>`).join('')
      : '<div class="empty-state compact"><p>Esta lectura no requiere una nota adicional para su comprensión básica.</p></div>';
    $('#toggleAllNotes').textContent = notesExpanded ? 'Mostrar menos' : `Mostrar todas (${notes.length})`;
    $('#toggleAllNotes').classList.toggle('hidden', notes.length <= 5);
  }

  function renderCatechism() {
    $('#catechismLinks').innerHTML = currentLesson.catechism.map(reference => `<a class="catechism-link" href="${PLAN.sources.catechism}" target="_blank" rel="noopener"><span>${escapeHtml(reference)}</span><span>Consultar ↗</span></a>`).join('');
  }

  function renderQuiz() {
    $('#quizForm').innerHTML = currentLesson.quiz.map((question, index) => `<article class="question-card"><fieldset><legend><span class="question-number">Pregunta ${index + 1}</span><br>${escapeHtml(question.prompt)}</legend>${question.options.map((option, optionIndex) => `<label class="quiz-option"><input type="radio" name="${question.id}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('')}</fieldset></article>`).join('') + '<button class="primary-button quiz-submit" type="submit">Revisar respuestas</button>';
    $('#quizResult').className = 'quiz-result hidden';
    $('#quizResult').innerHTML = '';
  }

  function switchStudyTab(tabName) {
    $$('.study-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tabName));
    $$('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === 'tab-' + tabName));
    visitedTabs.add(tabName);
    updateSessionProgress();
  }

  function changeMode(mode) {
    if (directReading) return;
    currentMode = mode;
    $('#modeFull').classList.toggle('active', mode === 'full');
    $('#modeQuick').classList.toggle('active', mode === 'quick');
    $('#studyModeLabel').textContent = mode === 'quick' ? 'Modo rápido' : 'Modo completo';
    $('#modeDescription').textContent = mode === 'quick'
      ? 'Lectura central y claves esenciales para mantener la constancia.'
      : 'Lectura completa, contexto, Catecismo y preguntas.';
    $('#readingRange').textContent = getReadingReference();
    renderReading();
    renderNotes();
    stopAudio();
  }

  function getDisplayedReadings() {
    if (directReading) return [{bookId: directReading.bookId, chapters: [directReading.chapter]}];
    return currentMode === 'quick' ? currentLesson.quickReadings : currentLesson.readings;
  }

  function getDisplayedChapterRecords() {
    return getDisplayedReadings().flatMap(reading => {
      const book = BOOK_BY_ID[reading.bookId];
      if (!book) return [];
      return reading.chapters.map(number => ({
        book,
        chapter: book.chapters.find(item => item.number === number)
      })).filter(item => item.chapter);
    });
  }

  function getReadingReference() {
    return getDisplayedReadings().map(reading => {
      const book = BOOK_BY_ID[reading.bookId];
      const chapters = reading.chapters;
      return chapters.length === 1 ? `${book.name} ${chapters[0]}` : `${book.name} ${chapters[0]}–${chapters[chapters.length - 1]}`;
    }).join('; ');
  }

  function toggleNotes() {
    notesExpanded = !notesExpanded;
    renderNotes();
  }

  async function submitQuiz(event) {
    event.preventDefault();
    const answers = currentLesson.quiz.map(question => {
      const input = $(`input[name="${question.id}"]:checked`, event.currentTarget);
      return input ? Number(input.value) : null;
    });
    if (answers.some(value => value === null)) {
      showToast('Responde las tres preguntas antes de revisar.');
      return;
    }
    const correctCount = answers.filter((answer, index) => answer === currentLesson.quiz[index].correct).length;
    const score = Math.round((correctCount / currentLesson.quiz.length) * 100);
    const existing = appState.progress[currentLesson.id] || {};
    const progress = {
      ...existing,
      lessonId: currentLesson.id,
      mode: currentMode,
      status: existing.status || 'in_progress',
      score,
      attempts: (Number(existing.attempts) || 0) + 1,
      minutes: Number(existing.minutes) || 0,
      completedAt: existing.completedAt || ''
    };
    appState.progress[currentLesson.id] = progress;
    await persistProgress(progress, false);

    const reviews = [];
    currentLesson.quiz.forEach((question, index) => {
      reviews.push(scheduleReview(question, answers[index] === question.correct));
    });
    await Promise.all(reviews);

    $('#quizResult').className = `quiz-result ${score >= 80 ? 'pass' : 'review'}`;
    $('#quizResult').innerHTML = `<h2>${score >= 80 ? 'Comprensión lograda' : 'Hay temas para reforzar'}</h2><p>Resultado: <strong>${score}%</strong> · ${correctCount} de ${currentLesson.quiz.length} respuestas correctas.</p>${currentLesson.quiz.map((question, index) => `<div class="answer-review ${answers[index] === question.correct ? 'correct' : 'incorrect'}"><strong>${answers[index] === question.correct ? 'Correcta' : 'Para revisar'}:</strong> ${escapeHtml(question.explanation)}</div>`).join('')}`;
    visitedTabs.add('quiz');
    updateSessionProgress();
    renderReviews();
    updateReviewBadge();
    showToast(score >= 80 ? 'Muy bien. El repaso ya quedó programado.' : 'Guardé estos temas para repasarlos de nuevo.');
  }

  async function scheduleReview(question, wasCorrect) {
    const existing = appState.reviews.find(item => item.questionId === question.id);
    const oldLevel = existing ? Number(existing.level) || 0 : 0;
    const level = wasCorrect ? Math.min(oldLevel + 1, REVIEW_INTERVALS.length - 1) : 0;
    const dueDate = addDays(new Date(), REVIEW_INTERVALS[level]).toISOString();
    const review = {
      questionId: question.id,
      lessonId: currentLesson.id,
      dueDate,
      level,
      correctCount: (existing ? Number(existing.correctCount) || 0 : 0) + (wasCorrect ? 1 : 0),
      lastResult: wasCorrect,
      updatedAt: new Date().toISOString()
    };
    if (existing) Object.assign(existing, review);
    else appState.reviews.push(review);
    persistLocal();
    if (hasAppsScript()) {
      try { await gasCall('saveReview', review); setSyncStatus('synced', 'Sincronizado'); }
      catch (error) { setSyncStatus('error', 'Pendiente'); console.error(error); }
    }
    return review;
  }

  async function completeCurrentLesson() {
    if (directReading) return;
    const existing = appState.progress[currentLesson.id] || {};
    const addedMinutes = Math.max(1, Math.round((Date.now() - lessonStartedAt) / 60000));
    const progress = {
      ...existing,
      lessonId: currentLesson.id,
      mode: currentMode,
      status: 'completed',
      score: Number(existing.score) || 0,
      attempts: Number(existing.attempts) || 0,
      minutes: (Number(existing.minutes) || 0) + addedMinutes,
      completedAt: new Date().toISOString()
    };
    appState.progress[currentLesson.id] = progress;
    await persistProgress(progress, true);
    renderAll();
    const next = getNextLesson();
    showToast(currentLesson.id === PLAN.lessons.at(-1).id ? '¡Terminaste la ruta completa de la Biblia!' : `Sesión guardada. La siguiente es: ${next.title}`);
    showView('dashboard');
  }

  async function persistProgress(progress, notify) {
    persistLocal();
    if (hasAppsScript()) {
      setSyncStatus('loading', 'Guardando');
      try {
        await gasCall('saveProgress', progress);
        setSyncStatus('synced', 'Sincronizado');
      } catch (error) {
        setSyncStatus('error', 'Pendiente');
        if (notify) showToast('El avance quedó en este dispositivo. Intenta guardar de nuevo cuando recuperes conexión.');
        console.error(error);
      }
    }
  }

  function scheduleJournalSave() {
    $('#journalStatus').textContent = 'Cambios pendientes…';
    window.clearTimeout(journalTimer);
    journalTimer = window.setTimeout(() => saveCurrentJournal(false), 850);
  }

  async function saveCurrentJournal(notify) {
    if (!currentLesson) return;
    const note = $('#journalInput').value.trim();
    const entry = {note, updatedAt: new Date().toISOString()};
    appState.journal[currentLesson.id] = entry;
    persistLocal();
    $('#journalStatus').textContent = 'Guardado en este dispositivo';
    if (hasAppsScript()) {
      try {
        await gasCall('saveJournal', {lessonId: currentLesson.id, note});
        $('#journalStatus').textContent = 'Sincronizado';
        setSyncStatus('synced', 'Sincronizado');
      } catch (error) {
        $('#journalStatus').textContent = 'Pendiente de sincronizar';
        setSyncStatus('error', 'Pendiente');
        console.error(error);
      }
    }
    if (notify) showToast('Tu nota personal quedó guardada.');
  }

  function renderReviews() {
    const now = new Date();
    const due = getDueReviews();
    const upcoming = appState.reviews.filter(item => new Date(item.dueDate) > now).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    const mastered = appState.reviews.filter(item => Number(item.level) >= 4).length;
    $('#reviewSummary').innerHTML = `<article class="review-stat"><strong>${due.length}</strong><span>para repasar hoy</span></article><article class="review-stat"><strong>${upcoming.length}</strong><span>programadas después</span></article><article class="review-stat"><strong>${mastered}</strong><span>en nivel de consolidación</span></article>`;
    const container = $('#reviewList');
    if (!due.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">✓</div><h2>Estás al día</h2><p>Cuando respondas las preguntas, aquí aparecerán tus próximos repasos.</p>${upcoming.slice(0, 4).map(item => `<p><strong>${escapeHtml(findLesson(item.lessonId).title)}</strong> · ${formatShortDate(new Date(item.dueDate))}</p>`).join('')}</div>`;
      return;
    }
    container.innerHTML = due.map(review => {
      const found = findQuestion(review.questionId);
      if (!found) return '';
      return `<article class="review-card due" data-review-card="${review.questionId}"><span class="eyebrow">${escapeHtml(found.lesson.reference)} · Nivel ${Number(review.level) + 1}</span><h3>${escapeHtml(found.question.prompt)}</h3><div class="review-options">${found.question.options.map((option, index) => `<button class="review-option" data-review-answer="${review.questionId}" data-option="${index}">${escapeHtml(option)}</button>`).join('')}</div><div class="review-feedback hidden"></div></article>`;
    }).join('');
    $$('[data-review-answer]', container).forEach(button => button.addEventListener('click', answerReview));
  }

  async function answerReview(event) {
    const button = event.currentTarget;
    const review = appState.reviews.find(item => item.questionId === button.dataset.reviewAnswer);
    const found = findQuestion(review.questionId);
    const correct = Number(button.dataset.option) === found.question.correct;
    const card = button.closest('.review-card');
    const feedback = $('.review-feedback', card);
    feedback.classList.remove('hidden');
    feedback.innerHTML = `<strong>${correct ? 'Correcto' : 'Revisa esta idea'}.</strong> ${escapeHtml(found.question.explanation)}`;
    $$('[data-review-answer]', card).forEach(item => item.disabled = true);
    const oldLevel = Number(review.level) || 0;
    review.level = correct ? Math.min(oldLevel + 1, REVIEW_INTERVALS.length - 1) : 0;
    review.correctCount = (Number(review.correctCount) || 0) + (correct ? 1 : 0);
    review.lastResult = correct;
    review.dueDate = addDays(new Date(), REVIEW_INTERVALS[review.level]).toISOString();
    review.updatedAt = new Date().toISOString();
    persistLocal();
    if (hasAppsScript()) {
      try { await gasCall('saveReview', review); setSyncStatus('synced', 'Sincronizado'); }
      catch (error) { setSyncStatus('error', 'Pendiente'); }
    }
    window.setTimeout(() => { renderReviews(); updateReviewBadge(); renderDashboard(); }, 1150);
  }

  function updateReviewBadge() {
    const count = getDueReviews().length;
    $('#reviewNavBadge').textContent = count;
    $('#reviewNavBadge').classList.toggle('hidden', count === 0);
  }

  function enterReadingMode() {
    switchStudyTab('reading');
    document.body.classList.add('reading-mode');
    $('#readerModeButton').setAttribute('aria-pressed','true');
    $('#readerModeButton').textContent='Lectura activa';
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(()=>{});
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function exitReadingMode(exitFullscreen=true) {
    document.body.classList.remove('reading-mode');
    if ($('#readerModeButton')) { $('#readerModeButton').setAttribute('aria-pressed','false'); $('#readerModeButton').textContent='Pantalla de lectura'; }
    if (exitFullscreen && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(()=>{});
  }
  function adjustReaderFont(delta) {
    const current=Number(appState.settings.fontScale || 1);
    const next=Math.max(0.85,Math.min(1.8,Math.round((current+delta)*100)/100));
    appState.settings.fontScale=String(next);
    document.documentElement.style.setProperty('--scripture-scale',String(next));
    if ($('#fontScale')) $('#fontScale').value=String(Math.min(1.8,Math.max(0.85,next)));
    persistLocal();
    if (backendReady) gasCall('saveSettings',{fontScale:String(next)}).catch(console.warn);
  }

  function openSettings() {
    $('#fontScale').value = appState.settings.fontScale || '1';
    $('#defaultMode').value = appState.settings.studyMode || 'full';
    $('#themeSelect').value = appState.settings.theme || 'light';
    $('#settingsDialog').showModal();
  }

  async function saveSettingsFromDialog() {
    appState.settings.fontScale = $('#fontScale').value;
    appState.settings.studyMode = $('#defaultMode').value;
    appState.settings.theme = $('#themeSelect').value;
    appState.settings.audioProvider = $('#audioProvider').value;
    applySettings();
    persistLocal();
    $('#settingsDialog').close();
    if (hasAppsScript()) {
      try { await gasCall('saveSettings', appState.settings); setSyncStatus('synced', 'Sincronizado'); }
      catch (error) { setSyncStatus('error', 'Pendiente'); }
    }
    renderDashboard();
    showToast('Preferencias guardadas.');
  }

  async function testGeminiVoicesFromUi() {
    const button = $('#testGeminiVoicesButton');
    const status = $('#geminiTestStatus');
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Comprobando…';
    status.textContent = 'Probando únicamente la voz seleccionada para cuidar tu cuota de Gemini…';
    status.className = 'audio-test-status';
    try {
      const selectedVoice = $('#audioVoice').value || 'female';
      const result = await gasCall('testGeminiVoices', {voice:selectedVoice});
      const voices = result.voices || [];
      const tested = voices[0];
      audioConfig.providers = audioConfig.providers || {};
      audioConfig.providers.gemini = Boolean(result.anyAvailable);
      audioConfig.geminiTested = true;
      audioConfig.geminiKeyPresent = Boolean(result.configured);
      if (tested) $('#audioVoice option[value="' + tested.id + '"]').disabled = !tested.available;
      if (result.anyAvailable && (!appState.settings.audioProvider || appState.settings.audioProvider === 'device')) {
        appState.settings.audioProvider = 'gemini';
        $('#audioProvider').value = 'gemini';
        persistLocal();
        if (backendReady) gasCall('saveSettings', {audioProvider:'gemini'}).catch(console.warn);
      }
      const details = voices.map(item => `${item.name}: ${item.available ? 'disponible' : (item.error || 'no disponible')}`).join(' · ');
      status.textContent = `${result.message || 'Prueba terminada'} ${details}`;
      status.classList.toggle('success', Boolean(result.anyAvailable));
      status.classList.toggle('error', !result.anyAvailable);
      renderAudioAvailability();
      showToast(result.anyAvailable ? 'La voz seleccionada de Gemini respondió correctamente.' : 'La voz seleccionada no está disponible. Revisa el diagnóstico y la cuota.');
    } catch (error) {
      status.textContent = error.message || 'No se pudo probar Gemini.';
      status.classList.add('error');
      showToast('Error al comprobar Gemini: ' + (error.message || 'revisa la implementación.'));
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function applySettings() {
    document.documentElement.style.setProperty('--scripture-scale', appState.settings.fontScale || '1');
    document.documentElement.dataset.theme = appState.settings.theme || 'light';
    $('#speechRate').value = appState.settings.speechRate || '1';
    $('#audioProvider').value = appState.settings.audioProvider || audioConfig.defaultProvider || 'device';
    $('#audioVoice').value = appState.settings.audioVoice || 'female';
    renderAudioAvailability();
  }

  async function onAudioProviderChange(event) {
    appState.settings.audioProvider = event.target.value;
    persistLocal();
    try { if (backendReady) await gasCall('saveSettings', {audioProvider:event.target.value}); } catch(error) { console.warn(error); }
    renderAudioAvailability();
    if (speechPlaying || speechLoading) { stopAudio(); showToast('Proveedor de voz actualizado. Pulsa reproducir para continuar.'); }
  }

  async function onAudioVoiceChange(event) {
    appState.settings.audioVoice = event.target.value;
    persistLocal();
    try { if (backendReady) await gasCall('saveSettings', {audioVoice:event.target.value}); } catch(error) { console.warn(error); }
    if (speechPlaying || speechLoading) { stopAudio(); showToast('Voz actualizada. Pulsa reproducir para continuar.'); }
  }

  async function onSpeechRateChange(event) {
    appState.settings.speechRate = event.target.value;
    persistLocal();
    if (speechPlaying || speechLoading) await startAudio();
    if (hasAppsScript()) {
      try { await gasCall('saveSettings', {speechRate: event.target.value}); }
      catch (error) { console.error(error); }
    }
  }

  async function persistSetting(key, value) {
    appState.settings[key] = value;
    persistLocal();
    if (hasAppsScript()) {
      try { await gasCall('saveSettings', {[key]: value}); }
      catch (error) { console.error(error); }
    }
  }

  function getRosaryTypeForToday() {
    const day = new Date().getDay();
    return day === 1 || day === 6 ? 'gozosos' : day === 4 ? 'luminosos' : day === 2 || day === 5 ? 'dolorosos' : 'gloriosos';
  }
  function getRosarySet() {
    const data = window.ROSARY_DATA && window.ROSARY_DATA.mysteries;
    const key = $('#rosaryMysterySelect').value || appState.settings.rosaryMysteryType || getRosaryTypeForToday();
    return data && data[key] ? {key, ...data[key]} : null;
  }
  // V2.8: secuencia guiada de oraciones sin catálogo separado.
  let guidedRosaryStep = 0;
  let guidedRosaryAudio = null;
  let guidedRosaryAudioUrl = null;
  function guidedRosarySteps() {
    const prayers = window.ROSARY_DATA.prayers;
    const set = getRosarySet();
    if (!set) return [];
    const steps = [];
    function add(title, text, hint, mystery) { steps.push({title, text, hint, mystery}); }
    add('Señal de la Cruz',prayers.senal,'Haz la señal de la cruz con devoción.','Preparación');
    add('Acto de contrición',prayers.contricion,'Pide perdón a Dios con sinceridad.','Preparación');
    add('Ofrecimiento del Rosario',prayers.ofrecimiento,'Puedes presentar en silencio una intención personal.','Preparación');
    add('Credo de los Apóstoles',prayers.credo,'En el crucifijo, profesamos nuestra fe.','Preparación');
    add('Padre Nuestro',prayers.padre,'En la primera cuenta grande.','Preparación');
    ['Por la fe','Por la esperanza','Por la caridad'].forEach((reason,i)=>add('Ave María '+(i+1)+' de 3',prayers.ave,reason+'. Reza el texto completo.','Preparación'));
    add('Gloria',prayers.gloria,'Concluimos las oraciones iniciales.','Preparación');
    set.items.forEach((item,i)=>{
      const n=i+1, which='Misterio '+n+' de 5';
      add('Anunciamos el '+['primer','segundo','tercer','cuarto','quinto'][i]+' misterio: '+item.title,
          item.meditation+'\n\nCita bíblica: '+item.reference+'\nFruto del misterio: '+item.fruit,
          'Lee y medita un momento. Después comienza la decena.',which);
      add('Padre Nuestro · misterio '+n,prayers.padre,'Reza un Padre Nuestro en la cuenta grande.',which);
      for(let bead=1;bead<=10;bead++) add('Ave María '+bead+' de 10',prayers.ave,
          'Misterio '+n+'. Después de rezarla, pulsa «Siguiente».',which);
      add('Gloria · misterio '+n,prayers.gloria,'Al terminar las diez Ave Marías.',which);
      add('María, Madre de gracia · misterio '+n,prayers.mariaGracia,'Reza esta oración mariana después del Gloria.',which);
      add('Oración de Fátima · misterio '+n,prayers.fatima,'Continúa con la oración de Fátima.',which);
    });
    add('Salve a la Virgen María',prayers.salve,'Hemos meditado los cinco misterios.','Conclusión');
    add('Oración final del Rosario',prayers.oracionFinal,'Oremos juntos para concluir.','Conclusión');
    add('Señal de la Cruz',prayers.senal,'Has terminado el Santo Rosario. Amén.','Conclusión');
    return steps;
  }
  function renderGuidedRosary() {
    const steps=guidedRosarySteps(); if (!steps.length || !$('#guidedRosaryHeading')) return;
    guidedRosaryStep=Math.max(0,Math.min(guidedRosaryStep,steps.length-1));
    const step=steps[guidedRosaryStep];
    $('#guidedRosaryPosition').textContent='Oración '+(guidedRosaryStep+1)+' de '+steps.length;
    $('#guidedRosaryMystery').textContent=step.mystery;
    $('#guidedRosaryHeading').textContent=step.title;
    $('#guidedRosaryText').textContent=step.text.replace(/\\n/g,'\n');
    $('#guidedRosaryHint').textContent=step.hint;
    $('#guidedRosaryBack').disabled=guidedRosaryStep===0;
    $('#guidedRosaryNext').disabled=guidedRosaryStep===steps.length-1;
    $('#guidedRosaryNext').textContent=guidedRosaryStep===steps.length-2?'Terminar Rosario →':'Siguiente →';
  }
  function stopGuidedRosaryAudio() {
    if(guidedRosaryAudio){guidedRosaryAudio.pause();guidedRosaryAudio=null;}
    if(guidedRosaryAudioUrl){URL.revokeObjectURL(guidedRosaryAudioUrl);guidedRosaryAudioUrl=null;}
    if(window.speechSynthesis) speechSynthesis.cancel();
    if($('#guidedRosarySpeak')) {$('#guidedRosarySpeak').textContent='▶ Escuchar oración';$('#guidedRosarySpeak').disabled=false;}
  }
  async function speakGuidedRosary() {
    if(guidedRosaryAudio || (window.speechSynthesis && speechSynthesis.speaking)){stopGuidedRosaryAudio();return;}
    const step=guidedRosarySteps()[guidedRosaryStep];if(!step)return;
    const button=$('#guidedRosarySpeak');button.disabled=true;button.textContent='Preparando voz…';
    const provider=appState.settings.audioProvider || audioConfig.defaultProvider || 'device';
    const providerReady=provider!=='device' && backendReady && Boolean(audioConfig.providers && audioConfig.providers[provider]);
    try {
      if(providerReady){
        const result=await gasCall('generateSpeech',{text:step.text.replace(/\\n/g,' '),rate:Number($('#speechRate').value)||1,provider,voice:appState.settings.audioVoice||'female'});
        if(!result.audioBase64)throw new Error('El servicio no devolvió audio.');
        const bytes=Uint8Array.from(atob(result.audioBase64),c=>c.charCodeAt(0));
        guidedRosaryAudioUrl=URL.createObjectURL(new Blob([bytes],{type:result.mimeType||'audio/wav'}));
        guidedRosaryAudio=new Audio(guidedRosaryAudioUrl);
        guidedRosaryAudio.onended=stopGuidedRosaryAudio;
        guidedRosaryAudio.onerror=()=>{stopGuidedRosaryAudio();showToast('No se pudo reproducir el audio.');};
        await guidedRosaryAudio.play();button.disabled=false;button.textContent='■ Detener oración';
      } else if('speechSynthesis' in window){
        const utterance=new SpeechSynthesisUtterance(step.text.replace(/\\n/g,' '));
        utterance.lang='es-MX';utterance.rate=Number($('#speechRate').value)||1;
        utterance.onend=stopGuidedRosaryAudio;
        speechSynthesis.speak(utterance);button.disabled=false;button.textContent='■ Detener oración';
      } else throw new Error('El navegador no admite reproducción de voz.');
    } catch(error){stopGuidedRosaryAudio();showToast('No se pudo reproducir: '+error.message);}
  }
  function syncRosaryMysteryFromGuide() {
    const step = guidedRosarySteps()[guidedRosaryStep];
    if (!step || !step.mystery) return;
    const match = String(step.mystery).match(/Misterio\s+(\d+)\s+de\s+5/i);
    if (match) {
      const nextIndex = Number(match[1]) - 1;
      if (nextIndex !== rosaryMysteryIndex) {
        rosaryMysteryIndex = nextIndex;
        rosaryBeadProgress = new Set();
        renderRosaryMystery();
      }
    }
  }
  function setupGuidedRosary() {
    $('#guidedRosaryBack').addEventListener('click',()=>{
      stopGuidedRosaryAudio();
      guidedRosaryStep=Math.max(0,guidedRosaryStep-1);
      syncRosaryMysteryFromGuide();
      renderGuidedRosary();
    });
    $('#guidedRosaryNext').addEventListener('click',()=>{
      stopGuidedRosaryAudio();
      guidedRosaryStep=Math.min(guidedRosarySteps().length-1,guidedRosaryStep+1);
      syncRosaryMysteryFromGuide();
      renderGuidedRosary();
    });
    $('#guidedRosaryRestart').addEventListener('click',()=>{
      stopGuidedRosaryAudio();guidedRosaryStep=0;rosaryMysteryIndex=0;rosaryBeadProgress=new Set();
      renderRosaryMystery();renderGuidedRosary();
    });
    $('#guidedRosarySpeak').addEventListener('click',speakGuidedRosary);
  }
  function renderRosary() {
    if (!$('#rosaryMysterySelect')) return;
    const preferred = appState.settings.rosaryMysteryType || getRosaryTypeForToday();
    $('#rosaryMysterySelect').value = window.ROSARY_DATA.mysteries[preferred] ? preferred : getRosaryTypeForToday();
    const set = getRosarySet();
    if (!set) return;
    $('#rosaryMysteryLabel').textContent = set.label;
    $('#rosaryMysteryDescription').textContent = set.description;
    $('#rosaryDayLabel').textContent = set.days;
    $('#rosaryIntention').value = appState.settings.rosaryIntention || '';
    renderRosaryMystery();
    renderGuidedRosary();
  }
  function renderRosaryMystery() {
    const set = getRosarySet();
    if (!set) return;
    const item = set.items[rosaryMysteryIndex];
    $('#rosaryMysteryNumber').textContent = ['Primer','Segundo','Tercer','Cuarto','Quinto'][rosaryMysteryIndex] + ' misterio';
    $('#rosaryProgressLabel').textContent = `Misterio ${rosaryMysteryIndex + 1} de 5`;
    $('#rosaryCurrentTitle').textContent = item.title;
    $('#rosaryCurrentReference').textContent = item.reference;
    $('#rosaryCurrentMeditation').textContent = item.meditation;
    $('#rosaryCurrentFruit').textContent = item.fruit;
    $('#rosaryBeadCount').textContent = `${rosaryBeadProgress.size} de 10`;
    $('#rosaryBeads').innerHTML = Array.from({length:10}, (_,i) => `<button type="button" class="rosary-bead ${rosaryBeadProgress.has(i+1) ? 'done' : ''}" data-rosary-bead="${i+1}" aria-label="Ave María ${i+1}${rosaryBeadProgress.has(i+1) ? ', completada' : ''}" aria-pressed="${rosaryBeadProgress.has(i+1)}">${i+1}</button>`).join('');
    $('#rosaryCompleteDecade').disabled = rosaryBeadProgress.size !== 10;
    $('#rosaryPrevMystery').disabled = rosaryMysteryIndex === 0;
    $('#rosaryPrayerStatus').textContent = rosaryBeadProgress.size === 10 ? 'Decena completa. Reza el Gloria y continúa al siguiente misterio.' : 'Comienza con el Padre Nuestro y después reza las diez Ave Marías.';
  }
  function onRosaryMysteryChange(event) {
    appState.settings.rosaryMysteryType = event.target.value;
    rosaryMysteryIndex = 0;
    rosaryBeadProgress = new Set();
    guidedRosaryStep = 0;
    stopGuidedRosaryAudio();
    persistSetting('rosaryMysteryType', event.target.value);
    renderRosary();
  }
  function onRosaryBeadClick(event) {
    const button = event.target.closest('[data-rosary-bead]');
    if (!button) return;
    const number = Number(button.dataset.rosaryBead);
    if (rosaryBeadProgress.has(number)) rosaryBeadProgress.delete(number); else rosaryBeadProgress.add(number);
    renderRosaryMystery();
  }
  function moveRosaryMystery(direction) {
    const next = Math.max(0, Math.min(4, rosaryMysteryIndex + direction));
    if (next === rosaryMysteryIndex) return;
    rosaryMysteryIndex = next;
    rosaryBeadProgress = new Set();
    renderRosaryMystery();
  }
  function completeRosaryDecade() {
    if (rosaryBeadProgress.size !== 10) return;
    // Al completar las diez Ave Marías, no saltar al misterio siguiente:
    // guiar primero Gloria, María Madre de gracia y oración de Fátima.
    const steps = guidedRosarySteps();
    const targetTitle = 'Gloria · misterio ' + (rosaryMysteryIndex + 1);
    const targetIndex = steps.findIndex(step => step.title === targetTitle);
    if (targetIndex >= 0) {
      stopGuidedRosaryAudio();
      guidedRosaryStep = targetIndex;
      renderGuidedRosary();
      $('#guidedRosaryHeading').scrollIntoView({behavior:'smooth', block:'center'});
      $('#rosaryPrayerStatus').textContent = 'Decena completa. Reza ahora el Gloria, la oración a María Madre de gracia y la oración de Fátima antes de avanzar al siguiente misterio.';
      showToast('Decena completada. Continúa con el Gloria y las oraciones siguientes.');
      return;
    }
    $('#rosaryPrayerStatus').textContent = 'No se pudo localizar el paso siguiente de la guía. Abre nuevamente el Rosario guiado.';
    showToast('Revisa la guía del Rosario para continuar.');
  }
  function showRosaryPrayer(key) {
    const prayer = window.ROSARY_DATA.prayers[key];
    if (!prayer) return;
    const names = {senal:'Señal de la Santa Cruz',contricion:'Acto de contrición',ofrecimiento:'Ofrecimiento del Rosario',credo:'Credo de los Apóstoles',padre:'Padre Nuestro',ave:'Ave María',gloria:'Gloria',fatima:'Oración de Fátima',salve:'Salve',oracionFinal:'Oración final'};
    $('#rosaryPrayerText').innerHTML = `<strong>${names[key] || 'Oración'}</strong><p>${escapeHtml(prayer)}</p>`;
  }
  async function persistRosaryIntention() {
    const value = $('#rosaryIntention').value.trim();
    appState.settings.rosaryIntention = value;
    persistLocal();
    try {
      if (backendReady) await gasCall('saveSettings', {rosaryIntention:value});
      $('#rosaryIntentionStatus').textContent = 'Intención guardada en tu cuenta.';
      showToast('Tu intención del Rosario quedó guardada.');
    } catch (error) {
      $('#rosaryIntentionStatus').textContent = 'Guardada en este dispositivo; sincronización pendiente.';
      showToast('No se pudo sincronizar la intención: ' + error.message);
    }
  }
  async function speakRosaryMeditation() {
    const button = $('#rosarySpeakButton');
    if (rosaryAudio || (window.speechSynthesis && speechSynthesis.speaking)) {
      stopRosaryAudio();
      if (window.speechSynthesis) speechSynthesis.cancel();
      button.disabled = false;
      button.textContent = '▶ Escuchar meditación';
      return;
    }
    const set = getRosarySet();
    const item = set.items[rosaryMysteryIndex];
    const text = `${item.title}. ${item.reference}. ${item.meditation}. Fruto del misterio: ${item.fruit}.`;
    const provider = appState.settings.audioProvider || audioConfig.defaultProvider || 'device';
    const providerReady = provider !== 'device' && backendReady && Boolean(audioConfig.providers && audioConfig.providers[provider]);
    button.disabled = true;
    button.textContent = 'Preparando voz…';
    try {
      if (providerReady) {
        const result = await gasCall('generateSpeech', {text, rate:Number($('#speechRate').value)||1, provider, voice:appState.settings.audioVoice||'female'});
        if (!result.audioBase64) throw new Error('Gemini no devolvió audio.');
        stopRosaryAudio();
        const bytes = Uint8Array.from(atob(result.audioBase64), c => c.charCodeAt(0));
        rosaryAudioUrl = URL.createObjectURL(new Blob([bytes], {type:result.mimeType||'audio/wav'}));
        rosaryAudio = new Audio(rosaryAudioUrl);
        rosaryAudio.onended = () => {
          stopRosaryAudio(); button.disabled = false; button.textContent = '▶ Escuchar meditación';
        };
        rosaryAudio.onerror = () => {
          stopRosaryAudio(); button.disabled = false; button.textContent = '▶ Escuchar meditación';
          showToast('No se pudo reproducir el audio generado.');
        };
        await rosaryAudio.play();
        button.disabled = false;
        button.textContent = '■ Detener meditación';
      } else if ('speechSynthesis' in window) {
        if (provider !== 'device') showToast(`${provider === 'gemini' ? 'Gemini' : 'OpenAI'} no está disponible; se usará la voz del dispositivo.`);
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'es-MX';
        utterance.rate = Number($('#speechRate').value)||1;
        utterance.onend = () => { button.disabled = false; button.textContent = '▶ Escuchar meditación'; };
        utterance.onerror = () => { button.disabled = false; button.textContent = '▶ Escuchar meditación'; };
        speechSynthesis.cancel();
        speechSynthesis.speak(utterance);
        button.disabled = false;
        button.textContent = '■ Detener meditación';
      } else throw new Error('Este navegador no ofrece lectura de voz.');
    } catch (error) {
      showToast('No se pudo reproducir la meditación: ' + error.message);
      button.disabled = false;
      button.textContent = '▶ Escuchar meditación';
    }
  }
  function stopRosaryAudio() {
    if (rosaryAudio) { rosaryAudio.pause(); rosaryAudio.src = ''; rosaryAudio = null; }
    if (rosaryAudioUrl) { URL.revokeObjectURL(rosaryAudioUrl); rosaryAudioUrl = null; }
  }

  function renderOrientation() {
    $('#orientationContent').innerHTML = `<p>${escapeHtml(PLAN.orientation.title)}: estas claves acompañarán toda la ruta.</p><ul>${PLAN.orientation.points.map(point => `<li>${escapeHtml(point)}</li>`).join('')}</ul><div class="catechism-links">${PLAN.orientation.catechism.map(item => `<div class="catechism-link"><span>${escapeHtml(item)}</span><span>Base de estudio</span></div>`).join('')}</div>`;
  }

  function openAiDialog() {
    $('#aiQuestion').value = '';
    $('#aiDialog').showModal();
    window.setTimeout(() => $('#aiQuestion').focus(), 80);
  }

  async function launchChatGpt() {
    const question = $('#aiQuestion').value.trim() || 'Ayúdame a identificar la enseñanza principal de este pasaje y hazme dos preguntas para comprobar que lo comprendí.';
    const excerpt = getDisplayedChapterRecords().map(({book, chapter}) => `${book.name} ${chapter.number}: ${chapter.text}`).join('\n').slice(0, 2600);
    const prompt = [
      'Actúa como tutor bíblico católico, claro y paciente.',
      `Estoy estudiando ${getReadingReference()} dentro de una ruta completa de los 73 libros, de Génesis a Apocalipsis.`,
      `Objetivo de la sesión: ${currentLesson.objective}`,
      `Contexto preparado: ${currentLesson.context}`,
      `Referencias del Catecismo: ${currentLesson.catechism.join('; ')}.`,
      `Fragmento de la Biblia de Jerusalén para situar la consulta: ${excerpt}`,
      `Mi pregunta: ${question}`,
      'Responde en español y cumple estas reglas:',
      '1. Distingue claramente el texto bíblico, el contexto histórico-literario, el Catecismo y tu explicación.',
      '2. Cita referencias bíblicas y números del Catecismo; no inventes citas.',
      '3. Señala cuando una interpretación es probable, discutida o no está definida por la Iglesia.',
      '4. No sustituyas la orientación de un sacerdote o director espiritual.',
      '5. Termina con una pregunta breve de reflexión personal.'
    ].join('\n\n');
    const opened = window.open('https://chatgpt.com/', '_blank', 'noopener');
    try {
      await copyText(prompt);
      showToast('Consulta copiada. Pégala en ChatGPT para comenzar.');
    } catch (error) {
      showToast('No se pudo copiar automáticamente. Selecciona y copia la consulta.');
      $('#aiQuestion').value = prompt;
      $('#aiQuestion').select();
    }
    if (!opened) showToast('Consulta copiada. Permite ventanas emergentes y abre ChatGPT.');
    $('#aiDialog').close();
  }

  async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(value);
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('Copy failed');
  }

  async function toggleAudio() {
    if (speechLoading) {
      stopAudio();
      showToast('Preparación del audio cancelada.');
      return;
    }
    if (speechPlaying && !speechPaused) {
      try {
        if (audioMode === 'neural' && audioContext) await audioContext.suspend();
        else if ('speechSynthesis' in window) speechSynthesis.pause();
      } catch (error) {
        console.error(error);
      }
      speechPaused = true;
      setAudioUi('paused', 'Audio en pausa');
      return;
    }
    if (speechPlaying && speechPaused) {
      try {
        if (audioMode === 'neural' && audioContext) await audioContext.resume();
        else if ('speechSynthesis' in window) speechSynthesis.resume();
      } catch (error) {
        console.error(error);
      }
      speechPaused = false;
      setAudioUi('playing', audioMode === 'neural' ? ((appState.settings.audioProvider === 'gemini') ? 'Gemini · voz generada por IA' : 'OpenAI · voz generada por IA') : 'Voz del dispositivo');
      return;
    }
    await startAudio();
  }

  async function startAudio() {
    stopAudio();
    const selectedProvider = appState.settings.audioProvider || audioConfig.defaultProvider || 'gemini';
    const providerAvailable = selectedProvider === 'device' ? false : Boolean(audioConfig.providers && audioConfig.providers[selectedProvider]);
    if (selectedProvider === 'gemini' && !providerAvailable) {
      showToast(backendReady ? 'Gemini no está disponible. Pulsa “Comprobar voces Gemini” para revisar la clave y el modelo.' : 'No hay conexión con Apps Script. Comprueba la implementación /exec.');
    }
    const canUseNeuralAudio = providerAvailable && backendReady && Boolean(window.AudioContext || window.webkitAudioContext);
    audioMode = canUseNeuralAudio ? 'neural' : 'device';
    speechQueue = buildSpeechQueue(canUseNeuralAudio ? NEURAL_AUDIO_CHUNK_LIMIT : DEVICE_AUDIO_CHUNK_LIMIT);
    speechIndex = 0;
    speechPlaying = true;
    speechPaused = false;
    const sessionId = audioSessionId;

    if (canUseNeuralAudio) {
      try {
        await prepareAudioContext();
        if (sessionId !== audioSessionId) return;
        await playNextNeuralChunk(sessionId);
      } catch (error) {
        fallbackToDeviceVoice(error, sessionId);
      }
      return;
    }

    if (!('speechSynthesis' in window)) {
      stopAudio();
      showToast('Este navegador no ofrece lectura en voz alta.');
      return;
    }
    setAudioUi('playing', 'Introducción espiritual · voz del dispositivo');
    speakNextLocal(sessionId);
  }

  function buildSpeechQueue(limit) {
    const queue = [SPIRITUAL_AUDIO_INTRO];
    getDisplayedChapterRecords().forEach(({book, chapter}) => {
      const text = `${book.name}, capítulo ${chapter.number}. ${prepareSpeechText(chapter.text)}`.replace(/\s+/g, ' ').trim();
      queue.push(...splitForSpeech(text, limit));
    });
    return queue.filter(Boolean);
  }

  function prepareSpeechText(text) {
    return transformVerseMarkers(text, 'remove').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  }

  async function prepareAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Este navegador no admite audio neural.');
    audioContext = new AudioContextClass();
    if (audioContext.state === 'suspended') await audioContext.resume();
  }

  async function playNextNeuralChunk(sessionId) {
    if (sessionId !== audioSessionId || !speechPlaying) return;
    if (speechIndex >= speechQueue.length) {
      finishAudio(sessionId);
      return;
    }
    speechLoading = true;
    const isIntroduction = speechIndex === 0;
    setAudioUi('loading', isIntroduction ? 'Preparando introducción con IA…' : `Preparando audio ${speechIndex + 1} de ${speechQueue.length}…`);
    try {
      const result = await gasCall('generateSpeech', {
        text: speechQueue[speechIndex],
        rate: Number($('#speechRate').value) || 1,
        provider: appState.settings.audioProvider || audioConfig.defaultProvider || 'device',
        voice: appState.settings.audioVoice || 'female'
      });
      if (sessionId !== audioSessionId || !speechPlaying) return;
      if (!result || !result.audioBase64) throw new Error('El servicio no devolvió audio.');
      const decoded = await decodeAudioData(audioContext, base64ToArrayBuffer(result.audioBase64));
      if (sessionId !== audioSessionId || !speechPlaying) return;

      const source = audioContext.createBufferSource();
      source.buffer = decoded;
      source.connect(audioContext.destination);
      audioSource = source;
      source.onended = () => {
        if (sessionId !== audioSessionId || audioSource !== source) return;
        audioSource = null;
        speechIndex += 1;
        playNextNeuralChunk(sessionId);
      };
      speechLoading = false;
      setAudioUi('playing', isIntroduction ? `Introducción espiritual · ${result.provider === 'gemini' ? 'Gemini' : 'OpenAI'}` : `${result.provider === 'gemini' ? 'Gemini' : 'OpenAI'} · audio ${speechIndex + 1} de ${speechQueue.length}`);
      source.start(0);
    } catch (error) {
      if (sessionId !== audioSessionId) return;
      fallbackToDeviceVoice(error, sessionId);
    }
  }

  function decodeAudioData(context, arrayBuffer) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const accept = value => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const decline = error => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const result = context.decodeAudioData(arrayBuffer, accept, decline);
      if (result && typeof result.then === 'function') result.then(accept, decline);
    });
  }

  function base64ToArrayBuffer(value) {
    const binary = window.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }

  function fallbackToDeviceVoice(error, sessionId) {
    console.error(error);
    if (sessionId !== audioSessionId || !speechPlaying) return;
    speechLoading = false;
    if (audioSource) {
      audioSource.onended = null;
      try { audioSource.stop(); } catch (stopError) { console.error(stopError); }
      audioSource = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    if (!('speechSynthesis' in window)) {
      stopAudio();
      showToast('El servicio de voz IA no está disponible y este navegador no ofrece una voz de respaldo.');
      return;
    }
    const remainingText = speechQueue.slice(speechIndex).join(' ');
    speechQueue = splitForSpeech(remainingText, DEVICE_AUDIO_CHUNK_LIMIT);
    speechIndex = 0;
    audioMode = 'device';
    speechPaused = false;
    setAudioUi('playing', 'Voz del dispositivo · respaldo automático');
    const detail = error && error.message ? error.message : 'error desconocido';
    showToast((/SAFETY/i.test(detail) ? 'Gemini bloqueó este fragmento. ' : 'Gemini TTS falló. ') +
      detail + ' Continuamos con la voz del dispositivo.');
    speakNextLocal(sessionId);
  }

  function speakNextLocal(sessionId) {
    if (sessionId !== audioSessionId || !speechPlaying) return;
    if (speechIndex >= speechQueue.length) {
      finishAudio(sessionId);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(speechQueue[speechIndex]);
    utterance.lang = 'es-MX';
    utterance.rate = Number($('#speechRate').value) || 1;
    const voices = speechSynthesis.getVoices();
    utterance.voice = voices.find(voice => /^es(-|_)/i.test(voice.lang) && /MX/i.test(voice.lang)) || voices.find(voice => /^es(-|_)/i.test(voice.lang)) || null;
    utterance.onend = () => {
      if (sessionId !== audioSessionId) return;
      speechIndex += 1;
      speakNextLocal(sessionId);
    };
    utterance.onerror = event => {
      if (sessionId !== audioSessionId || event.error === 'canceled' || event.error === 'interrupted') return;
      if (event.error !== 'canceled' && event.error !== 'interrupted') showToast('La lectura en voz alta se interrumpió.');
      stopAudio();
    };
    setAudioUi('playing', speechIndex === 0 ? 'Introducción espiritual · voz del dispositivo' : `Voz del dispositivo · parte ${speechIndex + 1} de ${speechQueue.length}`);
    speechSynthesis.speak(utterance);
  }

  function stopAudio() {
    audioSessionId += 1;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (audioSource) {
      audioSource.onended = null;
      try { audioSource.stop(); } catch (error) { console.error(error); }
      audioSource = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    speechQueue = [];
    speechIndex = 0;
    speechPlaying = false;
    speechPaused = false;
    speechLoading = false;
    setAudioUi('idle', getAudioIdleLabel());
  }

  function finishAudio(sessionId) {
    if (sessionId !== audioSessionId) return;
    stopAudio();
    if ($('#audioStatus')) $('#audioStatus').textContent = 'Lectura finalizada';
  }

  function renderAudioAvailability() {
    const badge = $('#audioVoiceBadge');
    if (!badge) return;
    const provider = appState.settings.audioProvider || audioConfig.defaultProvider || 'device';
    const configured = provider !== 'device' && backendReady && Boolean(audioConfig.providers && audioConfig.providers[provider]);
    badge.textContent = configured ? (provider === 'gemini' ? `Gemini · ${appState.settings.audioVoice === 'male' ? 'Algieba' : 'Aoede'}` : 'OpenAI · voz IA') : (provider === 'gemini' && backendReady ? (audioConfig.geminiTested ? 'Gemini no disponible' : 'Gemini sin verificar') : (provider === 'gemini' ? 'Conexión pendiente' : 'Voz del dispositivo'));
    badge.classList.toggle('neural', configured);
    if (!speechPlaying && !speechLoading) setAudioUi('idle', getAudioIdleLabel());
  }

  function getAudioIdleLabel() {
    const provider = appState.settings.audioProvider || audioConfig.defaultProvider || 'device';
    const configured = provider !== 'device' && backendReady && Boolean(audioConfig.providers && audioConfig.providers[provider]);
    return configured ? `Introducción espiritual incluida · ${provider === 'gemini' ? 'Gemini' : 'OpenAI'}` : 'Introducción espiritual incluida · voz del dispositivo';
  }

  function setAudioUi(state, detail) {
    const button = $('#audioToggle');
    if (!button) return;
    const isPlaying = state === 'playing';
    const isPaused = state === 'paused';
    const isLoading = state === 'loading';
    button.textContent = isPlaying ? 'Ⅱ' : isLoading ? '…' : '▶';
    button.setAttribute('aria-label', isPlaying ? 'Pausar audio' : isPaused ? 'Continuar audio' : isLoading ? 'Cancelar preparación del audio' : 'Reproducir lectura');
    button.setAttribute('aria-pressed', String(isPlaying));
    if ($('#audioStatus') && detail) $('#audioStatus').textContent = detail;
  }

  function splitForSpeech(text, limit) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    const sentences = normalized.match(/[^.!?;:]+[.!?;:]?/g) || [normalized];
    const units = [];
    sentences.forEach(sentence => {
      const cleanSentence = sentence.trim();
      if (cleanSentence.length <= limit) {
        units.push(cleanSentence);
        return;
      }
      let fragment = '';
      cleanSentence.split(/\s+/).forEach(word => {
        const candidate = (fragment + ' ' + word).trim();
        if (candidate.length > limit && fragment) {
          units.push(fragment);
          fragment = word;
        } else fragment = candidate;
      });
      if (fragment) units.push(fragment);
    });
    const chunks = [];
    let current = '';
    units.forEach(unit => {
      const candidate = (current + ' ' + unit).trim();
      if (candidate.length > limit && current) {
        chunks.push(current);
        current = unit;
      } else current = candidate;
    });
    if (current) chunks.push(current);
    return chunks;
  }

  function updateSessionProgress() {
    const progress = Math.min(100, visitedTabs.size * 25);
    $('#sessionProgressBar').style.width = progress + '%';
    $('#sessionProgressText').textContent = progress + '% revisado';
  }

  function getNextLesson() {
    const lastId = appState.settings.lastLessonId;
    const firstPending = PLAN.lessons.find(lesson => !appState.progress[lesson.id] || appState.progress[lesson.id].status !== 'completed');
    if (firstPending) return firstPending;
    return PLAN.lessons.find(lesson => lesson.id === lastId) || PLAN.lessons[0];
  }

  function getCompletedLessons() {
    return PLAN.lessons.filter(lesson => appState.progress[lesson.id] && appState.progress[lesson.id].status === 'completed');
  }

  function getDueReviews() {
    const now = Date.now();
    return appState.reviews.filter(item => new Date(item.dueDate).getTime() <= now).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  }

  function calculateStreak() {
    const dates = [...new Set(Object.values(appState.progress).filter(item => item.status === 'completed' && item.completedAt).map(item => localDateKey(new Date(item.completedAt))))];
    if (!dates.length) return 0;
    const dateSet = new Set(dates);
    let cursor = new Date();
    if (!dateSet.has(localDateKey(cursor))) cursor = addDays(cursor, -1);
    let streak = 0;
    while (dateSet.has(localDateKey(cursor))) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return streak;
  }

  function findLesson(id) {
    return PLAN.lessons.find(item => item.id === id) || PLAN.lessons[0];
  }

  function findLessonByPassage(bookId, number) {
    return PLAN.lessons.find(lesson => lesson.readings.some(reading => reading.bookId === bookId && reading.chapters.includes(number)));
  }

  function findQuestion(id) {
    for (const lesson of PLAN.lessons) {
      const question = lesson.quiz.find(item => item.id === id);
      if (question) return {lesson, question};
    }
    return null;
  }

  function getVerseMarkerPositions(text) {
    const matches = [...text.matchAll(/(^|\s)(\d{1,3})([a-z]{0,2})(?=(?:\s|\.{3}))/g)];
    const candidates = matches.map(match => ({
      number: Number(match[2]),
      suffix: match[3] || '',
      start: match.index + match[1].length,
      end: match.index + match[1].length + match[2].length + (match[3] || '').length,
      token: match[2] + (match[3] || '')
    }));
    const marked = new Set();
    let last = 0;
    candidates.forEach((candidate, index) => {
      if (last === 0) {
        if (candidate.number !== 1 || candidate.start > 250) return;
      } else if (candidate.number <= last || candidate.number > last + 5) {
        return;
      }
      marked.add(index);
      last = candidate.number;
    });

    candidates.forEach((candidate, index) => {
      if (candidate.suffix) marked.add(index);
    });

    for (let index = 0; index < candidates.length - 1; index += 1) {
      const current = candidates[index];
      const next = candidates[index + 1];
      const increase = next.number - current.number;
      if (increase >= 0 && increase <= 5 && next.start - current.end < 1500 && (increase > 0 || current.suffix || next.suffix)) {
        marked.add(index);
        marked.add(index + 1);
      }
    }

    return candidates.filter((candidate, index) => marked.has(index));
  }

  function transformVerseMarkers(text, mode) {
    const positions = getVerseMarkerPositions(text);
    if (!positions.length) return mode === 'markup' ? escapeHtml(text) : text;
    let output = '';
    let cursor = 0;
    positions.forEach(position => {
      const segment = text.slice(cursor, position.start);
      output += mode === 'markup' ? escapeHtml(segment) : segment;
      if (mode === 'markup') output += `<sup class="verse-number">${escapeHtml(position.token)}</sup>`;
      cursor = position.end;
    });
    const tail = text.slice(cursor);
    output += mode === 'markup' ? escapeHtml(tail) : tail;
    return output;
  }

  function formatScripture(text) {
    return transformVerseMarkers(text, 'markup');
  }

  function estimateReadingTime(text) {
    const words = text.trim().split(/\s+/).length;
    return Math.max(1, Math.round(words / 185));
  }

  function makeSnippet(text, query) {
    const normalizedText = normalizeText(text);
    const normalizedQuery = normalizeText(query);
    const index = normalizedText.indexOf(normalizedQuery);
    const start = Math.max(0, index === -1 ? 0 : index - 75);
    const raw = text.slice(start, start + 210).trim();
    const safe = escapeHtml((start > 0 ? '…' : '') + raw + (start + 210 < text.length ? '…' : ''));
    if (!query || index === -1) return safe;
    return safe.replace(new RegExp(escapeRegExp(escapeHtml(query)), 'ig'), match => `<mark>${match}</mark>`);
  }

  function normalizeText(value) {
    return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function addDays(date, days) {
    const output = new Date(date);
    output.setDate(output.getDate() + days);
    return output;
  }

  function localDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function formatLongDate(date) {
    return new Intl.DateTimeFormat('es-MX', {weekday: 'long', day: 'numeric', month: 'long'}).format(date);
  }

  function formatShortDate(date) {
    return new Intl.DateTimeFormat('es-MX', {day: 'numeric', month: 'short'}).format(date);
  }

  function setSyncStatus(status, label) {
    const element = $('#syncStatus');
    if (!element) return;
    element.classList.remove('synced', 'error');
    if (status === 'synced') element.classList.add('synced');
    if (status === 'error') element.classList.add('error');
    $('.sync-label', element).textContent = label;
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3600);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]));
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  window.CaminoPalabraTest = {prepareSpeechText, getVerseMarkerPositions, splitForSpeech};
})();