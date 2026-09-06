// Runs ahead of every "components" project test file's own imports (same
// timing guarantee as vitest.setup.ts for the "unit" project). The real
// index.html always has a `<div id="body">`, and stores/view.ts writes
// its className as a module-load side effect — any component test that
// transitively imports it (e.g. via collab.ts, which WorkspaceSwitcher
// pulls in for pushWorkspaceRename) crashes on import without this.
if (typeof document !== "undefined" && !document.getElementById("body")) {
  const body = document.createElement("div");
  body.id = "body";
  document.body.appendChild(body);
}
