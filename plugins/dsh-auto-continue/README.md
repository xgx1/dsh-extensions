# dsh-auto-continue

Clicks the DSH web GUI's turn-tail "branch / continue" button automatically after an assistant turn is cut off at the output-token cap, so the model keeps writing until it finishes.

## What it does

A browser-half client plugin (like `dsh-perf-mode`) observes the chat DOM. Whenever a turn tail shows a clickable continue/branch button, it clicks it once per turn; the Host forks at that message and the model resumes writing. If the resume is capped again, the new tail is clicked too — so a long answer resumes automatically across caps.

## Known limit

The DOM does not mark whether a tail ended because of max-tokens, so **any** clickable continue button is auto-clicked, not only truncation tails. There is no off switch short of unloading the plugin; an unresponsive model loop will keep consuming output tokens until it stops on its own.

## Install

Add the package to a profile's `dependencies` and its name to `dsh.profile.bundles`, then run `pnpm install` in the profile directory. The bundle patch inserts the roster row.