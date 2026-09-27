/** The whole theme stylesheet. System fonts only, so pages never wait on a font download. */
export const css = `:root {
  --bg: #ffffff;
  --fg: #16161a;
  --muted: #5d5d66;
  --faint: #8a8a93;
  --line: #e7e7ea;
  --soft: #f5f5f6;
  --accent: #16161a;
  --radius: 10px;
  --measure: 42rem;
  --wide: 64rem;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e0e10;
    --fg: #ededee;
    --muted: #a3a3ab;
    --faint: #7c7c85;
    --line: #26262b;
    --soft: #17171a;
    --accent: #ededee;
    color-scheme: dark;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.65 var(--font); -webkit-font-smoothing: antialiased; }
img, video, iframe { max-width: 100%; }
img { height: auto; }
a { color: inherit; text-underline-offset: 3px; text-decoration-thickness: 1px; }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.skip { position: absolute; left: -999px; top: 8px; background: var(--fg); color: var(--bg); padding: 6px 10px; border-radius: 6px; }
.skip:focus { left: 8px; }
.wrap { max-width: var(--wide); margin: 0 auto; padding-inline: 20px; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 64px; }
.site-header { border-bottom: 1px solid var(--line); }
.brand { font-weight: 650; text-decoration: none; letter-spacing: -0.01em; display: inline-flex; align-items: center; }
.brand img { display: block; width: auto; max-height: 28px; }
.nav { display: flex; gap: 18px; flex-wrap: wrap; font-size: 15px; }
.nav a { color: var(--muted); text-decoration: none; }
.nav a:hover { color: var(--fg); }
main { padding-block: 48px 72px; }
.site-footer { border-top: 1px solid var(--line); color: var(--faint); font-size: 14px; }
.site-footer a { color: var(--faint); }

.eyebrow { display: inline-block; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); text-decoration: none; }
.meta { color: var(--faint); font-size: 14px; margin: 0; }
.meta a { color: var(--muted); text-decoration: none; }
.dek { color: var(--muted); font-size: 19px; line-height: 1.55; margin: 12px 0 0; }

.post-header, .content, .post-footer { max-width: var(--measure); margin-inline: auto; }
.post-title { font-size: clamp(32px, 5vw, 46px); line-height: 1.08; letter-spacing: -0.025em; margin: 10px 0 0; text-wrap: balance; }
.post-header .meta { margin-top: 16px; }
.feature { margin: 36px auto 0; max-width: var(--wide); }
.feature img { display: block; width: 100%; border-radius: var(--radius); }
.feature figcaption, .content figcaption { color: var(--faint); font-size: 14px; text-align: center; margin-top: 10px; }

.content { margin-top: 40px; }
.content > * + * { margin-top: 1.1em; }
.content h2 { font-size: 27px; line-height: 1.25; letter-spacing: -0.015em; margin-top: 1.8em; }
.content h3 { font-size: 21px; line-height: 1.3; margin-top: 1.6em; }
.content p, .content ul, .content ol { margin-bottom: 0; }
.content li + li { margin-top: 0.35em; }
.content blockquote { margin-inline: 0; padding-left: 18px; border-left: 3px solid var(--fg); color: var(--muted); }
.content hr { border: 0; border-top: 1px solid var(--line); margin-block: 2.2em; }
.content code { font-family: var(--mono); font-size: 0.88em; background: var(--soft); padding: 2px 5px; border-radius: 5px; }
.content pre { font-family: var(--mono); font-size: 14px; line-height: 1.55; background: var(--soft); padding: 16px 18px; border-radius: var(--radius); overflow-x: auto; }
.content pre code { background: none; padding: 0; font-size: inherit; }
.content table { width: 100%; border-collapse: collapse; font-size: 15px; display: block; overflow-x: auto; }
.content th, .content td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }

/* Cards in imported Ghost content */
.kg-card { margin-block: 1.6em; }
.kg-image-card img, .kg-gallery-image img { display: block; margin-inline: auto; border-radius: 6px; }
.kg-width-wide { position: relative; width: min(var(--wide), calc(100vw - 40px)); left: 50%; transform: translateX(-50%); }
.kg-width-full { position: relative; width: 100vw; left: 50%; transform: translateX(-50%); }
.kg-width-full img { border-radius: 0; }
.kg-gallery-container { display: flex; flex-direction: column; gap: 10px; }
.kg-gallery-row { display: flex; gap: 10px; }
.kg-gallery-image { flex: 1 1 0; }
.kg-gallery-image img { width: 100%; height: 100%; object-fit: cover; }
.kg-embed-card { display: flex; flex-direction: column; align-items: center; }
.kg-embed-card iframe { width: 100%; height: auto; aspect-ratio: 16 / 9; border: 0; border-radius: 6px; }
.kg-video-card video { display: block; width: 100%; border-radius: 6px; }
.kg-video-overlay, .kg-video-player-container { display: none; }
.kg-callout-card { display: flex; gap: 12px; padding: 16px 18px; border-radius: var(--radius); background: var(--soft); }
.kg-callout-emoji { font-size: 20px; line-height: 1.4; }
.kg-callout-text { flex: 1; }
.kg-button-card { display: flex; justify-content: center; }
.kg-button-card.kg-align-left { justify-content: flex-start; }
.kg-btn, .kg-cta-button { display: inline-block; padding: 10px 18px; border-radius: 999px; background: var(--fg); color: var(--bg) !important; text-decoration: none; font-weight: 600; font-size: 15px; }
.kg-cta-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; }
.kg-cta-content { display: flex; flex-direction: column; gap: 12px; }
.kg-cta-image-container img { border-radius: 6px; }
.kg-cta-sponsor-label { display: none; }
.kg-bookmark-card a { display: flex; border: 1px solid var(--line); border-radius: var(--radius); text-decoration: none; overflow: hidden; }
.kg-bookmark-content { padding: 14px 16px; flex: 1; }
.kg-bookmark-title { font-weight: 600; }
.kg-bookmark-description, .kg-bookmark-metadata { color: var(--muted); font-size: 14px; }
.kg-bookmark-thumbnail { max-width: 30%; }
.kg-bookmark-thumbnail img { width: 100%; height: 100%; object-fit: cover; }
.kg-toggle-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 16px; }

.post-footer { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--line); }
.chip { font-size: 14px; padding: 4px 12px; border-radius: 999px; background: var(--soft); text-decoration: none; }

.related { max-width: var(--wide); margin: 72px auto 0; padding-top: 32px; border-top: 1px solid var(--line); }
.section-title { font-size: 20px; margin: 0 0 20px; }

.list-header { max-width: var(--measure); margin-bottom: 40px; }
.list-title { font-size: clamp(30px, 4.5vw, 42px); line-height: 1.1; letter-spacing: -0.025em; margin: 6px 0 0; }
.avatar { display: block; border-radius: 50%; margin-bottom: 14px; }
.cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 36px 28px; }
.card-link { display: flex; flex-direction: column; gap: 14px; text-decoration: none; }
.card-image { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: var(--radius); background: var(--soft); }
.card-title { font-size: 20px; line-height: 1.3; letter-spacing: -0.01em; margin: 6px 0 0; text-wrap: balance; }
.card-link:hover .card-title { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.card-excerpt { color: var(--muted); font-size: 15.5px; margin: 8px 0 10px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.pager { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 56px; color: var(--faint); font-size: 15px; }
.pager a { color: var(--fg); }
.subscribe { max-width: var(--measure); margin: 64px auto 0; padding: 24px; border: 1px solid var(--line); border-radius: var(--radius); display: grid; gap: 16px; }
.subscribe-title { font-size: 20px; margin: 0; }
.subscribe-text { color: var(--muted); margin: 6px 0 0; font-size: 15.5px; }
.subscribe-form { display: flex; gap: 10px; flex-wrap: wrap; }
.subscribe-form input[type=email] { flex: 1 1 220px; font: inherit; font-size: 16px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); color: var(--fg); }
.subscribe-form button { font: inherit; font-size: 15px; font-weight: 600; padding: 10px 18px; border: 0; border-radius: 999px; background: var(--fg); color: var(--bg); cursor: pointer; }
.subscribe-form input:focus-visible, .subscribe-form button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hp, .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.hp { left: -9999px; }
@media (max-width: 640px) {
  body { font-size: 16.5px; }
  main { padding-block: 32px 56px; }
  .kg-gallery-row { flex-direction: column; }
}
`;
