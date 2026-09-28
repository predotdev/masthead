---
title: "52 releases later: what weekly shipping taught us"
date: 24 days ago
author: sam-okafor
tags: Company, Engineering
cover: cover-releases.jpg
cover_alt: A grid of 52 squares, the last one glowing
excerpt: A year ago we promised a release every week. We kept it 52 times in a row. What changed, what broke and what we would do again.
sent: 4760
opened: 1712
---

Last September we made a simple rule: a release goes out every Tuesday, no matter how small. Before that, we released when a feature was ready, which in practice meant every three to six weeks and always on a Friday evening. This week was release number 52.

## The numbers

- **52** releases, none skipped
- **1,318** changes shipped, a median of 24 a week
- **4** rollbacks, all within 30 minutes
- **0** releases that needed a weekend

## What changed

**Smaller changes.** When the next release is never more than a week away, nothing needs to be squeezed in. Our median pull request went from 410 changed lines to 140, and review time dropped with it.

**Fewer surprises.** A weekly release is a small release. When something breaks, the list of suspects is short, and the person who made the change still remembers why.

**Unfinished work ships dark.** Big features now land in pieces behind a flag. A feature that takes two months ships eight times before anyone sees it, and turning it on becomes a non-event.

**Better notes.** Writing release notes every week turned them from a chore into a habit. They also became our best source for this blog.

## What broke

Week 19 shipped a migration that locked a busy table for eleven minutes. Nothing was lost, but the dashboard was read-only for most of that time. We now run every migration against a copy of production data before release day, and anything over ten seconds needs a written plan.

Week 31 went out with a broken invite email because the only test for it was marked as skipped months earlier. We removed the ability to skip tests on the release branch. A test that is not worth fixing is not worth keeping.

Week 44 was the closest we came to missing a Tuesday. Half the team was at a conference and the release lead was sick. It went out at 4 pm with nine changes. That was the week we wrote down the release checklist, so any engineer can run it.

## What we would tell a team starting today

1. Pick the day first and never move it. The rule does the work.
2. Make the release boring. A checklist and one person on duty is enough.
3. Ship unfinished work behind flags instead of waiting for it.
4. Write the notes as you merge, not on release day.

## Would we do it again?

Yes, without changing the rule. The rule is what made the rest possible: once "we ship on Tuesday" was fixed, every other decision got easier.
