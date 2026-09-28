---
title: Dark mode without the flash
date: 11 days ago
author: lena-park
tags: Design, Engineering
cover: cover-dark-mode.jpg
cover_alt: A moon on a dark background and a sun on a light one, meeting in the middle
excerpt: A white page that blinks to black is the most common dark mode bug on the web. Here is the fifteen-line fix we use everywhere.
---

You open a page at night, it paints white, and a moment later it turns dark. It is a small thing, and it makes a product feel careless. The flash happens because the page learns which theme you want only after its JavaScript runs, and by then the browser has already painted.

## Decide before the first paint

The fix is to choose the theme before anything is drawn. A tiny inline script in the `<head>` runs before the body is parsed, reads the saved choice (or the system setting) and sets an attribute on the root element:

```html
<script>
  (function (d) {
    var t;
    try { t = localStorage.getItem('theme'); } catch (e) {}
    if (t !== 'light' && t !== 'dark') {
      t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    d.setAttribute('data-theme', t);
  })(document.documentElement);
</script>
```

It has to be inline. A separate file, even a small one, is a network request, and the browser will not wait for a deferred script before painting. The `try` matters too: some browsers throw when storage is blocked, and a script that throws in the head leaves you with the flash you were trying to avoid.

## One set of rules, two sets of colors

With the attribute in place, colors become variables and every rule uses them:

```css
:root {
  --bg: #ffffff;
  --fg: #0a0a0a;
  --muted: rgba(10, 10, 10, 0.6);
  --line: rgba(10, 10, 10, 0.08);
}
:root[data-theme='dark'] {
  --bg: #000000;
  --fg: #fafafa;
  --muted: rgba(250, 250, 250, 0.6);
  --line: rgba(255, 255, 255, 0.09);
}
body { background: var(--bg); color: var(--fg); }
```

Nothing else in the stylesheet mentions a color directly. That rule is easy to state and easy to break, so we check it in review: a hex value outside the two blocks above is a bug.

Add `<meta name="color-scheme" content="light dark">` too, so form controls, scrollbars and the page behind them match before your CSS arrives.

## The toggle

The toggle only has to do two things: flip the attribute and remember the choice.

```js
document.querySelector('[data-theme-toggle]').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) {}
});
```

## Details that matter

- **Respect the system until someone chooses.** Only save a choice when a person clicks the toggle. Until then, follow their operating system, including when it switches at sunset.
- **Check contrast in both themes.** Gray text that passes on white often fails on black. We aim for 4.5:1 on body text in both, and we test with real screens at night, not just a checker.
- **Pure black is fine for text pages.** It looks crisp on modern screens and saves battery on OLED. Soften it with lines and surfaces, not with a gray background.
- **Invert with care.** Logos drawn for dark backgrounds need their own light version or a filter. Photos should never be inverted.

That is the whole technique. It costs about 300 bytes, and nobody ever sees a flash again.
