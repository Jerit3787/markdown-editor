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
import DocList from "./components/DocList.svelte";
import Toast from "./components/Toast.svelte";

// #settings-mount / #share-mount / #doclist-mount / #toast-mount already
// exist by the time this runs — main.ts's own <script type="module"> tag
// sits at the end of <body>, after them, and module scripts only execute
// once the document up to that point is parsed. No need to wait for
// DOMContentLoaded here.
mount(Settings, { target: document.getElementById("settings-mount")! });
mount(Share, { target: document.getElementById("share-mount")! });
mount(DocList, { target: document.getElementById("doclist-mount")! });
mount(Toast, { target: document.getElementById("toast-mount")! });
