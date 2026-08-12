// Import order matters: app.ts sets up window.MDE (and its own
// DOMContentLoaded listener) before collab.ts/gist.ts touch it. ES module
// execution follows import order for sibling imports with no circular
// deps, and DOMContentLoaded listeners fire in registration order, so this
// preserves the same ordering the previous <script>/<script type="module">
// tags guaranteed.
import "./app";
import "./collab";
import "./gist";
import "./style.css";

import { mount } from "svelte";
import Settings from "./components/Settings.svelte";
import Share from "./components/Share.svelte";
import DiagramEditor from "./components/DiagramEditor.svelte";
import WhatsNew from "./components/WhatsNew.svelte";
import CommandPalette from "./components/CommandPalette.svelte";
import DocList from "./components/DocList.svelte";
import Toast from "./components/Toast.svelte";
import MenuBar from "./components/MenuBar.svelte";
import Editor from "./components/Editor.svelte";
import Toolbar from "./components/Toolbar.svelte";

// #settings-mount / #share-mount / #doclist-mount / #toast-mount /
// #menubar-mount / #editor-mount / #toolbar-mount already exist by the
// time this runs — main.ts's own <script type="module"> tag sits at the
// end of <body>, after them, and module scripts only execute once the
// document up to that point is parsed. No need to wait for
// DOMContentLoaded here — this also means each component's DOM (and its
// element ids) exists before app.ts's own DOMContentLoaded-gated init()
// runs, which several of its handlers (initImport, initEmptyState's
// forward-clicks, initSyncScroll's cm.scrollDOM) still rely on. Editor in
// particular hands its EditorView back to app.ts via
// window.MDE.registerEditor() as part of this same synchronous mount.
mount(Settings, { target: document.getElementById("settings-mount")! });
mount(Share, { target: document.getElementById("share-mount")! });
mount(DiagramEditor, { target: document.getElementById("diagram-editor-mount")! });
mount(WhatsNew, { target: document.getElementById("whats-new-mount")! });
mount(CommandPalette, { target: document.getElementById("command-palette-mount")! });
mount(DocList, { target: document.getElementById("doclist-mount")! });
mount(Toast, { target: document.getElementById("toast-mount")! });
mount(MenuBar, { target: document.getElementById("menubar-mount")! });
mount(Editor, { target: document.getElementById("editor-mount")! });
mount(Toolbar, { target: document.getElementById("toolbar-mount")! });
