# 🎯 MemVault Master Architecture & UI Plan

This document outlines the final phase of development to transform MemVault from a functional, local-first knowledge base into a **perfect, premium, and flawless application**. The overarching goal is a sleek, native-like user experience built on the solid FTS5/SQLite foundation already in place.

---

## 🏗️ Phase 1: The Unified Navigation (Header Overhaul)

### The Problem

The current header utilizes a raw HTML top bar with scattered navigation buttons. As MemVault expands its feature set, this approach limits scalability, creates visual cutter, and detracts from the focused entry-timeline.

### The Perfect Solution

We will implement a **Glassmorphic Segmented Control Pill** or a collapsible **Left Sidebar rail**.

- **Aesthetics**: High-quality SVG Lucide icons will replace basic text/emojis.
- **Micro-Interactions**: Active tabs will feature a sliding, active-state background pill (similar to native iOS segment controls).
- **Separation of Concerns**: Core data views (Timeline, Diary, Conversations, Worklogs, Projects, Docs) will live in the primary navigation structure. Global actions (Settings, Theme Toggle, Vault Unlocking, Quick Log, Search) will be isolated as floating action buttons or docked corner controls.

---

## ⚡ Phase 2: True Single Page Application (SPA) Integration

### The Problem

Currently, opening the documentation (`docs.html`) forces a hard browser navigation to a separate file. This breaks immersion, unloads the user's current search state, and ruins the instantaneous feel of the vault.

### The Perfect Solution

MemVault will become a 100% true SPA.

- **Consolidation**: The `docs.html` file will be permanently deleted.
- **Native Injection**: The Documentation Explorer will be embedded within `index.html` as the "Panel 5" view.
- **Instant Flow**: When the user presses `[5]` or clicks "Docs", the Timeline feed will execute a swift fade-and-slide transition out, and the Docs split-pane reader will slide in. State is perfectly preserved in the background.

---

## ✨ Phase 3: Supreme UI/UX Polish

### The Problem

While the backend SQLite syncs are mathematically precise, the frontend still requires the meticulous polish expected of top-tier SaaS products (e.g., Linear, Vercel, Supabase).

### The Perfect Solution

- **Card Depth**: Implement uniform, deep, and smooth box-shadows (`box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1)`) across all log cards.
- **Interactive Scaling**: Any hoverable entry card will receive a `transform: translateY(-2px)` transition to make the UI feel alive and responsive.
- **Focus Rings**: Critical input fields (Global Search, Diary Quick Log) will receive vibrant, branded focus outlines that glow when active.
- **Consistent Typographical Hierarchy**: Ensuring Inter (system font) and DM Mono (code font) are strictly utilized for maximum legibility of large text walls.

---

## 🚀 Execution Sequence

This plan is sequential. By adhering to this order, we prevent regressions in the currently stable system.

1. **SPA Merge**: Migrate the `docs.html` code natively into `index.html`. Delete `docs.html`.
2. **Header Redesign**: Rip out the legacy top bar and inject the unified navigation pill/sidebar.
3. **CSS Standardization**: Ensure all panels, cards, and modal states follow the new Glassmorphic/Depth guidelines flawlessly.
