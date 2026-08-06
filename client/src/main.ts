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

// #settings-mount already exists by the time this runs — main.ts's own
// <script type="module"> tag sits at the end of <body>, after it, and
// module scripts only execute once the document up to that point is
// parsed. No need to wait for DOMContentLoaded here.
mount(Settings, { target: document.getElementById("settings-mount")! });
