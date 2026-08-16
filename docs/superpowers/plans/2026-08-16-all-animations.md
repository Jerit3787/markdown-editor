# Comprehensive UI Animations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cohesive suite of micro-interactions and animations across the entire application to establish a premium, fluid user experience.

**Architecture:** Introduce global CSS keyframes and transition properties to `client/src/style.css`. We will avoid JavaScript-based animations to maintain maximum performance.

**Tech Stack:** Vanilla CSS

## Global Constraints
- Target existing CSS classes without altering application structure.
- Animations must be short (100ms-300ms) to avoid feeling sluggish.
- Respect `prefers-reduced-motion` natively where applicable.

---

### Task 1: Hover and State Transitions

**Files:**
- Modify: `client/src/style.css`

**Interfaces:**
- Consumes: Existing CSS classes `.workspace-row`, `.doc-row`, `.menu-item`, `#sidebar`
- Produces: CSS transitions on those classes

- [ ] **Step 1: Write hover transitions implementation**

Append to `client/src/style.css`:
```css
/* Hover Transitions */
.workspace-row, .doc-row, .menu-item {
  transition: background 0.15s ease, color 0.15s ease;
}

#sidebar {
  transition: margin-left 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
```

---

### Task 2: Button and Input Interactions

**Files:**
- Modify: `client/src/style.css`

**Interfaces:**
- Consumes: Button and Input classes
- Produces: Tactile scale-down effect and focus transitions

- [ ] **Step 1: Write button and input animations**

Append to `client/src/style.css`:
```css
/* Button Feedback */
.icon-btn, .share-pill, .primary-btn, .secondary-btn, .danger-btn {
  transition: transform 0.1s cubic-bezier(0.4, 0, 0.2, 1), background 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}

.icon-btn:active, .share-pill:active, .primary-btn:active, .secondary-btn:active, .danger-btn:active {
  transform: scale(0.96);
}

/* Input Focus Transitions */
input, textarea, select {
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
```

---

### Task 3: Modals and Popups

**Files:**
- Modify: `client/src/style.css`

**Interfaces:**
- Consumes: `.modal-backdrop`, `.modal-box`, `.dropdown-menu.open`, `.slash-menu`, `.command-palette`

- [ ] **Step 1: Write popup animations**

Append to `client/src/style.css`:
```css
/* Popup Transitions */
@keyframes popup-in {
  from { transform: scale(0.96); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.modal-backdrop {
  animation: fade-in 0.15s ease-out forwards;
}

.modal-content, .modal-box, .modal-box-v2, .dropdown-menu.open, .slash-menu, .command-palette {
  animation: popup-in 0.15s ease-out forwards;
}
```

---

### Task 4: Theme Switching and Skeleton Loaders

**Files:**
- Modify: `client/src/style.css`

**Interfaces:**
- Consumes: `body`, `.skeleton`

- [ ] **Step 1: Write theme and loader animations**

Append to `client/src/style.css`:
```css
/* Theme Switching */
body {
  transition: background-color 0.3s ease, color 0.3s ease;
}

/* Skeleton Loader Shimmer */
@keyframes shimmer {
  0% { background-position: -1000px 0; }
  100% { background-position: 1000px 0; }
}

.skeleton {
  animation: shimmer 2s infinite linear;
  background: linear-gradient(to right, var(--bg-alt) 4%, var(--border) 25%, var(--bg-alt) 36%);
  background-size: 1000px 100%;
}
```

- [ ] **Step 2: Run build to verify CSS**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add client/src/style.css
git commit -m "style: implement comprehensive UI animations suite"
```
