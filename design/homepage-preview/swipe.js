// Pointer-driven portrait carousel. Touch keeps native vertical scrolling and zoom.
let cleanupSwipe = () => {};

function renderSwipe(app) {
  cleanupSwipe();
  const p = people[selected];
  app.innerHTML = `<section class="swipe-room">
    <div class="room-heading"><span><i></i> <span id="conversation-name">${p.name}’s conversations</span></span><button id="new-chat">＋ New chat</button></div>
    <div class="swipe-welcome">
      <div class="portrait-picker" role="group" aria-roledescription="carousel" aria-label="Choose a speaker" tabindex="0">
        <div class="portrait-stage" aria-label="Swipe left or right to change speaker">
          ${people.map((person, index) => `<button class="swipe-card" data-card="${index}" tabindex="-1" aria-label="Select ${person.name}" aria-pressed="${index === selected}" style="--card:${person.color}">${photo(person)}<span class="snip-badge" aria-hidden="true">${scissors}</span></button>`).join('')}
        </div>
        <div class="swipe-controls"><button class="step-speaker" id="previous-speaker" aria-label="Previous speaker">‹</button><div><span id="speaker-position" class="sr-only" aria-live="polite">${p.name}, ${selected + 1} of 7</span><div class="speaker-dots">${people.map((person, index) => `<button data-dot="${index}" aria-label="Choose ${person.name}" aria-pressed="${index === selected}"><span></span></button>`).join('')}</div><p class="swipe-instruction"><span class="touch-copy">Swipe</span><span class="mouse-copy">Drag</span> to find your person</p></div><button class="step-speaker" id="next-speaker" aria-label="Next speaker">›</button></div>
      </div>
      <div class="swipe-copy">${heading()}${suggestions()}</div>
    </div>
    <div class="swipe-composer">${composer()}</div>
  </section>`;
}

