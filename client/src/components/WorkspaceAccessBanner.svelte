<script lang="ts">
  import { workspaceAccessDenied } from "../stores/share";

  function signIn() {
    window.MDE.requireGithubSignIn("Sign in with GitHub to reconnect to this shared workspace.");
  }
</script>

{#if $workspaceAccessDenied === "no-session"}
  <div class="workspace-access-banner" role="alert">
    <span>You're signed out — sign in to reconnect to this shared workspace.</span>
    <button type="button" class="primary-btn" onclick={signIn}>Sign in</button>
  </div>
{:else if $workspaceAccessDenied === "no-access"}
  <div class="workspace-access-banner" role="alert">
    <span>You no longer have access to this shared workspace. Ask the owner to invite you, or check that you're using the right link.</span>
  </div>
{/if}
