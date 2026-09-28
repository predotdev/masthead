---
title: How we cut p95 latency in half by caching at the edge
date: 6 days ago
author: sam-okafor
tags: Engineering
cover: cover-latency.jpg
cover_alt: A latency chart that drops sharply and stays low
excerpt: Our dashboard API spent most of its time answering questions it had already answered. Moving two responses to the edge took p95 from 480 ms to 210 ms.
sent: 4820
opened: 1960
---

In August our dashboard API answered 38 million requests. When we sampled them, 71% were for the same two things: a project's summary and its list of recent releases. Both change a few times an hour. We were computing them from scratch on every request, with six database queries each.

The obvious answer was a cache. The hard part of any cache is knowing when an answer is no longer true, so most of this post is about that.

## The plan

Cache the two responses at the edge, close to the reader, and make old answers unreachable the moment the underlying data changes. The rules were simple:

1. A cached answer is keyed by project and by the viewer's permissions, never by the viewer.
2. Every write that touches a project bumps that project's version number.
3. The version is part of the cache key, so a write makes old answers unreachable. Nothing has to be purged, and a purge can never be missed.

Rule three is the one that made this safe to ship. Purging is a second write that can fail, arrive late or race with a read. A version in the key cannot.

## The code

The whole change is about forty lines in our Worker:

```ts
export async function cached(req: Request, project: Project, render: () => Promise<Response>) {
    const key = new Request(`https://cache.acme.internal/${project.id}/v${project.version}/${scope(req)}`);
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) return hit;

    const res = await render();
    if (res.ok) {
        const copy = new Response(res.body, res);
        copy.headers.set('cache-control', 'public, max-age=300');
        await cache.put(key, copy.clone());
        return copy;
    }
    return res;
}
```

`scope(req)` turns the viewer's role into one of four strings (owner, member, guest, public), so a project has at most four cached copies of each answer. The version lives in the project row we already load to check permissions, so reading it costs nothing.

## Rolling it out

We shipped it behind a flag to 10% of projects for a week and compared the two groups every day. We watched three numbers: latency, database load and the rate of "this is out of date" reports from support. The third one stayed at zero, which was the number we cared about most. Then we turned it on for everyone.

## The results

| | Before | After |
| --- | ---: | ---: |
| p50 | 120 ms | 45 ms |
| p95 | 480 ms | 210 ms |
| p99 | 1.4 s | 620 ms |
| Database reads per minute | 52,000 | 9,800 |
| Cache hit rate | none | 83% |

The p99 improved less than we hoped. The slowest requests are the first view after a write, which still does the full work. We are testing a small change that renders the new answer right after the write, before anyone asks for it.

## What did not work

Our first attempt cached per viewer. The hit rate was 9%, because most people open a project once or twice a day and each of them paid for their own copy. Keying by permission scope instead of by person took it to 83%.

We also tried a five-minute expiry with no versions. It was simpler and it was wrong: for up to five minutes after a release, the dashboard showed the release as not shipped. Two customers noticed on the first day.

> A cache is a bet on what people will ask next. Key it by what the answer depends on, not by who asked.

If you run something similar and want to compare notes, the platform team is always happy to talk.