function bindSwipe() {
  const stage = document.querySelector('.portrait-stage');
  const picker = document.querySelector('.portrait-picker');
  const cards = [...document.querySelectorAll('.swipe-card')];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sessions = new Map();
  let drag = null;
  let suppressClickUntil = 0;
  const wrap = (value) => (value + people.length) % people.length;
  const step = () => stage.clientWidth < 340 ? 94 : 112;
  function offset(index) {
    let distance = wrap(index - selected);
    if (distance > 3) distance -= people.length;
    return distance;
  }
  function paint(dx = 0, animate = true) {
    cards.forEach((card, index) => {
      const distance = offset(index) + dx / step();
      const abs = Math.abs(distance);
      const scale = Math.max(.52, 1 - abs * .3);
      const opacity = abs > 1.9 ? 0 : Math.max(0, 1 - abs * .72);
      card.style.transition = animate && !reducedMotion.matches
        ? 'transform 480ms cubic-bezier(.22,1.22,.36,1), opacity 280ms ease, filter 280ms ease'
        : 'none';
      card.style.transform = `translateX(${distance * step()}px) translateY(${Math.min(abs, 2) * 10}px) rotate(${distance * 11 - 5}deg) scale(${scale})`;
      card.style.opacity = opacity;
      card.style.filter = `saturate(${Math.max(.45, 1 - abs * .4)})`;
      card.style.zIndex = String(10 - Math.round(abs * 2));
      card.style.pointerEvents = abs < 1.4 ? 'auto' : 'none';
      card.setAttribute('aria-hidden', String(abs >= 1.4));
      card.setAttribute('aria-pressed', String(index === selected));
      card.querySelector('.snip-badge').style.opacity = String(Math.max(0, 1 - abs * 2));
    });
  }
  function choose(index) {
    index = wrap(index);
    if (index === selected) { paint(); return; }
    sessions.set(selected, {
      draft: document.getElementById('prompt').value,
      log: document.getElementById('conversation')?.cloneNode(true),
    });
    selected = index;
    const person = people[selected];
    const saved = sessions.get(selected);
    document.getElementById('conversation')?.remove();
    if (saved?.log) document.querySelector('.composer').before(saved.log.cloneNode(true));
    document.getElementById('prompt').value = saved?.draft || '';
    document.querySelector('.swipe-room').classList.toggle('has-conversation', Boolean(saved?.log));
    document.querySelector('.suggestions').hidden = Boolean(saved?.log);
    document.querySelector('.speaker-title').textContent = person.name;
    document.getElementById('conversation-name').textContent = `${person.name}’s conversations`;
    document.querySelector('.scope').innerHTML = `${photo(person)}<span>Searching <strong>${person.name}</strong></span>`;
    document.querySelector('label[for="prompt"]').textContent = `Describe the ${person.name} clip you want to find`;
    document.getElementById('speaker-position').textContent = `${person.name}, ${selected + 1} of 7`;
    document.querySelectorAll('[data-dot]').forEach(dot => dot.setAttribute('aria-pressed', String(Number(dot.dataset.dot) === selected)));
    // Keep the existing DOM so the portrait settles from its current dragged position.
    paint();
    if (!reducedMotion.matches) {
      document.querySelector('.swipe-copy').getAnimations().forEach(animation => animation.cancel());
      document.querySelector('.swipe-copy').animate(
        [{ opacity: .45, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 230, easing: 'ease-out' },
      );
    }
  }
  document.getElementById('previous-speaker').onclick = () => choose(selected - 1);
  document.getElementById('next-speaker').onclick = () => choose(selected + 1);
  document.querySelectorAll('[data-dot]').forEach(dot => dot.onclick = () => choose(Number(dot.dataset.dot)));
  picker.onkeydown = event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      choose(selected + (event.key === 'ArrowRight' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      choose(event.key === 'Home' ? 0 : people.length - 1);
    }
  };
  stage.ondragstart = event => event.preventDefault();
  stage.onclick = event => {
    if (performance.now() < suppressClickUntil) return;
    const card = event.target.closest('[data-card]');
    if (card) choose(Number(card.dataset.card));
  };
  stage.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, axis: null, lastX: event.clientX, lastTime: event.timeStamp, velocity: 0 };
    // Capture after the gesture becomes horizontal; ordinary portrait taps retain their target.
  };
  stage.onpointermove = event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 7) {
      drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (drag.axis === 'x') {
        stage.setPointerCapture(event.pointerId);
        stage.classList.add('dragging');
      }
    }
    if (drag.axis !== 'x') return;
    const elapsed = event.timeStamp - drag.lastTime;
    if (elapsed > 0) drag.velocity = (event.clientX - drag.lastX) / elapsed;
    drag.lastX = event.clientX;
    drag.lastTime = event.timeStamp;
    drag.dx = dx;
    // One portrait per gesture, with a little resistance beyond the next card.
    const limit = step() * 1.12;
    paint(Math.max(-limit, Math.min(limit, dx)), false);
  };
  function finish(event, cancelled = false) {
    if (!drag || drag.id !== event.pointerId) return;
    const gesture = drag;
    drag = null;
    stage.classList.remove('dragging');
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (gesture.axis !== 'x') return;
    suppressClickUntil = performance.now() + 350;
    const recentFlick = event.timeStamp - gesture.lastTime < 100 && Math.abs(gesture.velocity) > .45 && Math.abs(gesture.dx) > 12;
    if (!cancelled && (Math.abs(gesture.dx) > step() * .32 || recentFlick)) {
      choose(selected + (gesture.dx < 0 ? 1 : -1));
    } else paint();
  }
  stage.onpointerup = event => finish(event);
  stage.onpointercancel = event => finish(event, true);
  stage.onlostpointercapture = event => {
    // Touch implicitly captures the card first. Its bubbled release is not a cancelled drag.
    if (event.target === stage) finish(event, true);
  };
  stage.onpointerleave = event => {
    if (drag && !stage.hasPointerCapture(event.pointerId)) finish(event, true);
  };
  const observer = new ResizeObserver(() => { if (!drag) paint(0, false); });
  observer.observe(stage);
  cleanupSwipe = () => observer.disconnect();
  paint(0, false);
}
