export function initScrollEffects() {
  if (typeof window === 'undefined') return;
  try {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const revealSelector = [
      'section',
      '.hero-card',
      '.feature-card',
      '.pricing-card',
      '.studio-card',
      '.contact-card',
      '.plan-card',
      '.profile-card',
      '.keyboard-shell',
      '.avatar-preview-card',
    ].join(',');

    const elements = Array.from(document.querySelectorAll(revealSelector));

    if (!reduceMotion) {
      elements.forEach((el) => el.classList.add('reveal'));

      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('show');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

      elements.forEach((el, i) => {
        el.style.setProperty('--reveal-delay', `${(i % 4) * 60}ms`);
        observer.observe(el);
      });
    }

    // Keyboard: gentle staggered key pulse when it enters the viewport
    const keyboardShell = document.querySelector('.keyboard-shell');
    if (keyboardShell && !reduceMotion) {
      const keys = Array.from(keyboardShell.querySelectorAll('.piano-key'));
      const kbObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            keys.forEach((k, idx) => {
              const delay = (idx % 12) * 40;
              k.style.setProperty('--key-delay', `${delay}ms`);
              k.classList.add('pulse');
              setTimeout(() => k.classList.remove('pulse'), 1200 + delay);
            });
            kbObserver.unobserve(keyboardShell);
          }
        });
      }, { threshold: 0.28 });
      kbObserver.observe(keyboardShell);
    }

    // Topbar: subtle blur once the page scrolls
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        const topbar = document.querySelector('.topbar');
        if (topbar) {
          topbar.classList.toggle('scrolled', window.scrollY > 18);
        }
        ticking = false;
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  } catch (err) {
    // silent
  }
}
