// LEO SPA Router (Canonical Deterministic Router for LEO Framework)
export function leoUnmount(target, effect = 'slide-away', onComplete) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return;
  const eff = effect || el.getAttribute('data-leo-unmount') || 'slide-away';
  const animClass = eff === 'slide-down' ? 'leo-unmount-slide-down'
    : eff === 'slide-up' ? 'leo-unmount-slide-up'
    : eff === 'slide-left' ? 'leo-unmount-slide-left'
    : eff === 'slide-right' ? 'leo-unmount-slide-right'
    : eff === 'fade' || eff === 'disappear' ? 'leo-unmount-fade'
    : 'leo-unmount-slide-away';
  el.classList.add('leo-unmounting', animClass);
  const done = () => {
    el.style.display = 'none';
    el.dispatchEvent(new CustomEvent('leo:unmounted', { bubbles: true }));
    if (typeof onComplete === 'function') onComplete(el);
  };
  setTimeout(done, 240);
}

function parseLoaderTiming(val, defaultMs = 400) {
  if (val === undefined || val === null) return defaultMs;
  if (typeof val === 'number') {
    return (val > 0 && val <= 30) ? val * 1000 : val;
  }
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s.endsWith('ms')) return parseFloat(s) || defaultMs;
    if (s.endsWith('s')) return (parseFloat(s) || 1) * 1000;
    const num = parseFloat(s);
    if (!isNaN(num)) return (num > 0 && num <= 30) ? num * 1000 : num;
  }
  return defaultMs;
}

export async function leoNavigate(path) {
  try {
    const resp = await fetch('data.json');
    const data = await resp.json();
    const routes = data.routes || {};
    const cleanPath = path || window.location.pathname || '/';
    const target = routes[cleanPath] || routes['/' + cleanPath.replace(/^\/+/, '')] || routes['/'] || Object.values(routes)[0];
    if (!target) return;

    // 1. Unmount ephemeral page components (slide away or disappear)
    const ephemeralElements = Array.from(document.querySelectorAll('#pidRoot [data-leo-unmount]:not([data-leo-persist])'));
    if (ephemeralElements.length > 0) {
      ephemeralElements.forEach((el) => {
        const eff = el.getAttribute('data-leo-unmount') || 'slide-away';
        leoUnmount(el, eff);
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // 2. Display loader with configurable timing from data.json (global or per-route)
    const duration = parseLoaderTiming(
      target?.loaderTiming ?? target?.loaderDuration ?? data.loaderTiming ?? data.loaderDuration ?? data.loaderConfig?.duration,
      400
    );
    const fadeDuration = parseLoaderTiming(
      target?.loaderFadeDuration ?? data.loaderFadeDuration ?? data.loaderConfig?.fadeDuration,
      300
    );

    const loader = document.querySelector(data.loaderRoot || '#pidLoader');
    if (loader && duration > 0 && data.loader !== false) {
      loader.removeAttribute('hidden');
      loader.style.display = 'block';
      loader.style.opacity = '1';
      loader.style.transition = 'opacity ' + fadeDuration + 'ms cubic-bezier(0.4, 0, 0.2, 1)';
      if (data.loader && typeof data.loader === 'string') {
        try {
          const lResp = await fetch(data.loader);
          loader.innerHTML = await lResp.text();
        } catch (_) {}
      }
      // Wait the specified duration before mounting target page and fading away
      await new Promise((resolve) => setTimeout(resolve, duration));
    }

    // 3. Mount target page
    const pageResp = await fetch(target.file);
    const html = await pageResp.text();
    const root = document.querySelector(data.root || '#pidRoot');
    if (root) {
      root.innerHTML = html;
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        window.lucide.createIcons();
      }
      // Execute any inline or dynamic scripts in newly mounted page
      const scripts = root.querySelectorAll('script');
      scripts.forEach((oldScript) => {
        const newScript = document.createElement('script');
        Array.from(oldScript.attributes).forEach((attr) => newScript.setAttribute(attr.name, attr.value));
        newScript.textContent = oldScript.textContent;
        oldScript.parentNode.replaceChild(newScript, oldScript);
      });
    }

    // 4. Smoothly fade out and hide loader
    if (loader && duration > 0) {
      loader.style.opacity = '0';
      await new Promise((resolve) => setTimeout(resolve, fadeDuration));
      loader.setAttribute('hidden', 'true');
      loader.style.display = 'none';
    }

    if (window.location.pathname !== cleanPath) {
      window.history.pushState({}, '', cleanPath);
    }
  } catch (err) {
    console.warn('LEO router navigation error:', err);
  }
}

export async function startLeo() {
  try {
    const path = window.location.pathname || '/';
    await leoNavigate(path);
  } catch (err) {
    console.warn('LEO router error:', err);
  }
}

if (typeof window !== 'undefined') {
  window.leoUnmount = leoUnmount;
  window.leoNavigate = leoNavigate;
  window.startLeo = startLeo;

  document.addEventListener('click', (e) => {
    // Unmount triggers
    const trigger = e.target.closest('[data-leo-unmount-trigger], [data-leo-unmount-target]');
    if (trigger) {
      const targetSelector = trigger.getAttribute('data-leo-unmount-trigger') || trigger.getAttribute('data-leo-unmount-target');
      const eff = trigger.getAttribute('data-leo-unmount-effect') || 'slide-down';
      const targetEl = targetSelector ? document.querySelector(targetSelector) : trigger.closest('[data-leo-unmount]');
      if (targetEl) {
        e.preventDefault();
        leoUnmount(targetEl, eff);
      }
      return;
    }

    // PID link navigation
    const link = e.target.closest('a[leo-pid], a[href], [data-pid], [leo-pid]');
    if (link) {
      const href = link.getAttribute('leo-pid') || link.getAttribute('data-pid') || link.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('http') && !href.startsWith('//') && !href.startsWith('javascript:')) {
        e.preventDefault();
        leoNavigate(href);
      }
    }
  });

  window.addEventListener('DOMContentLoaded', startLeo);
  window.addEventListener('popstate', () => {
    leoNavigate(window.location.pathname || '/');
  });
}