---
title: Introducing Acme Flow
date: 2 days ago
author: maya-chen
tags: Product
cover: cover-flow.jpg
cover_alt: A bright line running through a glowing ring
excerpt: Plan, ship and review in one place. Flow turns the work your team already does into a release everyone can follow.
---

Most teams already know what they are shipping. The trouble is that the plan lives in one tool, the code in another and the release notes in someone's head. Acme Flow puts all three in one place, and keeps them in step without anyone updating a status by hand.

## What it does

**Plans that follow the code.** Link a plan to a branch and it updates itself as pull requests open, pass review and merge. Nobody has to ask what is done, and nobody has to remember to say so.

**Releases you can read.** Every merge adds a line to the next release. Edit the wording, group related changes and publish the notes with the release itself. The notes are drafted from the pull request titles, so the first version is already there when you open it.

**Reviews with context.** Reviewers see the plan, the discussion and the diff side by side, so "why are we doing this?" has an answer on the page. When a review takes longer than a day, the plan says so and shows who it is waiting on.

<div class="kg-card kg-callout-card kg-callout-card-blue"><div class="kg-callout-emoji">✨</div><div class="kg-callout-text">Flow is available today on every plan, including Free. Existing projects get it automatically, with nothing to migrate.</div></div>

## How it works

Flow reads the events your repository already sends. When a pull request mentions a plan (`Closes FLOW-128`), Flow links the two. When the pull request merges, the plan moves forward and the change joins the next release draft.

| Event | What Flow does |
| --- | --- |
| Branch created from a plan | Marks the plan in progress |
| Pull request opened | Adds it to the plan's timeline |
| Review approved | Marks the plan ready to ship |
| Merged to main | Adds a line to the next release |
| Release published | Closes the plan and notifies whoever asked for it |

There is no agent to install and no new syntax to learn. If your team already writes "Closes" in pull requests, Flow works on day one. If it does not, Flow suggests the link when a branch name matches a plan.

## What we learned in the beta

2,400 teams used Flow for three months before today. Three things surprised us.

1. **The release notes mattered more than the plans.** Teams told us the draft notes saved them more time than anything else, so we moved them to the top of the page.
2. **Small teams used it most.** Teams of three to eight people opened Flow every day. Larger teams opened it on release day.
3. **Nobody wanted more fields.** Every request for a new field came with a request to hide it by default. Plans have a title, a description and an owner. That is still all.

## Why we built it

We ran Acme on spreadsheets and chat threads for longer than we like to admit. Every Friday someone spent an hour working out what had shipped that week. Flow started as a script that answered that question for us. Today it answers it for every team in the beta, and the Friday hour is gone.

## What comes next

Over the next few weeks Flow will learn to read issues from your tracker, post release notes to your changelog and send a weekly summary to anyone who follows a plan. We will write about each of them here as they ship.

<div class="kg-card kg-button-card kg-align-center"><a href="https://acme.example/flow" class="kg-btn kg-btn-accent">Try Acme Flow</a></div>

Open any project and choose **Flow** in the sidebar. The first plan takes about a minute. If you want a tour, reply to this email and we will set one up.
