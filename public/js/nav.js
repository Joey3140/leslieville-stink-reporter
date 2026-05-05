// Mobile auto-hiding nav. Slides the top bar off-screen on scroll-down and back
// in on scroll-up — standard mobile-browser behaviour. Desktop and reduced-motion
// users get the static sticky nav. Self-contained: no dependencies on window.LSV
// so pages that don't load state.js (unsubscribe.html, about.html) still work.
(function () {
    const nav = document.querySelector('nav.nav');
    if (!nav) return;

    const HIDE_DELTA = 6;     // ignore sub-pixel jitter (iOS URL bar collapse)
    const SHOW_AT_TOP = 8;    // always show when near the top
    const mobileMq = window.matchMedia('(max-width: 720px)');
    const reduceMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');

    let lastY = window.scrollY || 0;
    let ticking = false;
    let attached = false;

    function onScroll() {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
            const y = window.scrollY || 0;
            const dy = y - lastY;
            if (y <= SHOW_AT_TOP) {
                nav.classList.remove('nav--hidden');
            } else if (dy > HIDE_DELTA) {
                nav.classList.add('nav--hidden');
            } else if (dy < -HIDE_DELTA) {
                nav.classList.remove('nav--hidden');
            }
            lastY = y;
            ticking = false;
        });
    }

    // Keyboard tab into a hidden nav should reveal it.
    function onFocusIn(e) {
        if (nav.contains(e.target)) nav.classList.remove('nav--hidden');
    }

    function attach() {
        if (attached) return;
        attached = true;
        lastY = window.scrollY || 0;
        window.addEventListener('scroll', onScroll, { passive: true });
        document.addEventListener('focusin', onFocusIn);
    }
    function detach() {
        if (!attached) return;
        attached = false;
        window.removeEventListener('scroll', onScroll);
        document.removeEventListener('focusin', onFocusIn);
        nav.classList.remove('nav--hidden');
    }

    function evaluate() {
        if (mobileMq.matches && !reduceMotionMq.matches) attach();
        else detach();
    }

    evaluate();
    mobileMq.addEventListener('change', evaluate);
    reduceMotionMq.addEventListener('change', evaluate);
})();
