/**
 * The whole theme stylesheet. It uses the reader's system font (no font
 * download), and every color is a token so light and dark are one set of rules.
 */
export const css = `:root {
  --bg: #ffffff;
  --panel: #ffffff;
  --surface: #fafafa;
  --surface-2: #f3f3f4;
  --fg: #0a0a0a;
  --fg-2: rgba(10, 10, 10, 0.86);
  --muted: rgba(10, 10, 10, 0.6);
  --faint: rgba(10, 10, 10, 0.56);
  --line: rgba(10, 10, 10, 0.08);
  --line-2: rgba(10, 10, 10, 0.14);
  --btn: #0a0a0a;
  --btn-ink: #ffffff;
  --pill: linear-gradient(to top, rgba(10, 10, 10, 0.03), rgba(10, 10, 10, 0.07));
  --header: rgba(255, 255, 255, 0.82);
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 12px 32px rgba(0, 0, 0, 0.08);
  --code: #f6f6f7;
  --mark: rgba(250, 204, 21, 0.35);
  --callout: rgba(59, 130, 246, 0.08);
  --callout-line: rgba(59, 130, 246, 0.25);
  --glow: radial-gradient(60rem 28rem at 50% -8rem, rgba(10, 10, 10, 0.05), transparent 70%);
  --card: linear-gradient(180deg, rgba(10, 10, 10, 0.012), rgba(10, 10, 10, 0)), #ffffff;
  --title-fade: rgba(10, 10, 10, 0.72);
  --frame-glow: rgba(10, 10, 10, 0.18);
  --mark-glow: rgba(10, 10, 10, 0.14);
  --radius: 14px;
  --measure: 44rem;
  --wide: 76rem;
  --font: "Inter var", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg: #000000;
  --panel: #0a0a0b;
  --surface: #0b0b0c;
  --surface-2: #141416;
  --fg: #fafafa;
  --fg-2: rgba(250, 250, 250, 0.88);
  --muted: rgba(250, 250, 250, 0.6);
  --faint: rgba(250, 250, 250, 0.5);
  --line: rgba(255, 255, 255, 0.09);
  --line-2: rgba(255, 255, 255, 0.16);
  --btn: #fafafa;
  --btn-ink: #000000;
  --pill: linear-gradient(to top, rgba(250, 250, 250, 0.05), rgba(250, 250, 250, 0.1));
  --header: rgba(0, 0, 0, 0.78);
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 16px 40px rgba(0, 0, 0, 0.6);
  --code: #0e0e10;
  --mark: rgba(250, 204, 21, 0.28);
  --callout: rgba(59, 130, 246, 0.1);
  --callout-line: rgba(96, 165, 250, 0.3);
  --glow: radial-gradient(60rem 28rem at 50% -8rem, rgba(255, 255, 255, 0.09), transparent 70%);
  --card: linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.012)), #050505;
  --title-fade: rgba(255, 255, 255, 0.7);
  --frame-glow: rgba(255, 255, 255, 0.14);
  --mark-glow: rgba(255, 255, 255, 0.42);
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    --bg: #000000; --panel: #0a0a0b; --surface: #0b0b0c; --surface-2: #141416; --fg: #fafafa; --fg-2: rgba(250, 250, 250, 0.88);
    --muted: rgba(250, 250, 250, 0.6); --faint: rgba(250, 250, 250, 0.5); --line: rgba(255, 255, 255, 0.09); --line-2: rgba(255, 255, 255, 0.16);
    --btn: #fafafa; --btn-ink: #000000; --pill: linear-gradient(to top, rgba(250, 250, 250, 0.05), rgba(250, 250, 250, 0.1));
    --header: rgba(0, 0, 0, 0.78); --code: #0e0e10; --callout: rgba(59, 130, 246, 0.1); --callout-line: rgba(96, 165, 250, 0.3);
    --glow: radial-gradient(60rem 28rem at 50% -8rem, rgba(255, 255, 255, 0.09), transparent 70%);
    --card: linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.012)), #050505; --title-fade: rgba(255, 255, 255, 0.7); --frame-glow: rgba(255, 255, 255, 0.14);
    --mark-glow: rgba(255, 255, 255, 0.42);
    color-scheme: dark;
  }
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; scroll-padding-top: 88px; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 var(--font); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
img, video, iframe { max-width: 100%; }
/* <picture> only picks the file (WebP when the browser takes it): the img inside is what lays out. */
picture { display: contents; }
img { height: auto; }
a { color: inherit; }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; border-radius: 6px; }
::selection { background: var(--mark); }
.icon { display: block; flex: none; }
.sr-only, .hp { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.skip { position: absolute; left: 16px; top: -48px; z-index: 100; background: var(--btn); color: var(--btn-ink); padding: 8px 14px; border-radius: 999px; text-decoration: none; }
.skip:focus { top: 12px; }
.wrap { width: 100%; max-width: var(--wide); margin: 0 auto; padding: 0 24px; }
.page { position: relative; z-index: 1; background: var(--glow) no-repeat; }

/* ------------------------------------------------------------ night sky */
.backdrop { position: absolute; top: 0; left: 0; right: 0; height: 880px; z-index: 0; pointer-events: none; overflow: hidden; }
.backdrop.has-image::before { content: ""; position: absolute; inset: 0; background: var(--backdrop) center top / cover no-repeat; -webkit-mask-image: linear-gradient(to bottom, #000 45%, transparent); mask-image: linear-gradient(to bottom, #000 45%, transparent); }
.sparkles { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; transition: opacity 1s ease; -webkit-mask-image: linear-gradient(to bottom, #000 55%, transparent); mask-image: linear-gradient(to bottom, #000 55%, transparent); }
.backdrop ~ .page { background: none; }
/* In the light scheme the sky is a negative: white space, dark specks and soft grey light. */
:root[data-theme="light"] .backdrop { filter: invert(1); }
@media (prefers-color-scheme: light) { :root:not([data-theme]) .backdrop { filter: invert(1); } }
@media (max-width: 767px) { .backdrop { height: 720px; } .backdrop.has-image::before { background-image: var(--backdrop-m, var(--backdrop)); } }

/* ------------------------------------------------------------ header */
.site-header { position: sticky; top: 0; z-index: 50; background: var(--header); backdrop-filter: saturate(180%) blur(14px); -webkit-backdrop-filter: saturate(180%) blur(14px); border-bottom: 1px solid var(--line); transition: background-color 0.3s ease, border-color 0.3s ease; }
/* Clear over the night sky at the top of the page, glass once it scrolls (masthead.js sets is-scrolled). */
.js .site-header:not(.is-scrolled) { background-color: transparent; border-bottom-color: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; }
.bar { display: flex; align-items: center; gap: 28px; height: 68px; }
.brand { display: flex; align-items: center; gap: 9px; text-decoration: none; font-size: 20px; letter-spacing: -0.01em; white-space: nowrap; flex: none; }
.brand img { display: block; height: 24px; width: auto; }
:root[data-theme="light"] .brand img.brand-mark, :root:not([data-theme]) .brand img.brand-mark { filter: invert(1); }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) .brand img.brand-mark { filter: none; } }
.nav { display: flex; align-items: center; gap: 4px; min-width: 0; }
.nav-link, .dd-trigger { display: inline-flex; align-items: center; gap: 4px; padding: 8px 12px; border-radius: 999px; font-size: 15px; color: var(--fg-2); text-decoration: none; background: none; border: 0; cursor: pointer; white-space: nowrap; transition: color 0.15s, background 0.15s; }
.nav-link:hover, .dd-trigger:hover, .nav-link[aria-current="page"] { color: var(--fg); background: var(--surface-2); }
.dd { position: relative; }
.dd-trigger .icon { opacity: 0.6; transition: transform 0.2s; }
.dd:hover .dd-trigger .icon, .dd:focus-within .dd-trigger .icon { transform: rotate(180deg); }
.dd-panel { position: absolute; left: -12px; top: calc(100% + 6px); min-width: 300px; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(270px, 1fr); gap: 8px; padding: 10px; background: var(--panel); border: 1px solid var(--line-2); border-radius: 16px; box-shadow: var(--shadow); opacity: 0; visibility: hidden; transform: translateY(-4px); transition: opacity 0.15s, transform 0.15s, visibility 0s linear 0.15s; }
.dd-panel::before { content: ""; position: absolute; left: 0; right: 0; top: -10px; height: 10px; }
.dd:hover .dd-panel, .dd:focus-within .dd-panel { opacity: 1; visibility: visible; transform: none; transition-delay: 0s; }
.dd-group { display: flex; flex-direction: column; gap: 2px; }
.dd-heading { margin: 4px 10px 6px; font-size: 12px; color: var(--faint); }
.dd-item { display: flex; gap: 12px; align-items: flex-start; padding: 10px; border-radius: 10px; text-decoration: none; }
.dd-item:hover, .dd-item:focus-visible { background: var(--surface-2); }
.dd-icon { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border: 1px solid var(--line-2); border-radius: 8px; color: var(--fg-2); background: var(--bg); }
.dd-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dd-label { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 500; color: var(--fg); }
.dd-label .icon { opacity: 0.5; }
.dd-desc { font-size: 12.5px; line-height: 1.45; color: var(--muted); }
.badge { display: inline-block; font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 6px; border-radius: 999px; border: 1px solid var(--line-2); color: var(--muted); }
.actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.icon-btn { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 999px; border: 1px solid transparent; background: none; color: var(--fg-2); cursor: pointer; text-decoration: none; transition: background 0.15s, color 0.15s; }
.icon-btn:hover { background: var(--surface-2); color: var(--fg); }
.theme-toggle { display: none; }
.js .theme-toggle { display: grid; }
.theme-toggle .moon, :root[data-theme="dark"] .theme-toggle .sun { display: block; }
.theme-toggle .sun, :root[data-theme="dark"] .theme-toggle .moon { display: none; }
.search-trigger { gap: 8px; }
.kbd-hint { display: none; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 20px; border-radius: 999px; font-size: 14px; font-weight: 500; text-decoration: none; white-space: nowrap; cursor: pointer; border: 1px solid transparent; transition: opacity 0.15s, background 0.15s, border-color 0.15s; }
.btn-primary { background: var(--btn); color: var(--btn-ink); }
.btn-primary:hover { opacity: 0.88; }
.btn-pill { background: var(--pill); border-color: var(--line); color: var(--fg); }
.btn-pill:hover { border-color: var(--line-2); }
.btn[disabled] { opacity: 0.5; cursor: default; }
.menu { display: none; }
.menu > summary { list-style: none; }
.menu > summary::-webkit-details-marker { display: none; }
.menu-panel { position: absolute; left: 0; right: 0; top: 68px; max-height: calc(100vh - 68px); overflow-y: auto; padding: 12px 24px 28px; background: var(--bg); border-bottom: 1px solid var(--line); box-shadow: var(--shadow); }
.menu-panel a { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; text-decoration: none; font-size: 16px; color: var(--fg-2); border-bottom: 1px solid var(--line); }
.menu-panel .menu-heading { margin: 18px 0 2px; font-size: 12px; color: var(--faint); }
.menu-panel .menu-actions { display: flex; gap: 10px; margin-top: 20px; }
.menu-panel .menu-actions .btn { flex: 1; border-bottom: 0; justify-content: center; color: inherit; }
.menu-panel .menu-actions .btn-primary { color: var(--btn-ink); }
.menu[open] .menu-open, .menu:not([open]) .menu-close { display: none; }
@media (max-width: 960px) {
  .nav, .actions > .btn { display: none; }
  .menu { display: block; }
  .bar { gap: 12px; }
}
@media (min-width: 961px) {
  .kbd-hint { display: inline-flex; }
  .search-trigger { display: inline-flex; align-items: center; width: auto; padding: 0 8px 0 12px; border-color: var(--line); color: var(--muted); font-size: 13px; }
  .kbd-hint { align-items: center; gap: 10px; }
  .search-trigger:hover { border-color: var(--line-2); }
}
kbd { font: 11px/1 var(--mono); padding: 3px 5px; border-radius: 5px; border: 1px solid var(--line-2); color: var(--muted); background: var(--surface); }

/* ------------------------------------------------------------ front page and lists */
/* The front page's masthead: the blog's name with the logo, big, and its tagline, straight on the night sky. */
.masthead { padding: 112px 0 0; text-align: center; }
.masthead-title { margin: 0; font-size: clamp(38px, 13.2vw, 132px); line-height: 1.04; letter-spacing: -0.045em; font-weight: 600; text-wrap: balance; }
.masthead-mark { display: inline-block; height: 0.8em; width: auto; margin-right: 0.04em; vertical-align: -0.07em; filter: drop-shadow(0 0 0.3em var(--mark-glow)); }
:root[data-theme="light"] .masthead-mark.brand-mark, :root:not([data-theme]) .masthead-mark.brand-mark { filter: invert(1) drop-shadow(0 0 0.3em var(--mark-glow)); }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) .masthead-mark.brand-mark { filter: drop-shadow(0 0 0.3em var(--mark-glow)); } }
.masthead-name, .masthead-kind { padding-bottom: 0.1em; background: linear-gradient(to bottom, var(--fg) 25%, var(--title-fade)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.masthead-kind { font-weight: 300; letter-spacing: -0.03em; background-image: linear-gradient(to bottom, var(--fg-2), var(--faint)); }
.masthead-tagline { margin: 26px auto 0; max-width: 46rem; font-size: clamp(17px, 2.1vw, 23px); line-height: 1.4; letter-spacing: -0.012em; color: var(--muted); text-wrap: balance; }
.masthead + .feature-hero { padding-top: 72px; }
.hero-title { margin: 22px auto 0; max-width: 16ch; font-size: clamp(42px, 6.2vw, 64px); line-height: 1.12; letter-spacing: -0.03em; font-weight: 500; text-wrap: balance; }
.hero-title, .post-title, .list-title { background: linear-gradient(to bottom, var(--fg), var(--title-fade)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.hero-text { margin: 18px auto 0; max-width: 40rem; font-size: 18px; color: var(--muted); text-wrap: balance; }
.topics { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin: 28px auto 0; }
.topic { padding: 7px 14px; border-radius: 999px; border: 1px solid var(--line); font-size: 13.5px; text-decoration: none; color: var(--fg-2); transition: border-color 0.15s, background 0.15s; }
.topic:hover { border-color: var(--line-2); background: var(--surface-2); }
.topic[aria-current="page"] { background: var(--btn); color: var(--btn-ink); border-color: transparent; }
.list-header { padding: 96px 0 36px; text-align: center; }
.list-header .avatar { width: 72px; height: 72px; border-radius: 999px; object-fit: cover; margin: 0 auto 16px; display: block; border: 1px solid var(--line-2); }
.list-kind { font-size: 12px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
.list-title { margin: 8px 0 0; padding-bottom: 0.08em; font-size: clamp(36px, 5vw, 52px); line-height: 1.1; letter-spacing: -0.03em; font-weight: 500; text-wrap: balance; }
.list-text { margin: 12px auto 0; max-width: 38rem; color: var(--muted); font-size: 17px; }
.list-count { margin-top: 10px; font-size: 13px; color: var(--faint); }

.cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
.card-link { display: flex; flex-direction: column; height: 100%; text-decoration: none; border: 1px solid var(--line); border-radius: 18px; background: var(--card); overflow: hidden; transition: border-color 0.2s, transform 0.25s cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 0.25s; }
.card-link:hover { border-color: var(--line-2); transform: translateY(-3px); box-shadow: var(--shadow); }
.card-image { aspect-ratio: 16 / 9; overflow: hidden; border-bottom: 1px solid var(--line); background: var(--surface); }
.card-image img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.4s ease; }
.card-link:hover .card-image img { transform: scale(1.03); }
.card-body { display: flex; flex-direction: column; flex: 1; padding: 18px 20px 20px; }
.card-title { margin: 8px 0 0; font-size: 18.5px; line-height: 1.32; letter-spacing: -0.015em; font-weight: 550; text-wrap: balance; }

.card-excerpt { margin: 8px 0 0; font-size: 15px; line-height: 1.55; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.eyebrow { font-size: 12px; font-weight: 500; letter-spacing: 0.07em; text-transform: uppercase; color: var(--faint); text-decoration: none; }
a.eyebrow:hover { color: var(--fg); }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: auto; padding-top: 14px; font-size: 13px; color: var(--faint); }
.meta .dot::before { content: "\\00b7"; }
.pager { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 56px 0 0; padding-top: 24px; border-top: 1px solid var(--line); font-size: 14px; color: var(--muted); }
.pager a { text-decoration: none; }
@media (max-width: 960px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .cards { grid-template-columns: 1fr; gap: 18px; } .masthead { padding-top: 72px; } .masthead-tagline { margin-top: 18px; } .masthead + .feature-hero { padding-top: 52px; } .masthead + .feature-hero .feature-title { font-size: clamp(28px, 8vw, 34px); } .wrap { padding: 0 18px; } }

/* The newest post as the front page's hero. */
.feature-hero { padding: 88px 0 12px; text-align: center; }
.feature-kicker { display: inline-flex; align-items: center; gap: 10px; margin: 0; font-size: 12px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.feature-kicker .dot::before { content: "\\00b7"; margin: 0 -2px; }
.spark { width: 6px; height: 6px; border-radius: 999px; background: var(--fg); box-shadow: 0 0 12px 2px var(--fg); opacity: 0.9; }
.feature-title { max-width: 21ch; font-size: clamp(38px, 5.6vw, 60px); }
.feature-title a { text-decoration: none; background: inherit; -webkit-background-clip: text; background-clip: text; }
.feature-hero .hero-text { max-width: 44rem; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.feature-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 14px 22px; margin-top: 28px; font-size: 14px; color: var(--muted); }
.feature-by { display: inline-flex; align-items: center; gap: 10px; }
.avatars.small img, .avatars.small span { width: 28px; height: 28px; font-size: 12px; }
.feature-frame { display: block; max-width: 1040px; margin: 56px auto 0; padding: 8px; border-radius: 24px; border: 1px solid var(--line-2); background: var(--card); box-shadow: 0 0 0 1px var(--line), 0 40px 120px -40px var(--frame-glow); transition: transform 0.35s cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 0.35s; }
.feature-frame:hover { transform: translateY(-4px); }
.feature-frame img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 17px; }
.latest { margin-top: 80px; }
.latest-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.latest-head .section-title { margin: 0; }
.latest-head .topics { margin: 0; justify-content: flex-end; }
@media (max-width: 640px) { .feature-hero { padding-top: 56px; } .feature-frame { margin-top: 36px; padding: 5px; border-radius: 18px; } .feature-frame img { border-radius: 13px; } .latest { margin-top: 56px; } .latest-head .topics { justify-content: flex-start; } }

/* Most read: a ranked row. */
.most-read { margin-top: 96px; }
.ranked { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; counter-reset: rank; }
.ranked-link { display: flex; gap: 16px; align-items: flex-start; height: 100%; padding: 18px; border: 1px solid var(--line); border-radius: 18px; background: var(--card); text-decoration: none; transition: border-color 0.2s, transform 0.25s cubic-bezier(0.2, 0.7, 0.2, 1); }
.ranked-link:hover { border-color: var(--line-2); transform: translateY(-2px); }
.rank { font-size: 28px; line-height: 1; font-weight: 500; letter-spacing: -0.03em; color: var(--faint); font-variant-numeric: tabular-nums; }
.ranked-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1; }
.ranked-title { font-size: 16px; line-height: 1.35; font-weight: 550; letter-spacing: -0.01em; text-wrap: balance; }
.ranked-body .meta { padding-top: 2px; }
.ranked-image { flex: none; width: 88px; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden; border: 1px solid var(--line); background: var(--surface); }
.ranked-image img { width: 100%; height: 100%; object-fit: cover; display: block; }
.topic-count { margin-left: 7px; font-size: 11.5px; color: var(--faint); font-variant-numeric: tabular-nums; }
.topic[aria-current="page"] .topic-count { color: inherit; opacity: 0.75; }
.cards > li[hidden] { display: none; }
.filter-more { margin: 28px 0 0; text-align: center; }
@media (max-width: 960px) { .ranked { grid-template-columns: 1fr; } }

/* ------------------------------------------------------------ post */
.post { padding: 88px 0 24px; }
.post-header { max-width: 48rem; margin: 0 auto; text-align: center; }
.post-title { margin: 16px 0 0; padding-bottom: 0.08em; font-size: clamp(36px, 5.4vw, 58px); line-height: 1.1; letter-spacing: -0.03em; font-weight: 500; text-wrap: balance; }
.dek { margin: 18px auto 0; max-width: 40rem; font-size: 19px; line-height: 1.55; color: var(--muted); text-wrap: pretty; }
.byline { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 26px; font-size: 14px; color: var(--muted); }
.avatars { display: flex; }
.avatars img, .avatars span { width: 36px; height: 36px; border-radius: 999px; object-fit: cover; border: 2px solid var(--bg); background: var(--surface-2); display: grid; place-items: center; font-size: 14px; font-weight: 600; color: var(--fg-2); }
.avatars > * + * { margin-left: -10px; }
.byline-text { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.35; }
.byline-names { color: var(--fg); font-weight: 500; }
.byline-names a { text-decoration: none; }
.byline-names a:hover { text-decoration: underline; }
.feature { max-width: 64rem; margin: 44px auto 0; }
.feature img { display: block; width: 100%; border-radius: var(--radius); border: 1px solid var(--line); }
.feature figcaption { margin-top: 12px; text-align: center; font-size: 13.5px; color: var(--faint); }
.post-foot { max-width: var(--measure); margin: 56px auto 0; padding-top: 24px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); font-size: 13px; text-decoration: none; color: var(--fg-2); }
.chip:hover { border-color: var(--line-2); background: var(--surface-2); }
.share { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--faint); }
.share-label { margin-right: 6px; }
.share .icon-btn { width: 34px; height: 34px; }
[data-copy-link][data-copied] { color: #22c55e; }
.related { margin-top: 80px; padding-top: 48px; border-top: 1px solid var(--line); }
.section-title { margin: 0 0 24px; font-size: 22px; letter-spacing: -0.02em; font-weight: 550; }

/* ------------------------------------------------------------ post body */
.content { max-width: var(--measure); margin: 48px auto 0; font-size: 18px; line-height: 1.75; color: var(--fg-2); overflow-wrap: break-word; }
.content > * { margin: 0; }
.content > * + * { margin-top: 1.25em; }
.content h2, .content h3, .content h4 { color: var(--fg); font-weight: 650; letter-spacing: -0.02em; line-height: 1.25; text-wrap: balance; }
.content h2 { font-size: 1.6em; margin-top: 2em; }
.content h3 { font-size: 1.3em; margin-top: 1.7em; }
.content h4 { font-size: 1.1em; margin-top: 1.5em; }
.content h2 + *, .content h3 + *, .content h4 + * { margin-top: 0.75em; }
.content a { color: var(--fg); text-decoration: underline; text-decoration-color: var(--line-2); text-decoration-thickness: 1px; text-underline-offset: 3px; transition: text-decoration-color 0.15s; }
.content a:hover { text-decoration-color: currentColor; }
.content strong { color: var(--fg); font-weight: 650; }
.content ul, .content ol { padding-left: 1.3em; }
.content li + li { margin-top: 0.45em; }
.content li::marker { color: var(--faint); }
.content blockquote { padding: 2px 0 2px 1.1em; border-left: 3px solid var(--fg); color: var(--fg); font-size: 1.05em; }
.content blockquote p + p { margin-top: 0.8em; }
.content hr { border: 0; height: 1px; background: var(--line-2); margin: 2.6em 0; }
.content code { font: 0.86em/1.5 var(--mono); padding: 0.15em 0.4em; border-radius: 6px; background: var(--code); border: 1px solid var(--line); }
.content pre { padding: 18px 20px; border-radius: 12px; background: var(--code); border: 1px solid var(--line); overflow-x: auto; font-size: 14.5px; line-height: 1.65; }
.content pre code { padding: 0; border: 0; background: none; font-size: inherit; }
.content table { display: block; width: 100%; overflow-x: auto; border-collapse: collapse; font-size: 15.5px; }
.content th, .content td { padding: 10px 14px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
.content th { color: var(--fg); font-weight: 600; border-bottom-color: var(--line-2); }
.content img { display: block; border-radius: 10px; }
.content figure { margin-left: 0; margin-right: 0; }
.content figcaption { margin-top: 10px; text-align: center; font-size: 14px; line-height: 1.5; color: var(--faint); }
.content iframe { display: block; border: 0; border-radius: 12px; }
.content mark { background: var(--mark); color: inherit; padding: 0 2px; border-radius: 3px; }

/* Ghost cards, so imported posts look as they did */
.kg-card + *, * + .kg-card { margin-top: 2em; }
.kg-image-card img, .kg-image { margin: 0 auto; border: 1px solid var(--line); }
.kg-width-wide { position: relative; width: min(64rem, calc(100vw - 48px)); left: 50%; transform: translateX(-50%); }
.kg-width-full { position: relative; width: 100vw; left: 50%; transform: translateX(-50%); }
.kg-width-full img { border-radius: 0; border-left: 0; border-right: 0; }
.kg-gallery-container { display: flex; flex-direction: column; }
.kg-gallery-row { display: flex; flex-direction: row; justify-content: center; }
.kg-gallery-row + .kg-gallery-row { margin-top: 0.75em; }
.kg-gallery-image img { display: block; margin: 0; width: 100%; height: 100%; object-fit: cover; border-radius: 8px; }
.kg-gallery-image + .kg-gallery-image { margin-left: 0.75em; }
.kg-embed-card { display: flex; flex-direction: column; align-items: center; }
.kg-embed-card iframe { width: 100%; aspect-ratio: 16 / 9; height: auto; }
.kg-callout-card { display: flex; gap: 14px; padding: 18px 22px; border-radius: 12px; background: var(--callout); border: 1px solid var(--callout-line); font-size: 0.95em; line-height: 1.65; color: var(--fg); }
.kg-callout-card-grey, .kg-callout-card-white { background: var(--surface); border-color: var(--line); }
.kg-callout-emoji { font-size: 1.15em; line-height: 1.5; }
.kg-button-card { display: flex; }
.kg-button-card.kg-align-center { justify-content: center; }
.content .kg-btn, .content .kg-cta-button { display: inline-flex; align-items: center; height: 44px; padding: 0 22px; border-radius: 999px; background: var(--btn); color: var(--btn-ink); font-size: 15px; font-weight: 500; text-decoration: none; }
.content .kg-btn:hover, .content .kg-cta-button:hover { opacity: 0.88; }
.kg-cta-card { border-radius: 14px; border: 1px solid var(--line); background: var(--surface); }
.kg-cta-content { display: flex; flex-direction: column; gap: 18px; padding: 24px 26px; }
.kg-cta-content-inner { display: flex; flex-direction: column; gap: 16px; }
.kg-cta-text { color: var(--fg); font-size: 0.97em; line-height: 1.65; }
.kg-cta-text p + p { margin-top: 0.8em; }
.kg-cta-image-container img { border-radius: 10px; }
.kg-video-card video { display: block; width: 100%; border-radius: 12px; background: #000; }
.kg-video-overlay, .kg-video-player-container, .kg-video-hide-animated, .kg-video-large-play-icon { display: none !important; }
.kg-bookmark-card a.kg-bookmark-container { display: flex; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; text-decoration: none; }
.kg-bookmark-content { flex: 1; padding: 16px 20px; min-width: 0; }
.kg-bookmark-title { color: var(--fg); font-weight: 600; font-size: 15px; }
.kg-bookmark-description { margin-top: 4px; font-size: 14px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.kg-bookmark-metadata { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 13px; color: var(--faint); }
.kg-bookmark-icon { width: 18px; height: 18px; border-radius: 4px; border: 0 !important; }
.kg-bookmark-thumbnail { width: 30%; max-width: 220px; position: relative; }
.kg-bookmark-thumbnail img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border: 0; border-radius: 0; }
.kg-toggle-card { border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; }
.kg-toggle-heading-text { font-weight: 600; color: var(--fg); }
.twitter-tweet { margin-left: auto; margin-right: auto; }

/* ------------------------------------------------------------ newsletter signup */
.signup { position: relative; margin: 96px 0 0; padding: 48px 32px; border-radius: 22px; border: 1px solid var(--line-2); background: radial-gradient(40rem 16rem at 50% 0%, var(--surface-2), transparent 70%), var(--surface); text-align: center; overflow: hidden; }
.signup-icon { display: inline-grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; border: 1px solid var(--line-2); background: var(--bg); color: var(--fg-2); }
.signup-title { margin: 16px 0 0; font-size: clamp(24px, 3vw, 32px); line-height: 1.2; letter-spacing: -0.025em; font-weight: 500; text-wrap: balance; }
.signup-text { margin: 10px auto 0; max-width: 34rem; color: var(--muted); font-size: 16px; text-wrap: balance; }
.signup-form { display: flex; gap: 8px; max-width: 28rem; margin: 24px auto 0; }
.signup-form input[type="email"] { flex: 1; min-width: 0; height: 44px; padding: 0 18px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--bg); font-size: 15px; }
.signup-form input[type="email"]::placeholder { color: var(--faint); }
.signup-form input[type="email"]:focus { outline: none; border-color: var(--fg); }
.signup-form .btn { height: 44px; }
.signup-note { margin: 18px auto 0; max-width: 28rem; font-size: 15px; color: var(--fg); }
.signup-fine { margin-top: 14px; font-size: 12.5px; color: var(--faint); }
@media (max-width: 520px) { .signup { padding: 36px 20px; } .signup-form { flex-direction: column; } }

/* ------------------------------------------------------------ footer */
.site-footer { margin-top: 96px; border-top: 1px solid var(--line); }
.foot-top { display: flex; justify-content: space-between; gap: 48px; padding: 56px 0 48px; }
.foot-brand { display: flex; flex-direction: column; gap: 10px; min-width: 180px; text-decoration: none; }
.foot-brand .brand { font-size: 24px; }
.foot-tagline { margin: 0; font-size: 14px; color: var(--muted); max-width: 22rem; }
.foot-cols { display: grid; grid-template-columns: repeat(4, minmax(120px, auto)); gap: 40px; }
.foot-col h2 { margin: 0 0 18px; font-size: 14px; font-weight: 500; line-height: 20px; color: var(--fg); }
.foot-col ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.foot-col a { font-size: 13.5px; color: var(--muted); text-decoration: none; transition: color 0.15s; }
.foot-col a:hover { color: var(--fg); }
.foot-bottom { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 0 28px; font-size: 12px; color: var(--muted); }
.foot-legal { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 24px; }
.foot-legal a { color: var(--muted); text-decoration: none; }
.foot-legal a:hover { color: var(--fg); }
.social { display: flex; align-items: center; gap: 16px; }
.social a { color: var(--faint); transition: color 0.15s; }
.social a:hover { color: var(--fg); }
@media (max-width: 960px) { .foot-top { flex-direction: column; } .foot-cols { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

/* ------------------------------------------------------------ search */
.search-dialog { width: min(640px, calc(100vw - 24px)); max-height: min(72vh, 640px); margin: 12vh auto auto; padding: 0; border: 1px solid var(--line-2); border-radius: 16px; background: var(--panel); color: var(--fg); box-shadow: var(--shadow); overflow: hidden; }
.search-dialog[open] { display: flex; flex-direction: column; animation: pop 0.14s ease-out; }
.search-dialog::backdrop { background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(3px); }
@keyframes pop { from { opacity: 0; transform: translateY(6px) scale(0.99); } }
.search-box { display: flex; align-items: center; gap: 10px; padding: 0 16px; border-bottom: 1px solid var(--line); color: var(--muted); }
.search-box input { flex: 1; height: 56px; border: 0; background: none; font-size: 17px; color: var(--fg); outline: none; }
.search-box input::-webkit-search-cancel-button { display: none; }
.search-results { overflow-y: auto; padding: 8px; flex: 1; }
.search-label { margin: 8px 10px 6px; font-size: 12px; color: var(--faint); }
.search-hit { display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; border-radius: 10px; text-decoration: none; }
.search-hit[aria-selected="true"], .search-hit:hover { background: var(--surface-2); }
.search-hit-title { font-weight: 600; font-size: 15px; color: var(--fg); }
.search-hit-excerpt { font-size: 13.5px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.search-hit-meta { font-size: 12px; color: var(--faint); }
.search-hit mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 1px; }
.search-empty { padding: 28px 12px; text-align: center; color: var(--muted); font-size: 14px; }
.search-foot { display: flex; gap: 18px; padding: 10px 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--faint); }
.search-foot span { display: inline-flex; align-items: center; gap: 4px; }
.search-page { max-width: 44rem; margin: 0 auto; padding: 64px 0 0; }
.search-page form { display: flex; gap: 8px; margin-top: 24px; }
.search-page input[type="search"] { flex: 1; min-width: 0; height: 48px; padding: 0 18px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--bg); font-size: 16px; }
.search-page .results { list-style: none; margin: 32px 0 0; padding: 0; display: grid; gap: 4px; }

/* ------------------------------------------------------------ small pages */
.message { max-width: 34rem; margin: 0 auto; padding: 96px 0 24px; text-align: center; }
.message h1 { margin: 0; font-size: clamp(30px, 4vw, 42px); letter-spacing: -0.03em; font-weight: 500; }
.message .dek { margin-top: 14px; }
.message .btn { margin-top: 28px; }
.not-found-code { font-size: 13px; font-weight: 500; letter-spacing: 0.08em; color: var(--faint); }

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
@media print { .site-header, .site-footer, .signup, .related, .share { display: none; } body { background: #fff; color: #000; } }
`;
