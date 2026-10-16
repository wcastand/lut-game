'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const movies = window.MOVIES;
  const daily = window.LUT_DAILY;
  const publicBase = window.LUT_SITE.baseUrl;
  const hints = [
    {after:3,name:'Genre'},
    {after:5,name:'Year'},
    {after:8,name:'Story'},
    {after:13,name:'Title shape'},
    {after:21,name:'First letter'},
  ];
  const canvas = $('scene');
  const ctx = canvas.getContext('2d');
  const dialog = $('help-dialog');
  const location = window.location;
  const isDev = location && (location.protocol === 'file:'
    || ['localhost','127.0.0.1','[::1]'].includes(location.hostname)
    || new URL(location.href || location.origin+location.pathname+(location.search || '')).searchParams.get('dev') === '1');
  $('dev-reset').hidden = !isDev;
  let resetVersion = 0;
  let dayKey;
  let movie;
  let state;
  let midnightTimer;
  let shareAsset = null;
  let shareKey = '';
  let shareVersion = 0;
  const currentUrl = new URL(location.href || location.origin+location.pathname+(location.search || ''));
  const linkedId = currentUrl.pathname.match(/\/play\/([a-f0-9]{16})(?:\/index\.html|\/)?$/)?.[1];
  const linkedMovie = linkedId ? movies.find(item => daily.shareId(item) === linkedId) : null;
  const requestedDay = currentUrl.searchParams.get('day');
  const pinnedDay = linkedMovie ? (
    daily.validDay(requestedDay) && daily.movieForDay(movies,requestedDay).id === linkedMovie.id
      ? requestedDay : daily.recentDayForMovie(movies,linkedMovie,daily.dayKey(new Date()))
  ) : null;

  function winnerPalette() {
    return [0.18,0.52,0.82].map(position => {
      const color = movie.colors[Math.floor(position*movie.colors.length)];
      return [0,1,2].map(channel => parseInt(color.slice(1+channel*2,3+channel*2),16));
    });
  }

  function gameUrl() {
    const link = new URL(`play/${daily.shareId(movie)}/`,publicBase);
    link.searchParams.set('day',dayKey);
    return link.href;
  }

  function resultText() {
    return `lut game · ${dayKey}\nFound the movie in ${state.attempts} ${state.attempts === 1 ? 'guess' : 'guesses'}.\n${hintLabel()}.\n${challengeText()}`;
  }

  function hintLabel() {
    return state.hintsUsed ? `${state.hintsUsed} ${state.hintsUsed === 1 ? 'hint' : 'hints'} used` : 'No hints used';
  }

  function winTitle() {
    if (!state.hintsUsed && state.attempts === 1) return 'One-take wonder.';
    if (!state.hintsUsed && state.attempts <= 3) return 'Sharp eye.';
    return 'That’s a wrap.';
  }

  function challengeText() {
    return state.attempts === 1 ? 'Can you get it in one guess too?' : 'Can you get it in fewer guesses?';
  }

  function clearShareAsset() {
    shareVersion++;
    if (shareAsset && shareAsset.url) URL.revokeObjectURL(shareAsset.url);
    shareAsset = null;
    shareKey = '';
    $('share-instagram').disabled = true;
    $('download-card').hidden = true;
    $('download-card').removeAttribute('href');
    $('share-status').textContent = '';
    $('share-link').hidden = true;
  }

  function prepareShareCard() {
    const key = `${dayKey}:${state.attempts}:${state.hintsUsed}`;
    const tweet = new URL('https://twitter.com/intent/tweet');
    tweet.searchParams.set('text',resultText());
    if (gameUrl()) tweet.searchParams.set('url',gameUrl());
    $('share-twitter').href = tweet.toString();
    if (shareKey === key) return;
    clearShareAsset();
    shareKey = key;
    const version = shareVersion;
    const filename = `lut-game-${dayKey}.png`;
    const card = document.createElement('canvas');
    card.width = 1080;
    card.height = 1920;
    const art = card.getContext('2d');
    art.fillStyle = '#0d1016';
    art.fillRect(0,0,1080,1920);
    winnerPalette().forEach((color,i) => {
      const [x,y,radius] = [[100,350,1100],[1050,1350,1100],[980,320,900]][i];
      const glow = art.createRadialGradient(x,y,0,x,y,radius);
      glow.addColorStop(0,`rgba(${color.join(',')},0.55)`);
      glow.addColorStop(1,`rgba(${color.join(',')},0)`);
      art.fillStyle = glow;
      art.fillRect(0,0,1080,1920);
    });
    art.textAlign = 'center';
    art.fillStyle = '#f7f5ee';
    art.font = '600 44px Arial, sans-serif';
    art.fillText('lut game',540,180);
    art.fillStyle = '#b8bac1';
    art.font = '30px Arial, sans-serif';
    art.fillText(dayKey,540,240);
    art.font = '24px Arial, sans-serif';
    art.fillText('DAILY MOVIE · SOLVED',540,365);
    art.fillStyle = '#f7f5ee';
    art.font = '600 76px Arial, sans-serif';
    art.fillText(winTitle(),540,465,920);
    let size = 340;
    do {
      art.font = `600 ${size}px Arial, sans-serif`;
      size -= 8;
    } while (art.measureText(String(state.attempts)).width > 900 && size > 32);
    art.fillText(String(state.attempts),540,920);
    art.font = '48px Arial, sans-serif';
    art.fillText(state.attempts === 1 ? 'guess' : 'guesses',540,1005);
    art.fillStyle = '#d9d9d6';
    art.font = '600 27px Arial, sans-serif';
    art.fillText(hintLabel(),540,1090);
    movie.colors.forEach((color,i) => {
      const start = Math.floor(i*840/movie.colors.length);
      const end = Math.floor((i+1)*840/movie.colors.length);
      art.fillStyle = color;
      art.fillRect(120+start,1180,end-start,170);
    });
    art.fillStyle = '#b8bac1';
    art.font = '22px Arial, sans-serif';
    art.fillText('Frame data by Robson · GPLv3',540,1400);
    art.font = '18px Arial, sans-serif';
    art.fillText('github.com/Robson/Film-Barcodes-Visualisation',540,1435);
    art.fillStyle = '#f7f5ee';
    art.font = '600 46px Arial, sans-serif';
    art.fillText('Can you get it in',540,1570);
    art.fillText(state.attempts === 1 ? 'one guess too?' : 'fewer guesses?',540,1630);
    const site = gameUrl();
    if (site) {
      art.fillStyle = '#b8bac1';
      art.font = '22px Arial, sans-serif';
      art.fillText(site,540,1740,900);
    }
    // Prepare before the click, so native sharing keeps the user's activation.
    try {
      card.toBlob(blob => {
        if (version !== shareVersion || shareKey !== key || state.status !== 'solved') return;
        if (!blob) {
          $('share-status').textContent = 'Couldn’t prepare the image. You can still share on Twitter.';
          return;
        }
        const file = typeof File === 'function' ? new File([blob],filename,{type:'image/png'}) : null;
        const url = URL.createObjectURL(blob);
        shareAsset = {file,url,filename};
        $('download-card').href = url;
        $('download-card').download = filename;
        $('share-instagram').disabled = false;
      },'image/png');
    } catch {
      $('share-status').textContent = 'Couldn’t prepare the image. You can still share on Twitter.';
    }
  }

  function localDay(date) {
    return {key:daily.dayKey(date)};
  }

  function freshState() {
    return {movieId:movie.id, attempts:0, status:'playing', hintsUsed:0, lastGuess:''};
  }

  function readState() {
    try {
      const saved = JSON.parse(localStorage.getItem(`lut-game:${dayKey}`));
      if (!saved) return null;
      // Older results recorded only whether the final story clue was used.
      const hintsUsed = saved.hintsUsed ?? (typeof saved.hinted === 'boolean' ? (saved.hinted ? 3 : 0) : undefined);
      if (saved.movieId !== movie.id || !['playing','solved','revealed'].includes(saved.status)
          || !Number.isSafeInteger(saved.attempts) || saved.attempts < 0
          || !Number.isInteger(hintsUsed) || hintsUsed < 0 || hintsUsed > hints.length
          || typeof saved.lastGuess !== 'string') return null;
      return {movieId:movie.id,attempts:saved.attempts,status:saved.status,hintsUsed,lastGuess:saved.lastGuess.slice(0,160)};
    } catch { return null; }
  }

  function saveState() {
    try { localStorage.setItem(`lut-game:${dayKey}`, JSON.stringify(state)); } catch {}
  }

  function mergeState(saved) {
    if (!saved) return;
    const rank = {playing:0,revealed:1,solved:2};
    state = {
      ...state,
      lastGuess:saved.attempts > state.attempts ? saved.lastGuess : state.lastGuess,
      attempts:Math.max(saved.attempts,state.attempts),
      hintsUsed:Math.max(saved.hintsUsed,state.hintsUsed),
      status:rank[saved.status] > rank[state.status] ? saved.status : state.status,
    };
  }

  function updateState(update) {
    const requestedDay = dayKey;
    const requestedVersion = resetVersion;
    let didRun = false;
    const run = () => {
      didRun = true;
      if (ensureDay() || dayKey !== requestedDay || requestedVersion !== resetVersion) return;
      mergeState(readState());
      if (state.status !== 'playing') { render(); return; }
      update();
    };
    // Serialize read/modify/write across tabs when the browser supports Web Locks.
    // Rereading and merging still protects terminal progress in other browsers.
    if (typeof navigator !== 'undefined' && navigator.locks) {
      navigator.locks.request(`lut-game:${requestedDay}`,run).catch(() => { if (!didRun) run(); });
    } else {
      run();
    }
  }

  function normalize(title) {
    return title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[’']/g,'').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim()
      .replace(/^(?:the|a|an)\s+/, '').replace(/\s/g,'');
  }

  function matchesTitle(guess) {
    const withoutYear = guess.replace(new RegExp(`\\s*\\(?${movie.year}\\)?\\s*$`), '');
    const candidates = [movie.title, ...movie.aliases].map(normalize);
    return candidates.includes(normalize(guess)) || candidates.includes(normalize(withoutYear));
  }

  function maskedTitle(revealFirst) {
    const characters = Array.from(movie.title);
    let first = characters.findIndex(char => /\p{L}/u.test(char));
    if (first < 0) first = characters.findIndex(char => /\p{N}/u.test(char));
    let offset = 0;
    return movie.title.split(/(\s+)/).map(word => {
      if (/^\s+$/.test(word)) { offset += Array.from(word).length; return '   '; }
      return Array.from(word).map(char => {
        const show = revealFirst && offset === first;
        offset++;
        return /[\p{L}\p{N}]/u.test(char) ? (show ? char.toUpperCase() : '_') : char;
      }).join('\u00a0');
    }).join('');
  }

  function titleLengthLabel() {
    const letters = Array.from(movie.title).filter(char => /\p{L}/u.test(char)).length;
    const digits = Array.from(movie.title).filter(char => /\p{N}/u.test(char)).length;
    return `${letters} ${letters === 1 ? 'letter' : 'letters'}${digits ? ` · ${digits} ${digits === 1 ? 'digit' : 'digits'}` : ''}`;
  }

  function describeColors(colors) {
    return Array.from({length:8}, (_, section) => {
      const samples = colors.slice(Math.floor(section*colors.length/8), Math.floor((section+1)*colors.length/8));
      const rgb = [0,1,2].map(channel => samples.reduce((sum, hex) => sum+parseInt(hex.slice(1+channel*2,3+channel*2),16),0)/samples.length);
      const [r,g,b] = rgb;
      const brightness = (r+g+b)/3;
      if (brightness < 12) return 'near black';
      const light = brightness < 65 ? 'dark ' : brightness > 160 ? 'light ' : '';
      if (Math.max(...rgb)-Math.min(...rgb) < 12) return light+'gray';
      if (r > g*1.14 && b > g*1.12) return light+'purple';
      if (r > g*1.3 && r > b*1.3) return light+'red-brown';
      if (g > r*1.08 && g > b*1.08) return light+'green';
      if (b > r*1.08 && b > g*1.08) return light+'blue';
      if (r > b*1.12 && g > b*1.12) return light+'gold-brown';
      if (g > r && b > r) return light+'blue-green';
      return light+'muted brown';
    }).join(', then ');
  }

  function render() {
    const done = state.status !== 'playing';
    const solved = state.status === 'solved';
    if (solved) winnerPalette().forEach((color,i) => document.body.style.setProperty(`--winner-${i}`,color.join(' ')));
    document.body.classList.toggle('is-solved',solved);
    $('theme-color').setAttribute('content',solved ? '#0d1016' : '#faf9f6');
    $('puzzle-content').hidden = solved;
    $('clue-row').hidden = state.hintsUsed === 0;
    $('genre-hint').hidden = state.hintsUsed < 1;
    $('year-hint').hidden = state.hintsUsed < 2;
    $('genre-clue').textContent = state.hintsUsed >= 1 ? movie.genres.join(' / ') : '';
    $('year-clue').textContent = state.hintsUsed >= 2 ? movie.year : '';
    $('title-hint').hidden = state.hintsUsed < 4 || done;
    $('letter-count').textContent = state.hintsUsed >= 4 && !done ? titleLengthLabel() : '';
    $('masked-title').textContent = state.hintsUsed >= 4 && !done ? maskedTitle(state.hintsUsed >= 5) : '';
    const nextHint = hints[state.hintsUsed];
    const guessesLeft = nextHint ? Math.max(0,nextHint.after-state.attempts) : 0;
    $('guess-form').hidden = done;
    $('hint-button').hidden = done;
    $('hint-button').disabled = !nextHint || guessesLeft > 0;
    $('hint-button').textContent = !nextHint ? 'All hints used' : guessesLeft
      ? `${nextHint.name} hint in ${guessesLeft} ${guessesLeft === 1 ? 'guess' : 'guesses'}`
      : `Reveal ${nextHint.name.toLowerCase()}${state.hintsUsed === 2 ? ' hint' : ''}`;
    $('reveal-button').hidden = done;
    $('hint-text').textContent = state.hintsUsed >= 3 && !done ? movie.hint : '';
    $('attempt-count').textContent = state.attempts;
    $('attempt-label').textContent = state.attempts === 1 ? 'guess' : 'guesses';
    $('result').hidden = !done;
    $('success-heading').hidden = !solved;
    $('success-score').hidden = !solved;
    $('success-date').hidden = !solved;
    $('share-controls').hidden = !solved;
    updateTodayLink();
    $('success-count').textContent = state.attempts;
    $('success-unit').textContent = state.attempts === 1 ? 'guess' : 'guesses';
    $('success-heading').textContent = solved ? winTitle() : '';
    $('success-hint').textContent = solved ? hintLabel() : '';
    $('success-hint').hidden = !solved;
    $('share-prompt').textContent = solved ? challengeText() : '';
    $('share-prompt').hidden = !solved;
    $('share-note').hidden = !solved;
    $('win-barcode').hidden = !solved;
    if (solved) {
      const stamp = $('win-barcode');
      stamp.width = movie.colors.length;
      stamp.height = 72;
      const stampCtx = stamp.getContext('2d');
      movie.colors.forEach((color,x) => {
        stampCtx.fillStyle = color;
        stampCtx.fillRect(x,0,1,72);
      });
    }
    $('success-heading').setAttribute('aria-label',`Found the movie in ${state.attempts} ${state.attempts === 1 ? 'guess' : 'guesses'}. ${hintLabel()}.`);
    $('success-date').textContent = dayKey;
    $('success-date').setAttribute('datetime',dayKey);
    $('answer-title').textContent = done ? `${movie.title} (${movie.year})` : '';
    $('feedback').textContent = state.status === 'solved' ? 'Correct.'
      : state.status === 'revealed' ? 'Answer revealed.'
      : state.lastGuess ? `“${state.lastGuess}” isn’t it. Try again.` : '';
    canvas.setAttribute('role','img');
    canvas.setAttribute('aria-label', `${done ? movie.title+': ' : ''}Movie color timeline, in eight chronological sections: ${describeColors(movie.colors)}.`);
    if (solved) prepareShareCard();
    else clearShareAsset();
  }

  function updateTodayLink() {
    const archived = pinnedDay && dayKey !== daily.dayKey(new Date());
    $('play-today').hidden = !archived;
    $('play-today').href = publicBase;
    $('completion-message').textContent = archived ? 'A new movie is waiting.' : 'Next movie tomorrow.';
  }

  function scheduleMidnight() {
    clearTimeout(midnightTimer);
    const now = new Date();
    const next = new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
    midnightTimer = setTimeout(() => {
      if (!ensureDay()) scheduleMidnight();
    }, Math.max(1000, next.getTime()-now.getTime()+50));
  }

  function loadDay(announce = false) {
    dayKey = pinnedDay || daily.dayKey(new Date());
    const date = daily.dateForKey(dayKey);
    movie = linkedMovie || daily.movieForDay(movies,dayKey);
    state = readState() || freshState();
    $('date-label').textContent = new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',year:'numeric'}).format(date);
    $('date-label').setAttribute('datetime', dayKey);
    canvas.width = movie.colors.length;
    canvas.height = 450;
    ctx.imageSmoothingEnabled = false;
    movie.colors.forEach((color,x) => {
      ctx.fillStyle = color;
      ctx.fillRect(x,0,1,canvas.height);
    });
    $('guess-input').value = '';
    render();
    if (announce) $('feedback').textContent = 'A new day, a new movie.';
    scheduleMidnight();
  }

  function ensureDay() {
    if (pinnedDay) { updateTodayLink(); return false; }
    if (localDay(new Date()).key === dayKey) return false;
    loadDay(true);
    return true;
  }

  $('guess-form').addEventListener('submit', event => {
    event.preventDefault();
    if (ensureDay() || state.status !== 'playing') return;
    const input = $('guess-input');
    const guess = input.value.trim().slice(0,160);
    if (!normalize(guess)) {
      $('feedback').textContent = 'Enter a movie title.';
      input.focus();
      return;
    }
    updateState(() => {
      state.attempts++;
      state.lastGuess = guess;
      if (matchesTitle(guess)) state.status = 'solved';
      saveState();
      render();
      if (state.status === 'solved') {
        $('success-heading').focus({preventScroll:true});
        window.scrollTo({top:0,behavior:'instant'});
      } else {
        input.focus({preventScroll:true});
        input.select();
      }
    });
  });

  $('hint-button').addEventListener('click', () => {
    if (ensureDay() || state.status !== 'playing') return;
    updateState(() => {
      const nextHint = hints[state.hintsUsed];
      if (!nextHint || state.attempts < nextHint.after) { render(); return; }
      state.hintsUsed++;
      saveState();
      render();
      $('guess-input').focus({preventScroll:true});
    });
  });

  $('reveal-button').addEventListener('click', () => {
    if (ensureDay() || state.status !== 'playing') return;
    updateState(() => {
      state.status = 'revealed';
      saveState();
      render();
      $('answer-title').focus({preventScroll:true});
    });
  });

  $('dev-reset').addEventListener('click', () => {
    if (!isDev) return;
    ensureDay();
    const requestedDay = dayKey;
    const version = ++resetVersion;
    let didRun = false;
    const reset = () => {
      didRun = true;
      if (ensureDay() || dayKey !== requestedDay || version !== resetVersion) return;
      try { localStorage.removeItem(`lut-game:${dayKey}`); } catch {}
      state = freshState();
      saveState();
      $('guess-input').value = '';
      render();
      $('feedback').textContent = 'Game reset.';
      $('guess-input').focus({preventScroll:true});
      window.scrollTo({top:0,behavior:'instant'});
    };
    if (typeof navigator !== 'undefined' && navigator.locks) {
      navigator.locks.request(`lut-game:${requestedDay}`,reset).catch(() => { if (!didRun) reset(); });
    } else reset();
  });
  $('help-button').addEventListener('click', () => dialog.showModal());
  $('close-help').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  $('share-twitter').addEventListener('click', event => {
    if (ensureDay() || state.status !== 'solved') event.preventDefault();
  });
  $('download-card').addEventListener('click', event => {
    if (ensureDay() || state.status !== 'solved' || !shareAsset) event.preventDefault();
  });
  $('share-instagram').addEventListener('click', async () => {
    if (ensureDay() || state.status !== 'solved' || !shareAsset) return;
    const asset = shareAsset;
    const key = shareKey;
    let canceled = false;
    try {
      if (asset.file && typeof navigator !== 'undefined' && navigator.share
          && navigator.canShare && navigator.canShare({files:[asset.file]})) {
        $('share-status').textContent = 'Choose Instagram in the share sheet.';
        await navigator.share({files:[asset.file],title:'lut game',text:resultText(),url:gameUrl()});
        if (shareKey === key) $('share-status').textContent = 'Result handed to your share app.';
        return;
      }
    } catch (error) {
      canceled = error.name === 'AbortError';
    }
    if (shareKey !== key) return;
    $('download-card').hidden = false;
    $('share-status').textContent = 'Download the image and use Copy link to add an Instagram link sticker.';
    if (!canceled) $('download-card').click();
  });
  $('copy-link').addEventListener('click',async () => {
    if (ensureDay() || state.status !== 'solved') return;
    const link = gameUrl();
    const key = shareKey;
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(link);
      if (shareKey === key) $('share-status').textContent = 'Link copied. Use it to challenge friends or add an Instagram link sticker.';
    } catch {
      if (shareKey !== key) return;
      $('share-link').value = link;
      $('share-link').hidden = false;
      $('share-link').focus();
      $('share-link').select();
      $('share-status').textContent = 'Copy this link to share the puzzle.';
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureDay(); });
  window.addEventListener('focus', ensureDay);
  window.addEventListener('storage', event => {
    if (ensureDay()) return;
    if (event.key === `lut-game:${dayKey}`) { mergeState(readState()); render(); }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== '?' || event.altKey || event.ctrlKey || event.metaKey || dialog.open
        || ['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName) || event.target.isContentEditable) return;
    event.preventDefault();
    dialog.showModal();
  });
  loadDay();
})();
