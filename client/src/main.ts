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
