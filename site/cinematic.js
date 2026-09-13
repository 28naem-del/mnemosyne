(() => {
  'use strict';

  const root = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  let manuallyPaused = false;
  let dispose = null;
  let initialAlignmentStarted = false;

  const start = () => {
    if (dispose) return;
    const cleanups = [];
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      cleanups.push(() => target.removeEventListener(type, handler, options));
    };
    const reveals = Array.from(document.querySelectorAll('[data-reveal]'));
    const cards = Array.from(document.querySelectorAll('[data-tilt]'));
    const motionButton = document.getElementById('motion-toggle');
    let paused = manuallyPaused || reducedMotion.matches;
    let revealObserver = null;
    let activeCard = null;
    let cardBounds = null;
    let pointerPosition = null;
    let tiltFrame = 0;

    const revealEverything = () => {
      root.classList.remove('cinematic-enhanced');
      revealObserver?.disconnect();
      reveals.forEach(element => element.classList.add('is-revealed'));
    };
    const resetTilt = () => {
      if (tiltFrame) window.cancelAnimationFrame(tiltFrame);
      tiltFrame = 0;
      if (activeCard) {
        activeCard.style.removeProperty('--tilt-x');
        activeCard.style.removeProperty('--tilt-y');
      }
      activeCard = null;
      cardBounds = null;
      pointerPosition = null;
    };
    const renderMotion = () => {
      paused = manuallyPaused || reducedMotion.matches;
      root.dataset.motion = paused ? 'paused' : 'auto';
      if (motionButton) {
        motionButton.setAttribute('aria-pressed', String(paused));
        motionButton.textContent = paused ? 'Motion off' : 'Motion on';
        motionButton.disabled = reducedMotion.matches;
        motionButton.title = reducedMotion.matches
          ? 'Motion is disabled by your system preference'
          : 'Pause or resume decorative motion';
      }
      if (paused) {
        revealEverything();
        resetTilt();
      }
      window.dispatchEvent(new CustomEvent('mnemosyne:motionchange', {
        detail: { paused },
      }));
    };

    dispose = () => {
      cleanups.splice(0).forEach(cleanup => cleanup());
      resetTilt();
      revealEverything();
      dispose = null;
    };

    try {
      renderMotion();
      listen(reducedMotion, 'change', renderMotion);
      listen(finePointer, 'change', resetTilt);
      if (motionButton) {
        listen(motionButton, 'click', () => {
          manuallyPaused = !manuallyPaused;
          renderMotion();
        });
      }

      // Content is visible by default. Only a working observer enables entry motion.
      if (!paused && reveals.length && 'IntersectionObserver' in window) {
        try {
          revealObserver = new IntersectionObserver(entries => {
            try {
              entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add('is-revealed');
                revealObserver.unobserve(entry.target);
              });
            } catch {
              revealEverything();
            }
          }, { threshold: 0, rootMargin: '0px 0px 32px 0px' });
          reveals.forEach(element => revealObserver.observe(element));
          root.classList.add('cinematic-enhanced');
        } catch {
          revealEverything();
        }
      }

      // Keyboard focus and native deep links must never land in concealed content.
      const revealAncestors = target => {
        let element = target instanceof Element ? target : null;
        while (element) {
          if (element.matches('[data-reveal]')) {
            element.classList.add('is-revealed');
            revealObserver?.unobserve(element);
          }
          element = element.parentElement;
        }
      };
      const revealHash = () => {
        try {
          revealAncestors(document.getElementById(decodeURIComponent(window.location.hash.slice(1))));
        } catch {
          // An invalid URL fragment does not affect the rest of the page.
        }
      };
      listen(document, 'focusin', event => revealAncestors(event.target));
      listen(window, 'hashchange', revealHash);
      revealHash();

      // Native fragment scrolling happens before the recordings fill their panels.
      // Correct that initial position once, unless the visitor has started moving.
      if (!initialAlignmentStarted) {
        initialAlignmentStarted = true;
        const demos = ['memory-demo', 'learning-demo'].map(id => document.getElementById(id)).filter(Boolean);
        const alignmentCleanups = [];
        let requestedHash = window.location.hash;
        let loaded = document.readyState === 'complete';
        let finished = false;
        let alignmentFrame = 0;
        let alignmentTimeout = 0;
        const alignmentListen = (target, type, handler, options) => {
          target.addEventListener(type, handler, options);
          alignmentCleanups.push(() => target.removeEventListener(type, handler, options));
        };
        const finishAlignment = () => {
          finished = true;
          window.cancelAnimationFrame(alignmentFrame);
          window.clearTimeout(alignmentTimeout);
          alignmentCleanups.splice(0).forEach(cleanup => cleanup());
        };
        const align = () => {
          alignmentFrame = 0;
          const hash = requestedHash;
          finishAlignment();
          if (!hash || hash !== window.location.hash) return;
          try {
            const target = document.getElementById(decodeURIComponent(hash.slice(1)));
            if (target) {
              revealAncestors(target);
              target.scrollIntoView({ block: 'start', behavior: 'instant' });
            }
          } catch {
            // Missing or malformed fragments retain the browser's native behavior.
          }
        };
        const scheduleAlignment = (fallback = false) => {
          if (finished || alignmentFrame || !loaded) return;
          if (!fallback && demos.some(demo => demo.dataset.initialLayout !== 'settled')) return;
          // Give the final insertion and native fragment navigation a layout frame.
          alignmentFrame = window.requestAnimationFrame(() => {
            alignmentFrame = window.requestAnimationFrame(align);
          });
        };
        const beginAlignmentWait = () => {
          if (finished) return;
          // Start the fallback after load so slow page assets cannot consume it.
          if (!alignmentTimeout) alignmentTimeout = window.setTimeout(() => scheduleAlignment(true), 10000);
          scheduleAlignment();
        };
        const cancelRequest = () => { requestedHash = ''; };
        ['wheel', 'touchstart', 'pointerdown'].forEach(type => {
          alignmentListen(window, type, cancelRequest, { passive: true, capture: true });
        });
        alignmentListen(window, 'keydown', event => {
          if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar', 'Tab'].includes(event.key)) cancelRequest();
        }, { capture: true });
        alignmentListen(window, 'hashchange', () => {
          requestedHash = window.location.hash;
          scheduleAlignment();
        });
        alignmentListen(window, 'load', () => { loaded = true; beginAlignmentWait(); });
        alignmentListen(window, 'mnemosyne:demoready', () => scheduleAlignment());
        // Both fetches abort after eight seconds; a broken loader must not leave
        // a correction armed indefinitely. Never wait across a BFCache restore.
        cleanups.push(finishAlignment);
        if (loaded) beginAlignmentWait();
      }

      const renderTilt = () => {
        tiltFrame = 0;
        if (!activeCard || !pointerPosition || paused || !finePointer.matches) return;
        if (activeCard.contains(document.activeElement)) return resetTilt();
        cardBounds ??= activeCard.getBoundingClientRect();
        if (!cardBounds.width || !cardBounds.height) return resetTilt();
        const x = Math.max(-1, Math.min(1, (pointerPosition.x - cardBounds.left) / cardBounds.width * 2 - 1));
        const y = Math.max(-1, Math.min(1, (pointerPosition.y - cardBounds.top) / cardBounds.height * 2 - 1));
        activeCard.style.setProperty('--tilt-x', `${(-y * 2.5).toFixed(2)}deg`);
        activeCard.style.setProperty('--tilt-y', `${(x * 2.5).toFixed(2)}deg`);
      };
      cards.forEach(card => {
        listen(card, 'pointermove', event => {
          if (event.pointerType !== 'mouse' || paused || !finePointer.matches) return;
          if (card.contains(document.activeElement)) return;
          if (activeCard !== card) {
            resetTilt();
            activeCard = card;
          }
          pointerPosition = { x: event.clientX, y: event.clientY };
          if (!tiltFrame) tiltFrame = window.requestAnimationFrame(renderTilt);
        }, { passive: true });
        listen(card, 'pointerleave', resetTilt);
        listen(card, 'pointercancel', resetTilt);
        listen(card, 'focusin', resetTilt);
      });

      const progress = document.getElementById('scroll-progress');
      let scrollFrame = 0;
      const renderScroll = () => {
        scrollFrame = 0;
        if (!progress) return;
        const range = root.scrollHeight - window.innerHeight;
        const fraction = range > 0 ? Math.max(0, Math.min(1, window.scrollY / range)) : 0;
        progress.style.transform = `scaleX(${fraction})`;
      };
      const scheduleScroll = () => {
        // Only the currently hovered card needs new geometry after the page moves.
        cardBounds = null;
        if (!scrollFrame) scrollFrame = window.requestAnimationFrame(renderScroll);
      };
      listen(window, 'scroll', scheduleScroll, { passive: true });
      listen(window, 'resize', scheduleScroll, { passive: true });
      listen(window, 'blur', resetTilt);
      listen(document, 'visibilitychange', () => {
        if (document.hidden) resetTilt();
        else scheduleScroll();
      });
      if ('ResizeObserver' in window && progress) {
        const sizeObserver = new ResizeObserver(scheduleScroll);
        sizeObserver.observe(document.body);
        cleanups.push(() => sizeObserver.disconnect());
      }
      cleanups.push(() => {
        if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
      });
      renderScroll();

      const chapterLinks = Array.from(document.querySelectorAll('#chapter-nav a[href^="#"]'));
      const chapters = chapterLinks.map(link => ({
        link,
        section: document.getElementById(link.hash.slice(1)),
      })).filter(chapter => chapter.section);
      const setChapter = active => {
        chapters.forEach(chapter => {
          if (chapter === active) chapter.link.setAttribute('aria-current', 'location');
          else chapter.link.removeAttribute('aria-current');
        });
      };
      let initialChapter = null;
      chapters.forEach(chapter => {
        if (chapter.section.getBoundingClientRect().top <= window.innerHeight * 0.36) initialChapter = chapter;
        listen(chapter.link, 'click', () => setChapter(chapter));
      });
      setChapter(initialChapter);
      if (chapters.length && 'IntersectionObserver' in window) {
        const visibleChapters = new Set();
        const chapterObserver = new IntersectionObserver(entries => {
          entries.forEach(entry => {
            if (entry.isIntersecting) visibleChapters.add(entry.target);
            else visibleChapters.delete(entry.target);
          });
          const active = chapters.filter(chapter => visibleChapters.has(chapter.section)).at(-1);
          if (active) setChapter(active);
          else if (entries.some(entry => entry.target === chapters[0].section
            && entry.boundingClientRect.top > window.innerHeight * 0.36)) setChapter(null);
        }, { rootMargin: '-12% 0px -64% 0px', threshold: 0 });
        cleanups.push(() => chapterObserver.disconnect());
        chapters.forEach(chapter => chapterObserver.observe(chapter.section));
      }
    } catch {
      // Enhancement failures must leave the complete document and native links usable.
      dispose();
      root.dataset.motion = 'paused';
      if (motionButton) {
        motionButton.textContent = 'Motion off';
        motionButton.setAttribute('aria-pressed', 'true');
        motionButton.disabled = true;
      }
      window.dispatchEvent(new CustomEvent('mnemosyne:motionchange', { detail: { paused: true } }));
    }
  };

  // BFCache restoration restarts observers without duplicating event handlers.
  window.addEventListener('pagehide', () => dispose?.());
  window.addEventListener('pageshow', start);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
