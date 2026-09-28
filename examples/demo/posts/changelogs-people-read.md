---
title: A field guide to changelogs people read
date: 17 days ago
author: maya-chen
tags: Guides
cover: cover-changelog.jpg
cover_alt: A stack of changelog entries, the newest on top
excerpt: Most changelogs are written for the people who made the changes. Six habits that make yours useful to the people who use them.
sent: 4790
opened: 2184
---

A changelog has two jobs: tell people what is new, and tell them whether they need to do anything. Most miss the second one. Last spring we rewrote ours from scratch. Visits went up 3.4 times, and "did you change something?" tickets went down by half. Here is what we learned.

## 1. Lead with what people can do now

"Refactored the export pipeline" describes your week. "Exports of any size now finish in under a minute" describes theirs. Write the second kind.

A good test: could a customer repeat the line to a colleague and have it mean something? "Improved performance" fails. "Search results appear as you type" passes.

## 2. One change, one line

If an entry needs a paragraph, it is probably a blog post. Link to it and keep the line short. The changelog is a list people scan, and every long entry hides the three short ones below it.

## 3. Say when someone has to act

Anything that breaks, moves or needs a setting changed gets a label and goes first:

- **Action needed:** API keys created before March expire on June 1. Create a new one in Settings.
- **Changed:** The weekly report now arrives on Mondays instead of Fridays.
- **New:** Filter any list by owner.
- **Fixed:** Exports no longer skip archived projects.

We keep the labels to these four. Every extra label is one more thing to learn, and people stop reading labels they have to learn.

## 4. Date every entry

People read changelogs to answer "did this ship before or after my problem started?" A date answers that. Version numbers alone do not, because most people never know which version they are on.

## 5. Show, sometimes

A screenshot is worth it for a new screen. For a new option in a menu, it is noise. Our rule: add a picture when the change is somewhere a person has not been before.

## 6. Publish on a rhythm

We publish every Tuesday, even when the list is short. People learn when to look, and a short week is information too. Once the rhythm is set, the changelog stops being a chore and becomes a habit, for us and for readers.

> The best compliment a changelog can get is a customer who says "I saw that" before you tell them.

## A template

If you want a starting point, ours has four headings in this order: Action needed, New, Improved, Fixed. Empty headings are left out. Every line starts with a verb or a noun the customer would use, never with the name of an internal system.

Write the first one this week. It will take twenty minutes, and it will be read more often than you think.
