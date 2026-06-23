# Open Generative AI: Technical Documentation & Context

This document serves as a comprehensive knowledge base for the Open Generative AI project.

## 1. Project Vision & Overview

**Open Generative AI** is an ambitious open-source project for AI image and video generation.

- **Stack:** Vite, Vanilla JavaScript, Tailwind CSS v4.
- **Repository:** `https://github.com/Anil-matcha/Open-Generative-AI`

## 2. Architecture & File Structure

```tree
src/
├── components/
│   ├── ImageStudio.js
│   ├── Header.js
│   ├── AuthModal.js
│   ├── SettingsModal.js
│   └── Sidebar.js
├── lib/
│   ├── muapi.js
│   └── models.js
├── styles/
│   ├── global.css
│   ├── studio.css
│   └── variables.css
├── main.js
└── style.css
```

## 3. Key Components & Logic

### `muapi.js` (The Engine)
- **Authentication:** Uses `x-api-key` header
- **Pattern:** Submit -> Poll

### `models.js` (The Data)
Contains the `t2iModels` array with model definitions.

## 4. UI & Styling

- **Theme:** Dark mode (`bg-app-bg` = `#050505`)
- **Accent:** Electric Cyan (`#22d3ee`)
