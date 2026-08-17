// Import order matters: app.ts sets up window.MDE (and its own
// DOMContentLoaded listener) before collab.ts/gist.ts touch it. ES module
// execution follows import order for sibling imports with no circular
// deps, and DOMContentLoaded listeners fire in registration order, so this
// preserves the same ordering the previous <script>/<script type="module">
// tags guaranteed.
import "./app";
import "./collab";
import "./gist";
import "./repo-sync-ui";
import "./style.css";

import { mount } from "svelte";
import Settings from "./components/Settings.svelte";
import Share from "./components/Share.svelte";
import DiagramEditor from "./components/DiagramEditor.svelte";
import WhatsNew from "./components/WhatsNew.svelte";
import CommandPalette from "./components/CommandPalette.svelte";
import SlashMenu from "./components/SlashMenu.svelte";
import VersionHistory from "./components/VersionHistory.svelte";
import CommentsPanel from "./components/CommentsPanel.svelte";
import DocList from "./components/DocList.svelte";
import WorkspaceSwitcher from "./components/WorkspaceSwitcher.svelte";
import Toast from "./components/Toast.svelte";
import MenuBar from "./components/MenuBar.svelte";
import Editor from "./components/Editor.svelte";
import Toolbar from "./components/Toolbar.svelte";
import RenameCollisionModal from "./components/RenameCollisionModal.svelte";
import JoinWorkspaceModal from "./components/JoinWorkspaceModal.svelte";
import WikilinkMenu from "./components/WikilinkMenu.svelte";
import DocInfoPanel from "./components/DocInfoPanel.svelte";
import ConfirmDialog from "./components/ConfirmDialog.svelte";
import ShareChoiceModal from "./components/ShareChoiceModal.svelte";
import GithubSignInModal from "./components/GithubSignInModal.svelte";
import LinkModal from "./components/LinkModal.svelte";
import ImagesModal from "./components/ImagesModal.svelte";
import ShortcutsModal from "./components/ShortcutsModal.svelte";
import AboutModal from "./components/AboutModal.svelte";
import TermsModal from "./components/TermsModal.svelte";
import PrivacyModal from "./components/PrivacyModal.svelte";
import LicensesModal from "./components/LicensesModal.svelte";
import OpenGistModal from "./components/OpenGistModal.svelte";
import RepoLinkModal from "./components/RepoLinkModal.svelte";
import RepoConflictModal from "./components/RepoConflictModal.svelte";

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
mount(RenameCollisionModal, { target: document.getElementById("rename-collision-mount")! });
mount(JoinWorkspaceModal, { target: document.getElementById("join-workspace-modal-mount")! });
mount(DocInfoPanel, { target: document.getElementById("doc-info-panel-mount")! });
mount(ConfirmDialog, { target: document.getElementById("confirm-dialog-mount")! });
mount(ShareChoiceModal, { target: document.getElementById("share-choice-modal-mount")! });
mount(GithubSignInModal, { target: document.getElementById("github-signin-modal-mount")! });
mount(LinkModal, { target: document.getElementById("link-modal-mount")! });
mount(ImagesModal, { target: document.getElementById("images-modal-mount")! });
mount(ShortcutsModal, { target: document.getElementById("shortcuts-modal-mount")! });
mount(AboutModal, { target: document.getElementById("about-modal-mount")! });
mount(TermsModal, { target: document.getElementById("terms-modal-mount")! });
mount(PrivacyModal, { target: document.getElementById("privacy-modal-mount")! });
mount(LicensesModal, { target: document.getElementById("licenses-modal-mount")! });
mount(OpenGistModal, { target: document.getElementById("open-gist-modal-mount")! });
mount(RepoLinkModal, { target: document.getElementById("repo-link-modal-mount")! });
mount(RepoConflictModal, { target: document.getElementById("repo-conflict-modal-mount")! });
mount(DiagramEditor, { target: document.getElementById("diagram-editor-mount")! });
mount(WhatsNew, { target: document.getElementById("whats-new-mount")! });
mount(CommandPalette, { target: document.getElementById("command-palette-mount")! });
mount(SlashMenu, { target: document.getElementById("slash-menu-mount")! });
mount(WikilinkMenu, { target: document.getElementById("wikilink-menu-mount")! });
mount(VersionHistory, { target: document.getElementById("version-history-mount")! });
mount(DocList, { target: document.getElementById("doclist-mount")! });
mount(WorkspaceSwitcher, { target: document.getElementById("workspace-switcher-mount")! });
mount(Toast, { target: document.getElementById("toast-mount")! });
mount(MenuBar, { target: document.getElementById("menubar-mount")! });
mount(Editor, { target: document.getElementById("editor-mount")! });
// CommentsPanel is the first component whose own reactive $effect calls
// window.MDE.getEditor() eagerly (not just from a later click handler,
// like every other window.MDE consumer above) — it must mount after
// Editor, which is what actually calls registerEditor() during its own
// mount, or that first effect run finds cm still null.
mount(CommentsPanel, { target: document.getElementById("comments-panel-mount")! });
mount(Toolbar, { target: document.getElementById("toolbar-mount")! });
