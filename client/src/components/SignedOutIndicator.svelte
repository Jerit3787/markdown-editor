<script lang="ts">
  import { identityUnverified } from "../stores/share";

  function signIn() {
    window.MDE.requireGithubSignIn("Sign in with GitHub to restore your access to this shared workspace.");
  }
</script>

{#if $identityUnverified}
  <button
    type="button"
    class="signed-out-indicator"
    title="You're not signed in — sign in with GitHub if you own or were invited to this workspace, to restore full access."
    onclick={signIn}
  >
    <span class="status-dot status-signed-out"></span>
    Signed out
  </button>
{/if}
