# dsh-perf-mode

Disables animation, transition, and backdrop-blur effects in the DSH web GUI.

## What it does

The browser half injects one global `<style>` element:

- `animation: none`, `transition: none`, and `scroll-behavior: auto` on every element and pseudo-element.
- `--dsw-menu-backdrop-filter: none`, which is the `blur(40px) saturate(150%)` token every menu, popover, and dock panel reads.
- `backdrop-filter: none` on every element, covering the few rules that hardcode a blur instead of using the token.

The host half provides no behavior; its row exists so the client-module loader can discover the browser half.

## Install

Add the package to a profile's `dependencies` and its name to `dsh.profile.bundles`, then run `pnpm install` in the profile directory. The bundle patch inserts the roster row.

## Notes

- Every effect is cosmetic, so nothing depends on `animationend` or `transitionend` to finish work.
- Removing the effects changes no layout and no behavior; colors, spacing, and hit targets stay identical.
