/* Matching Game v3 — independent Firebase online mode; solo / AI logic stays in script.js. */
(() => {
  'use strict';
  const config = {
    apiKey: 'AIzaSyCeGKu71-oaSZlTGIueMsoz1JjszUlUc8U',
    authDomain: 'matching-game-online.firebaseapp.com',
    databaseURL: 'https://matching-game-online-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'matching-game-online',
    storageBucket: 'matching-game-online.firebasestorage.app',
    messagingSenderId: '235719532144',
    appId: '1:235719532144:web:9cb4831284acbbe32d1eb5'
  };
  const firebaseVersion = '13.4.0';
  const { themes, themeFromDeck, paintTheme } = window.matchingThemeKit;
  const pairCounts = { easy: 6, medium: 8, hard: 12 };
  const MATCH_RESOLVE_DELAY_MS = 1250;
  const $ = selector => document.querySelector(selector);
  const panel = $('#online-panel');
  const setup = $('#online-setup');
  const lobby = $('#online-lobby');
  const feedback = $('#online-feedback');
  const board = $('#board');
  const status = $('#status');
  const nameInput = $('#online-name');
  const codeInput = $('#online-code-input');
  const createBtn = $('#online-create');
  const joinBtn = $('#online-join');
  const startBtn = $('#online-start');
  const rematchBtn = $('#online-rematch');
  const levelButtons = [...document.querySelectorAll('[data-level]')];

  let sdkPromise = null;
  let auth, database, uid = '';
  let onlineActive = false;
  let busy = false;
  let code = '';
  let myRole = '';
  let roomRef = null;
  let roomHandler = null;
  let presenceRef = null;
  let connectedHandler = null;
  let latestRoom = null;
  let boardSignature = '';
  let resolvedTimer = null;
  let clockInterval = null;
  let actionInFlight = false;
  let serial = 0;

  const savedName = (() => { try { return localStorage.getItem('matching-online-name') || ''; } catch { return ''; } })();
  nameInput.value = savedName;

  function writeFeedback(message, error = false) {
    feedback.textContent = message;
    feedback.classList.toggle('error', error);
  }
  function setBusy(value) {
    busy = value;
    createBtn.disabled = value;
    joinBtn.disabled = value;
    startBtn.disabled = value;
    rematchBtn.disabled = value;
  }
  function displayName() {
    const name = nameInput.value.trim().replace(/[<>]/g, '').slice(0, 24);
    if (!name) throw Error('اكتب اسم اللاعب أولًا حتى يظهر لصديقك.');
    try { localStorage.setItem('matching-online-name', name); } catch { /* storage can be unavailable */ }
    return name;
  }
  function selectedLevel() {
    return document.querySelector('[data-level].active')?.dataset.level || 'easy';
  }
  function shuffle(values) {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  }
  function newDeck(level, avoidTheme = -1) {
    // Shuffle pair identities too (easy/medium won't always show the same cards).
    // Select a *different* theme than the previous match while retaining
    // the exact legacy deck format: numeric IDs in the range 0..11.
    for (let tries = 0; tries < 80; tries++) {
      const chosen = shuffle(Array.from({ length: 12 }, (_, i) => i)).slice(0, pairCounts[level]);
      const candidate = shuffle(chosen.flatMap(i => [i, i]));
      if (themeFromDeck(candidate) !== avoidTheme) return candidate;
    }
    // Astronomically unlikely fallback. Keep shuffling until a change occurs.
    let candidate;
    do {
      const chosen = shuffle(Array.from({ length: 12 }, (_, i) => i)).slice(0, pairCounts[level]);
      candidate = shuffle(chosen.flatMap(i => [i, i]));
    } while (themeFromDeck(candidate) === avoidTheme);
    return candidate;
  }
  function newGameData(level, avoidTheme = -1) {
    return {
      phase: 'waiting', turn: 'host', deck: newDeck(level, avoidTheme),
      moves: 0, scores: { host: 0, guest: 0 },
      opened: [], matched: {}, resolveAt: 0, lastMatch: false,
      startedAt: 0, winner: ''
    };
  }
  function roomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const nums = new Uint32Array(6);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(nums);
    else for (let i = 0; i < 6; i++) nums[i] = Math.floor(Math.random() * 4294967295);
    return Array.from(nums, n => alphabet[n % alphabet.length]).join('');
  }
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = url;
      el.onload = resolve;
      el.onerror = () => reject(Error('تعذر تحميل Firebase. تأكد من اتصال الإنترنت وجربي مرة ثانية.'));
      document.head.append(el);
    });
  }
  async function ensureFirebase() {
    if (!sdkPromise) {
      sdkPromise = (async () => {
        // Load Firebase only if online mode is used. The solo game needs no internet SDK.
        for (const part of ['app', 'auth', 'database']) {
          await loadScript(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-${part}-compat.js`);
        }
        if (!window.firebase) throw Error('تعذر تشغيل Firebase.');
        if (!firebase.apps.length) firebase.initializeApp(config);
        auth = firebase.auth();
        database = firebase.database();
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        if (!auth.currentUser) await auth.signInAnonymously();
        uid = auth.currentUser?.uid || '';
        if (!uid) throw Error('تعذر تسجيل الدخول كضيف. تأكدي من تفعيل Anonymous في Firebase.');
      })().catch(err => { sdkPromise = null; throw err; });
    }
    await sdkPromise;
    if (!auth.currentUser) {
      await auth.signInAnonymously();
      uid = auth.currentUser.uid;
    }
  }
  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  function secondsElapsed(game) {
    if (!game.startedAt) return 0;
    // resolveAt is already saved for the last card flip. On a finished match,
    // use that fixed timestamp rather than Date.now(), so both devices stop
    // at the same elapsed time without requiring new Firebase security rules.
    const endTime = game.phase === 'finished' && game.resolveAt > 0
      ? game.resolveAt - MATCH_RESOLVE_DELAY_MS
      : Date.now();
    return Math.max(0, (endTime - game.startedAt) / 1000);
  }
  function playSound(kind) {
    if (typeof window.matchingPlaySound === 'function') window.matchingPlaySound(kind);
  }
  function showOnlineUI(on) {
    panel.hidden = !on;
    $('#local-actions').hidden = on;
    $('#online-sound-actions').hidden = !on;
    $('#game-note').textContent = on
      ? 'في اللعب أونلاين تتناوب الأدوار بعد عدم التطابق. من يطابق بطاقتين يكسبهما ويكمل دوره. كل لاعب يستخدم جهازًا مختلفًا.'
      : 'في اللعب الفردي الوقت محدود حسب المستوى. في وضع الكمبيوتر تتناوب الأدوار بعد عدم التطابق، والفائز من يطابق أكبر عدد من البطاقات. لا توجد موسيقى خلفية.';
    $('#best').hidden = on;
    if (on) {
      $('.stat span').textContent = 'الوقت المنقضي';
      $('#time').textContent = '00:00';
      $('#moves').textContent = '0';
      $('#pairs').textContent = `0/${pairCounts[selectedLevel()] * 2}`;
      status.textContent = '🌐 أنشئ غرفة أو أدخل رمز غرفة صديقك';
      $('#scoreboard').hidden = true;
    }
  }
  function setRoomUI(inRoom) {
    setup.hidden = inRoom;
    lobby.hidden = !inRoom;
    levelButtons.forEach(b => { b.disabled = inRoom; });
    if (!inRoom) {
      $('#deck-theme').textContent = '🌐 مجموعة البطاقات تظهر عند بدء المباراة';
      board.classList.remove('theme-text');
      $('#scoreboard').hidden = true;
      board.replaceChildren();
      boardSignature = '';
    }
  }
  function reflectLevel(level) {
    levelButtons.forEach(button => button.classList.toggle('active', button.dataset.level === level));
  }
  function refreshClock() {
    if (!onlineActive || !latestRoom) return;
    $('#time').textContent = fmt(secondsElapsed(latestRoom.game));
  }
  function showCardGrid(game, opponentConnected = true) {
    const theme = themes[themeFromDeck(game.deck)];
    paintTheme(theme);
    const signature = game.deck.join(',') + '|' + theme.name;
    if (boardSignature !== signature || board.children.length !== game.deck.length) {
      board.replaceChildren();
      board.style.gridTemplateColumns = 'repeat(4,minmax(0,1fr))';
      game.deck.forEach((id, index) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'card';
        card.setAttribute('aria-label', `بطاقة ${index + 1}`);
        card.innerHTML = '<span class="inner"><span class="face back">✦</span><span class="face front"></span></span>';
        card.querySelector('.front').textContent = theme.items[id] || '❓';
        card.addEventListener('click', () => pickCard(index));
        board.appendChild(card);
      });
      boardSignature = signature;
    }
    const opened = game.opened || [];
    const matched = game.matched || {};
    const yourTurn = game.turn === myRole;
    const playable = game.phase === 'playing' && yourTurn && opponentConnected && opened.length < 2 && !actionInFlight;
    Array.from(board.children).forEach((card, index) => {
      const isMatched = Boolean(matched[index]);
      const isOpen = opened.includes(index);
      card.classList.toggle('flipped', isOpen);
      card.classList.toggle('matched', isMatched);
      card.disabled = !playable || isMatched || isOpen;
      card.classList.toggle('online-locked', card.disabled);
    });
  }
  function countMatched(game) {
    return Object.keys(game.matched || {}).filter(k => game.matched[k]).length;
  }
  function renderRoom(room) {
    const g = room.game;
    const other = myRole === 'host' ? 'guest' : 'host';
    const myName = room[myRole]?.name || 'أنت';
    const theirName = room[other]?.name || 'بانتظار اللاعب';
    const otherConnected = Boolean(room.presence?.[room[other]?.uid]);
    const meConnected = Boolean(room.presence?.[uid]);
    $('#online-code').textContent = code;
    $('#online-players').textContent = `👤 ${room.host.name}  ×  👤 ${room.guest?.name || 'بانتظار لاعب ثانٍ...'}`;
    $('#online-lobby-title').textContent = g.phase === 'finished' ? '🏆 انتهت المباراة' : '🎮 غرفة اللعب';
    $('#online-lobby-info').textContent = g.phase === 'waiting'
      ? room.guest ? (otherConnected && meConnected ? 'اللاعبان موجودان. صاحب الغرفة يبدأ المباراة.' : 'بانتظار اتصال اللاعب الثاني…') : 'شارك رمز الغرفة مع صديقك للانضمام.'
      : g.phase === 'finished' ? 'يمكن لصاحب الغرفة بدء مباراة أخرى بالمستوى نفسه.'
        : otherConnected ? 'اللعب متصل — البطاقات والأدوار تتحدث على الجهازين.' : 'الخصم غير متصل حاليًا؛ يمكنه الرجوع إلى نفس الغرفة.';
    startBtn.hidden = !(myRole === 'host' && g.phase === 'waiting' && room.guest && otherConnected && meConnected);
    rematchBtn.hidden = !(myRole === 'host' && g.phase === 'finished');
    $('#scoreboard').hidden = g.phase === 'waiting';
    $('#human-label').textContent = `👤 ${myName} (أنت)`;
    $('#ai-label').textContent = `👤 ${theirName}`;
    $('#human-score').textContent = (g.scores?.[myRole] || 0) * 2;
    $('#ai-score').textContent = (g.scores?.[other] || 0) * 2;
    $('#turn').textContent = g.phase === 'finished'
      ? '🏁 المباراة انتهت'
      : `الدور: ${g.turn === myRole ? 'أنت 👤' : theirName + ' 👤'}`;
    $('#moves').textContent = g.moves || 0;
    $('#pairs').textContent = `${countMatched(g)}/${g.deck.length}`;
    // Stop the interval entirely in the lobby and when the match is finished.
    // Start a fresh interval for a new match or a rematch.
    if (g.phase === 'playing') {
      if (clockInterval === null) clockInterval = setInterval(refreshClock, 1000);
    } else {
      clearInterval(clockInterval);
      clockInterval = null;
    }
    refreshClock();
    if (g.phase === 'waiting') {
      $('#deck-theme').textContent = '🌐 مجموعة البطاقات تظهر عند بدء المباراة';
      board.classList.remove('theme-text');
      board.replaceChildren();
      boardSignature = '';
      status.textContent = room.guest ? '👥 اللاعبان جاهزان! بانتظار بدء المباراة.' : '🔑 شاركي رمز الغرفة مع صديقك.';
      return;
    }
    showCardGrid(g, otherConnected);
    if (g.phase === 'finished') {
      const result = g.winner === 'tie' ? '🤝 تعادل!' : g.winner === myRole ? '🏆 فزت في المباراة!' : '🎮 فاز الخصم!';
      status.textContent = `${result} البطاقات: ${myName} ${(g.scores?.[myRole] || 0) * 2} — ${theirName} ${(g.scores?.[other] || 0) * 2}`;
      return;
    }
    if (!otherConnected) status.textContent = '📡 اتصال الخصم منقطع. انتظر رجوعه إلى الغرفة.';
    else if ((g.opened || []).length === 2) status.textContent = g.lastMatch ? '✨ تطابق! اللاعب نفسه يكمل الدور.' : 'لا يوجد تطابق؛ يتغير الدور بعد لحظة.';
    else status.textContent = g.turn === myRole ? '✨ دورك! اختر بطاقتين.' : `⏳ دور ${theirName} الآن.`;
    scheduleResolution(g);
  }
  function scheduleResolution(game) {
    clearTimeout(resolvedTimer);
    if (game.phase !== 'playing' || (game.opened || []).length !== 2) return;
    resolvedTimer = setTimeout(() => resolveOpened(), Math.max(60, (game.resolveAt || Date.now()) - Date.now() + 65));
  }
  async function resolveOpened() {
    if (!onlineActive || !roomRef || !latestRoom || actionInFlight) return;
    const current = latestRoom.game;
    if (current.phase !== 'playing' || (current.opened || []).length !== 2) return;
    if (Date.now() < (current.resolveAt || 0)) {
      scheduleResolution(current);
      return;
    }
    try {
      await roomRef.child('game').transaction(game => {
        if (!game || game.phase !== 'playing' || (game.opened || []).length !== 2) return;
        if (Date.now() < game.resolveAt) return;
        game.opened = [];
        if (!game.lastMatch) game.turn = game.turn === 'host' ? 'guest' : 'host';
        game.resolveAt = 0;
        return game;
      }, undefined, false);
    } catch (err) {
      writeFeedback('تعذر تحديث الدور: ' + friendlyError(err), true);
    }
  }
  function maybePlaySounds(previous, next) {
    if (!previous || !next || previous.game.phase === 'waiting') return;
    const before = previous.game, after = next.game;
    const a = (before.opened || []).length, b = (after.opened || []).length;
    if (b > a) playSound('flip');
    if (countMatched(after) > countMatched(before)) playSound('match');
    else if (b === 2 && a < 2 && !after.lastMatch) playSound('miss');
    if (after.phase === 'finished' && before.phase !== 'finished') playSound(after.winner === myRole ? 'win' : 'lose');
  }
  function friendlyError(err) {
    if (!navigator.onLine) return 'الاتصال بالإنترنت غير متوفر.';
    if (err?.code === 'PERMISSION_DENIED' || err?.code === 'database/permission-denied')
      return 'صلاحيات قاعدة البيانات تمنع العملية. تأكد من نشر قواعد firebase-rules.json.';
    if (err?.code === 'auth/operation-not-allowed') return 'فعّلي Anonymous في Authentication.';
    if (err?.code === 'auth/network-request-failed') return 'تأكد من الإنترنت ثم حاول مرة ثانية.';
    return err?.message || 'حدث خطأ غير متوقع.';
  }
  function detachRoom() {
    clearTimeout(resolvedTimer);
    resolvedTimer = null;
    clearInterval(clockInterval);
    clockInterval = null;
    if (roomRef && roomHandler) roomRef.off('value', roomHandler);
    if (database && connectedHandler) database.ref('.info/connected').off('value', connectedHandler);
    connectedHandler = null;
    roomHandler = null;
    const oldPresence = presenceRef;
    presenceRef = null;
    roomRef = null;
    latestRoom = null;
    boardSignature = '';
    return oldPresence;
  }
  async function leaveRoom(silent = false) {
    serial++;
    const oldRoom = roomRef;
    const oldRoomData = latestRoom;
    const oldRole = myRole;
    const oldPresence = detachRoom();
    code = '';
    myRole = '';
    setRoomUI(false);
    if (onlineActive) {
      status.textContent = '🌐 أنشئ غرفة أو أدخل رمز غرفة صديقك';
      $('#pairs').textContent = `0/${pairCounts[selectedLevel()] * 2}`;
      $('#moves').textContent = '0';
      $('#time').textContent = '00:00';
    }
    if (!silent) writeFeedback('غادرت الغرفة.');
    // Cancel the server-side disconnect operation before removing presence.
    try {
      if (oldPresence) { await oldPresence.onDisconnect().cancel(); await oldPresence.remove(); }
      if (oldRoom && oldRole === 'host') await oldRoom.remove();
      else if (oldRoom && oldRole === 'guest' && oldRoomData?.game?.phase === 'waiting') await oldRoom.child('guest').remove();
    } catch (err) {
      if (!silent && onlineActive) writeFeedback('خرجت من الغرفة، لكن قد تبقى بياناتها مؤقتًا: ' + friendlyError(err), true);
    }
  }
  async function watchRoom(roomCodeText, role) {
    // Cleanup existing state before attaching a different room.
    if (roomRef) await leaveRoom(true);
    code = roomCodeText;
    myRole = role;
    const ticket = ++serial;
    roomRef = database.ref(`rooms/${code}`);
    setRoomUI(true);
    writeFeedback('تم الاتصال بالغرفة ✅');
    roomHandler = snap => {
      if (!onlineActive || !roomRef || ticket !== serial) return;
      const room = snap.val();
      if (!room) {
        detachRoom();
        code = '';
        myRole = '';
        setRoomUI(false);
        writeFeedback('أغلق صاحب الغرفة هذه الغرفة.', true);
        status.textContent = 'الغرفة أُغلقت. يمكنك إنشاء غرفة جديدة.';
        return;
      }
      if (room[myRole]?.uid !== uid) {
        writeFeedback('لم يعد حساب الضيف مرتبطًا بهذه الغرفة.', true);
        return;
      }
      maybePlaySounds(latestRoom, room);
      latestRoom = room;
      renderRoom(room);
    };
    roomRef.on('value', roomHandler, err => writeFeedback(friendlyError(err), true));
    presenceRef = roomRef.child(`presence/${uid}`);
    connectedHandler = async snap => {
      if (!snap.val() || !roomRef || ticket !== serial) return;
      try {
        await presenceRef.onDisconnect().remove();
        if (ticket === serial) await presenceRef.set(true);
      } catch (err) {
        if (ticket === serial) writeFeedback('تعذر تحديث حالة الاتصال: ' + friendlyError(err), true);
      }
    };
    database.ref('.info/connected').on('value', connectedHandler);
  }
  async function createRoom() {
    if (!onlineActive || busy || roomRef) return;
    try {
      const name = displayName();
      setBusy(true);
      writeFeedback('جاري تسجيل الدخول وإنشاء الغرفة...');
      await ensureFirebase();
      const level = selectedLevel();
      for (let attempt = 0; attempt < 8; attempt++) {
        const newCode = roomCode();
        const ref = database.ref(`rooms/${newCode}`);
        const result = await ref.transaction(existing => existing ? undefined : {
          host: { uid, name }, level, createdAt: Date.now(), game: newGameData(level)
        }, undefined, false);
        if (result.committed) {
          await watchRoom(newCode, 'host');
          playSound('start');
          return;
        }
      }
      throw Error('تعذر إنشاء رمز فريد للغرفة. حاول مرة ثانية.');
    } catch (err) {
      writeFeedback(friendlyError(err), true);
    } finally { setBusy(false); }
  }
  async function joinRoom() {
    if (!onlineActive || busy || roomRef) return;
    try {
      const name = displayName();
      const typedCode = codeInput.value.trim().toUpperCase().replace(/\s/g, '');
      if (!/^[A-HJ-NP-Z2-9]{6}$/.test(typedCode)) throw Error('رمز الغرفة يتكون من 6 أحرف أو أرقام.');
      setBusy(true);
      writeFeedback('جاري دخول الغرفة...');
      await ensureFirebase();
      const ref = database.ref(`rooms/${typedCode}`);
      const snap = await ref.once('value');
      const room = snap.val();
      if (!room) throw Error('رمز الغرفة غير موجود. تأكد منه.');
      if (room.host?.uid === uid) { await watchRoom(typedCode, 'host'); return; }
      if (room.guest?.uid === uid) { await watchRoom(typedCode, 'guest'); return; }
      if (room.game?.phase !== 'waiting') throw Error('هذه الغرفة بدأت اللعب أو انتهت.');
      if (room.guest) throw Error('هذه الغرفة فيها لاعبان بالفعل.');
      const result = await ref.child('guest').transaction(value => value ? undefined : { uid, name }, undefined, false);
      if (!result.committed) throw Error('انضم لاعب آخر قبلك. جرّب غرفة ثانية.');
      await watchRoom(typedCode, 'guest');
      playSound('start');
    } catch (err) { writeFeedback(friendlyError(err), true); }
    finally { setBusy(false); }
  }
  async function startMatch(rematch = false) {
    if (!roomRef || !latestRoom || myRole !== 'host' || busy) return;
    try {
      setBusy(true);
      writeFeedback('جاري تجهيز البطاقات...');
      const level = latestRoom.level;
      // Prepare one stable deck before the Firebase transaction may retry.
      // On a rematch, never repeat the immediately preceding card theme.
      const previousTheme = rematch ? themeFromDeck(latestRoom.game.deck) : -1;
      const nextRound = newGameData(level, previousTheme);
      nextRound.phase = 'playing';
      nextRound.startedAt = Date.now();
      const result = await roomRef.child('game').transaction(g => {
        if (!g || (rematch ? g.phase !== 'finished' : g.phase !== 'waiting')) return;
        if (!latestRoom?.guest || !latestRoom.presence?.[latestRoom.guest.uid]) return;
        return nextRound;
      }, undefined, false);
      if (!result.committed) throw Error('لم تبدأ الجولة؛ تأكد أن اللاعب الثاني متصل.');
      writeFeedback('بدأت المباراة! 🎮');
      playSound('start');
    } catch (err) { writeFeedback(friendlyError(err), true); }
    finally { setBusy(false); }
  }
  async function pickCard(index) {
    if (!onlineActive || !roomRef || !latestRoom || actionInFlight) return;
    const g = latestRoom.game;
    if (g.phase !== 'playing' || g.turn !== myRole || (g.opened || []).length >= 2) return;
    actionInFlight = true;
    try {
      await roomRef.child('game').transaction(game => {
        if (!game || game.phase !== 'playing' || game.turn !== myRole) return;
        const opened = game.opened || [];
        if (opened.length >= 2 || opened.includes(index) || game.matched?.[index]) return;
        if (index < 0 || index >= game.deck.length) return;
        opened.push(index);
        game.opened = opened;
        if (opened.length === 2) {
          const [a, b] = opened;
          game.moves = (game.moves || 0) + 1;
          game.lastMatch = game.deck[a] === game.deck[b];
          game.resolveAt = Date.now() + MATCH_RESOLVE_DELAY_MS;
          if (game.lastMatch) {
            game.matched = game.matched || {};
            game.matched[a] = true;
            game.matched[b] = true;
            game.scores[myRole] = (game.scores[myRole] || 0) + 1;
            if (Object.keys(game.matched).length === game.deck.length) {
              game.phase = 'finished';
              const h = game.scores.host, v = game.scores.guest;
              game.winner = h === v ? 'tie' : h > v ? 'host' : 'guest';
            }
          }
        }
        return game;
      }, undefined, false);
    } catch (err) { writeFeedback('تعذر قلب البطاقة: ' + friendlyError(err), true); }
    finally { actionInFlight = false; if (onlineActive && latestRoom?.game) { showCardGrid(latestRoom.game, Boolean(latestRoom.presence?.[latestRoom[myRole === 'host' ? 'guest' : 'host']?.uid])); scheduleResolution(latestRoom.game); } }
  }

  window.addEventListener('matching:mode', event => {
    onlineActive = event.detail.mode === 'online';
    showOnlineUI(onlineActive);
    if (!onlineActive && roomRef) void leaveRoom(true);
    if (!onlineActive) writeFeedback('');
  });
  window.addEventListener('matching:level', () => {
    if (!roomRef) $('#pairs').textContent = `0/${pairCounts[selectedLevel()] * 2}`;
  });
  createBtn.addEventListener('click', createRoom);
  joinBtn.addEventListener('click', joinRoom);
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 6); });
  codeInput.addEventListener('keydown', event => { if (event.key === 'Enter') joinRoom(); });
  startBtn.addEventListener('click', () => startMatch(false));
  rematchBtn.addEventListener('click', () => startMatch(true));
  $('#online-leave').addEventListener('click', () => leaveRoom(false));
  $('#online-copy').addEventListener('click', async () => {
    if (!code) return;
    try { await navigator.clipboard.writeText(code); writeFeedback('تم نسخ رمز الغرفة ✅'); }
    catch { writeFeedback(`رمز الغرفة: ${code} — انسخيه وأرسليه لصديقك.`); }
  });
  $('#online-sound').addEventListener('click', () => {
    $('#sound').click();
    $('#online-sound').textContent = $('#sound').textContent;
    $('#online-sound').setAttribute('aria-pressed', $('#sound').getAttribute('aria-pressed'));
  });
  // Preserve an online room if the page is merely hidden on mobile. onDisconnect handles actual loss of connection.
})();
