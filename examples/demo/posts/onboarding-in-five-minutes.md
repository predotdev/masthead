---
title: "Onboarding in five minutes: how we rebuilt the first run"
date: 31 days ago
author: lena-park
tags: Product, Design
cover: cover-onboarding.jpg
cover_alt: A path through four steps, ending in a check mark
excerpt: New teams took 26 minutes to see their first release in Acme. We cut it to under five by deleting steps, not adding tips.
---

When we timed new teams from sign-up to their first release in Acme, the median was 26 minutes. We watched twenty of those sessions with permission. Most of the time went to setup we could have done for them, and to screens that asked questions people could not answer yet.

## What we removed

- **The workspace name screen.** We now use the name of the repository you connect, and you can rename it later. Nobody ever renamed one in the first week.
- **Invites before value.** Inviting teammates moved from step two to after the first release. People invite more often once they have something to show.
- **The empty dashboard.** New projects open on a sample plan built from your last ten pull requests, so the first thing you see is your own work.
- **The tour.** Seven tooltips became zero. When something needs explaining, the empty state explains it in one sentence.

## What we kept

One question: which repository should Acme read first? Everything else can wait, and most of it has a sensible default.

## How we measured

We counted from the moment the sign-up form was submitted to the moment the first release notes were published, for every new team over four weeks before and four weeks after the change. We left out teams that were invited by an existing customer, because they arrive with someone to help them.

## The result

| | Before | After |
| --- | ---: | ---: |
| Median time to first release | 26 min | 4 min 40 s |
| Teams that finish setup | 58% | 81% |
| Support tickets about setup, per week | 34 | 9 |

## What we learned

The lesson was not new, but it was humbling: every screen we added to help people was a screen they had to get through. The fastest onboarding is the one that does the work for you and then gets out of the way.

We now review every new screen in the first run with one question: what happens if we delete it? Most of the time, the answer is "nothing bad".
