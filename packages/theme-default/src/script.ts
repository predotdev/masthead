/**
 * The theme's only script, loaded with defer after the page has rendered.
 * Everything it does is an enhancement: without it, search opens the search
 * page, the signup form posts normally, and the page keeps its color scheme.
 *
 * Written as plain ES2019 in a string so it ships exactly as written.
 */
export const script = `(function () {
  // ---------------------------------------------------------------- analytics (PostHog, when configured)
  var article = document.querySelector('article[data-post-slug]');
  var postSlug = article ? article.getAttribute('data-post-slug') : null;
  var analytics = (function () {
    var el = document.getElementById('mh-analytics');
    try { return el ? JSON.parse(el.textContent || '{}') : {}; } catch (e) { return {}; }
  })();
  var ph = analytics.posthog;
  var production = !!ph && (location.hostname === ph.canonicalHost || location.hostname === 'www.' + ph.canonicalHost);
  var queue = [];
  function track(event, props) {
    if (!ph || (!production && !ph.trackPreview)) return;
    var p = props || {};
    if (postSlug && !('post_slug' in p)) p.post_slug = postSlug;
    if (window.posthog && window.posthog.__loaded) window.posthog.capture(event, p);
    else queue.push([event, p]);
  }
  track.id = function () { return window.posthog && window.posthog.__loaded ? window.posthog.get_distinct_id() : null; };
  function placement(form) {
    return form.closest('.post-foot, article') || article ? 'post' : form.closest('#subscribe') ? 'home' : 'page';
  }
  if (ph && (production || ph.trackPreview)) {
    var startPosthog = function () {
      var s = document.createElement('script');
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.src = ph.host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js';
      s.onload = function () {
        var lib = window.posthog;
        if (!lib || typeof lib.init !== 'function') return;
        lib.init(ph.key, {
          api_host: ph.host,
          person_profiles: 'always',
          autocapture: true,
          capture_pageview: true,
          capture_pageleave: true,
          disable_session_recording: true,
          disable_surveys: true,
          loaded: function (p) {
            // The blog never identifies anyone; it names the environment and, on a post, the post that brought the reader.
            var props = { environment: production ? 'production' : 'preview' };
            if (postSlug) props.blog_ref_post_slug = postSlug;
            p.register(props);
            if (article) {
              p.setPersonProperties({}, { first_blog_post_slug: postSlug, first_blog_visit_at: new Date().toISOString() });
              p.capture('blog_post_viewed', {
                post_slug: postSlug,
                post_type: article.getAttribute('data-post-type'),
                post_tags: (article.getAttribute('data-post-tags') || '').split(',').filter(Boolean),
                post_authors: (article.getAttribute('data-post-authors') || '').split(',').filter(Boolean),
                post_published_at: article.getAttribute('data-post-published') || null
              });
            }
            queue.splice(0).forEach(function (q) { p.capture(q[0], q[1]); });
          }
        });
      };
      document.head.appendChild(s);
    };
    // After the page is up, so analytics never slows the first paint.
    var later = window.requestIdleCallback || function (f) { setTimeout(f, 1500); };
    if (document.readyState === 'complete') later(startPosthog); else window.addEventListener('load', function () { later(startPosthog); }, { once: true });

    // A reader got through most of a post.
    if (article) {
      var t0 = Date.now(), read = false;
      window.addEventListener('scroll', function () {
        if (read) return;
        var r = article.getBoundingClientRect();
        if (r.height && (innerHeight - r.top) / r.height >= 0.6) { read = true; track('blog_post_read', { seconds_on_page: Math.round((Date.now() - t0) / 1000) }); }
      }, { passive: true });
    }
    // Links out of the blog into the product, and shares.
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      var share = a.getAttribute('data-share');
      if (share) return track('blog_post_shared', { network: share });
      var u;
      try { u = new URL(a.href, location.href); } catch (err) { return; }
      var base = document.documentElement.getAttribute('data-base') || '/';
      var toProduct = (u.hostname === ph.canonicalHost || u.hostname === 'www.' + ph.canonicalHost) && u.pathname.indexOf(base) !== 0;
      if (!toProduct) return;
      var section = a.closest('.site-header') ? 'header' : a.closest('.site-footer') ? 'footer' : a.closest('.kg-button-card, .kg-cta-card') ? 'button' : a.closest('.content') ? 'post_body' : a.closest('.masthead, .feature-hero') ? 'hero' : 'page';
      track('blog_cta_clicked', { cta: (a.textContent || '').trim().slice(0, 60), section: section, href: u.origin + u.pathname });
    }, true);
  }

  var d = document, root = d.documentElement;

  // Color scheme: the choice is stored per reader.
  function setScheme(s) {
    root.setAttribute('data-theme', s);
    try { localStorage.setItem('mh-theme', s); } catch (e) {}
  }
  d.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (t) setScheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  // The header is clear over the night sky at the top of the page and turns to glass once the page scrolls.
  var bar = d.querySelector('.site-header');
  if (bar) {
    var glass = function () { bar.classList.toggle('is-scrolled', window.scrollY > 4); };
    glass();
    window.addEventListener('scroll', glass, { passive: true });
  }

  // Signed-in readers see the product button their session calls for.
  var cta = d.querySelector('[data-signed-in-cookie]');
  if (cta && new RegExp('(^|; )' + cta.getAttribute('data-signed-in-cookie') + '=').test(d.cookie)) {
    cta.textContent = cta.getAttribute('data-signed-in-label');
    cta.setAttribute('href', cta.getAttribute('data-signed-in-url'));
  }

  // Copy link buttons.
  d.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-copy-link]');
    if (!b) return;
    e.preventDefault();
    var done = function () { b.setAttribute('data-copied', ''); setTimeout(function () { b.removeAttribute('data-copied'); }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(location.href.split('#')[0]).then(done, function () {});
  });

  // Signup forms confirm in place instead of loading a new page.
  d.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f.matches || !f.matches('form[data-subscribe]')) return;
    e.preventDefault();
    var btn = f.querySelector('button'), note = f.parentNode.querySelector('[data-subscribe-note]');
    btn.disabled = true;
    track('blog_subscribe_submitted', { placement: placement(f) });
    fetch(f.action, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: f.elements.email.value, company: f.elements.company ? f.elements.company.value : '', analyticsId: track.id(), placement: placement(f), post: postSlug })
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.'); return j; });
    }).then(function (j) {
      f.hidden = true;
      note.textContent = j.status === 'subscribed' ? "You're already subscribed. New posts will keep arriving." : j.emailed === false ? 'This blog is in test mode, so no email was sent.' : 'Check your inbox and click the link to confirm.';
      note.hidden = false;
    }).catch(function (err) {
      note.textContent = err.message;
      note.hidden = false;
      btn.disabled = false;
    });
  });

  // Topic filter on the front page: switches in place, keeps ?topic= in the address.
  var filterNav = d.querySelector('.topics[data-filter]'), grid = d.querySelector('[data-filterable]'), more = d.querySelector('[data-filter-more]');
  function applyTopic(slug) {
    if (!filterNav || !grid) return;
    var chips = filterNav.querySelectorAll('[data-topic]'), chosen = null;
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute('data-topic') === slug;
      if (on) { chips[i].setAttribute('aria-current', 'page'); chosen = chips[i]; } else chips[i].removeAttribute('aria-current');
    }
    var cards = grid.children, shown = 0;
    for (var j = 0; j < cards.length; j++) {
      var match = !slug || (' ' + cards[j].getAttribute('data-topics') + ' ').indexOf(' ' + slug + ' ') >= 0;
      cards[j].hidden = !match;
      if (match) shown++;
    }
    if (more) {
      var total = chosen ? Number(chosen.getAttribute('data-count') || 0) : 0;
      if (slug && chosen && total > shown) {
        var a = more.querySelector('a');
        a.setAttribute('href', chosen.getAttribute('href'));
        a.textContent = (shown ? 'All ' : 'See all ') + total + ' ' + chosen.firstChild.textContent + ' posts';
        more.hidden = false;
      } else more.hidden = true;
    }
  }
  if (filterNav && grid) {
    filterNav.addEventListener('click', function (e) {
      var chip = e.target.closest && e.target.closest('[data-topic]');
      if (!chip || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      var slug = chip.getAttribute('data-topic');
      applyTopic(slug);
      track('blog_topic_filtered', { topic: slug || 'all' });
      history.replaceState(null, '', slug ? '?topic=' + encodeURIComponent(slug) : location.pathname);
    });
    var initial = new URLSearchParams(location.search).get('topic');
    if (initial) applyTopic(initial);
  }

  // Search: a dialog over the page, with the index loaded on first use.
  var indexUrl = root.getAttribute('data-search-index'), index = null, dialog, input, list, items = [], active = 0;
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function mark(text, terms) {
    var out = esc(text);
    terms.forEach(function (t) {
      if (t.length < 2) return;
      out = out.replace(new RegExp('(' + esc(t).replace(/[.*+?^()|[\\]\\\\{}$]/g, '\\\\$&') + ')', 'gi'), '<mark>$1</mark>');
    });
    return out;
  }
  function load() {
    if (!index) index = fetch(indexUrl).then(function (r) { return r.json(); });
    return index;
  }
  function score(e, terms) {
    var t = e.title.toLowerCase(), g = e.tags.join(' ').toLowerCase(), x = (e.excerpt + ' ' + e.text + ' ' + e.authors.join(' ')).toLowerCase(), s = 0;
    for (var i = 0; i < terms.length; i++) {
      var q = terms[i], hit = 0, at = t.indexOf(q);
      if (at >= 0) { hit = 1; s += at === 0 || t.charAt(at - 1) === ' ' ? 12 : 6; }
      if (g.indexOf(q) >= 0) { hit = 1; s += 4; }
      if (x.indexOf(q) >= 0) { hit = 1; s += 1; }
      if (!hit) return 0;
    }
    return s;
  }
  function date(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; }
  }
  function render(q) {
    load().then(function (all) {
      var terms = q.toLowerCase().split(/\\s+/).filter(Boolean);
      items = terms.length
        ? all.map(function (e) { return { e: e, s: score(e, terms) }; }).filter(function (r) { return r.s > 0; })
            .sort(function (a, b) { return b.s - a.s || String(b.e.date).localeCompare(String(a.e.date)); }).slice(0, 8).map(function (r) { return r.e; })
        : all.filter(function (e) { return e.date; }).slice(0, 5);
      active = 0;
      if (!items.length) { list.innerHTML = '<p class="search-empty">No posts match \\u201c' + esc(q) + '\\u201d.</p>'; return; }
      list.innerHTML = (terms.length ? '' : '<p class="search-label">Latest posts</p>') + items.map(function (e, i) {
        return '<a class="search-hit" role="option" href="' + esc(e.url) + '"' + (i === 0 ? ' aria-selected="true"' : '') + '>' +
          '<span class="search-hit-title">' + mark(e.title, terms) + '</span>' +
          '<span class="search-hit-excerpt">' + mark(e.excerpt, terms) + '</span>' +
          '<span class="search-hit-meta">' + esc([e.tags[0], date(e.date)].filter(Boolean).join(' \\u00b7 ')) + '</span></a>';
      }).join('');
    });
  }
  function move(by) {
    var hits = list.querySelectorAll('.search-hit');
    if (!hits.length) return;
    hits[active].removeAttribute('aria-selected');
    active = (active + by + hits.length) % hits.length;
    hits[active].setAttribute('aria-selected', 'true');
    hits[active].scrollIntoView({ block: 'nearest' });
  }
  function open() {
    if (!dialog) {
      dialog = d.createElement('dialog');
      dialog.className = 'search-dialog';
      dialog.setAttribute('aria-label', 'Search');
      dialog.innerHTML = '<div class="search-box"><svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>' +
        '<input type="search" placeholder="Search posts" aria-label="Search posts" autocomplete="off" spellcheck="false"><kbd>esc</kbd></div>' +
        '<div class="search-results" role="listbox"></div>' +
        '<div class="search-foot"><span><kbd>\\u2191</kbd><kbd>\\u2193</kbd> move</span><span><kbd>\\u21b5</kbd> open</span></div>';
      d.body.appendChild(dialog);
      input = dialog.querySelector('input');
      list = dialog.querySelector('.search-results');
      var timer;
      var searchTimer;
      input.addEventListener('input', function () {
        clearTimeout(timer); timer = setTimeout(function () { render(input.value.trim()); }, 60);
        // One event per search, once the reader stops typing.
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { var q = input.value.trim(); if (q) track('blog_search', { query_length: q.length, results: list.children.length }); }, 1500);
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter') { var hit = list.querySelectorAll('.search-hit')[active]; if (hit) { e.preventDefault(); location.href = hit.getAttribute('href'); } }
      });
      dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
    }
    if (!dialog.open) dialog.showModal();
    input.value = '';
    input.focus();
    render('');
  }
  d.addEventListener('click', function (e) {
    var s = e.target.closest && e.target.closest('[data-search]');
    if (!s || !indexUrl || !window.HTMLDialogElement) return;
    e.preventDefault();
    open();
  });
  d.addEventListener('keydown', function (e) {
    var typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
      if (!indexUrl || !window.HTMLDialogElement) return;
      e.preventDefault();
      open();
    }
  });
  // Prefetch the index when the reader shows intent.
  d.addEventListener('pointerover', function (e) { if (e.target.closest && e.target.closest('[data-search]')) load(); }, { passive: true });

  // Sparkles: twinkling stars on one canvas over the backdrop. Five regions (two corners,
  // three edges) with per-area density, a triangle-wave twinkle and a near-still drift.
  // Desktop only, started after load when the browser is idle, paused when off screen.
  var sky = d.querySelector('[data-sparkles]');
  if (sky && window.innerWidth >= 768 && window.IntersectionObserver) {
    var begin = function () {
      var g2 = sky.getContext('2d');
      if (!g2) return;
      var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      // x, y, w, h (fractions), density per 400x400, min and max radius, twinkle speed, drift speed
      var regions = [[0, 0, 1 / 3, 1 / 3, 200, 0.3, 0.8, 1, 2], [2 / 3, 0, 1 / 3, 1 / 3, 200, 0.3, 0.8, 1, 2], [0, 1 / 3, 1 / 6, 1 / 3, 150, 0.2, 0.5, 0.4, 0.05], [5 / 6, 1 / 3, 1 / 6, 1 / 3, 150, 0.2, 0.5, 0.4, 0.05], [1 / 3, 0, 1 / 3, 1 / 6, 150, 0.2, 0.5, 0.4, 0.05]];
      var stars = [], raf = 0, last = 0;
      function rnd(a, b) { return a + Math.random() * (b - a); }
      function build() {
        var box = sky.getBoundingClientRect();
        if (!box.width || !box.height) return false;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        sky.width = Math.round(box.width * dpr);
        sky.height = Math.round(box.height * dpr);
        stars = [];
        regions.forEach(function (g) {
          var n = Math.max(1, Math.round(g[4] * (g[2] * box.width * g[3] * box.height) / 160000));
          var bx = g[0] * sky.width, by = g[1] * sky.height, bw = g[2] * sky.width, bh = g[3] * sky.height;
          for (var i = 0; i < n; i++) {
            var speed = rnd(g[8] * 0.01, g[8] * 0.05) * 30, heading = Math.random() * Math.PI * 2;
            stars.push({ x: bx + Math.random() * bw, y: by + Math.random() * bh, r: rnd(g[5], g[6]) * dpr, vx: Math.cos(heading) * speed * dpr, vy: Math.sin(heading) * speed * dpr,
              o: reduced ? 0.55 : rnd(0.1, 1), dir: Math.random() < 0.5 ? -1 : 1, rate: g[7] * 2, bx: bx, by: by, bw: bw, bh: bh });
          }
        });
        return true;
      }
      function draw() {
        g2.clearRect(0, 0, sky.width, sky.height);
        g2.fillStyle = '#fff';
        for (var i = 0; i < stars.length; i++) {
          var p = stars[i];
          g2.globalAlpha = p.o;
          g2.beginPath();
          g2.arc(p.x, p.y, p.r, 0, 6.2832);
          g2.fill();
        }
        g2.globalAlpha = 1;
      }
      function step(now) {
        var dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        for (var i = 0; i < stars.length; i++) {
          var p = stars[i];
          p.o += p.dir * p.rate * dt;
          if (p.o >= 1) { p.o = 1; p.dir = -1; } else if (p.o <= 0.1) { p.o = 0.1; p.dir = 1; }
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.x < p.bx - p.r) p.x = p.bx + p.bw + p.r; else if (p.x > p.bx + p.bw + p.r) p.x = p.bx - p.r;
          if (p.y < p.by - p.r) p.y = p.by + p.bh + p.r; else if (p.y > p.by + p.bh + p.r) p.y = p.by - p.r;
        }
        draw();
        raf = requestAnimationFrame(step);
      }
      function run() { if (raf || reduced || d.hidden) return; last = performance.now(); raf = requestAnimationFrame(step); }
      function halt() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
      if (!build()) return;
      draw();
      sky.style.opacity = '1';
      var onScreen = true;
      new IntersectionObserver(function (e) { onScreen = !!(e[0] && e[0].isIntersecting); if (onScreen) run(); else halt(); }).observe(sky);
      d.addEventListener('visibilitychange', function () { if (d.hidden) halt(); else if (onScreen) run(); });
      var timer;
      window.addEventListener('resize', function () { clearTimeout(timer); timer = setTimeout(function () { if (build()) draw(); }, 150); });
      run();
    };
    var idle = window.requestIdleCallback || function (f) { setTimeout(f, 1200); };
    if (d.readyState === 'complete') idle(begin); else window.addEventListener('load', function () { idle(begin); }, { once: true });
  }
})();
`;
