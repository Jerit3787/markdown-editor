<script lang="ts">
  import { analyticsAvailable } from "../analytics";
  import { analyticsConsent, setConsent } from "../stores/analyticsConsent";

  const show = $derived(analyticsAvailable && $analyticsConsent === "unset");
</script>

{#if show}
  <div class="consent-banner" role="region" aria-label="Analytics consent">
    <p class="consent-banner-text">
      We use privacy-respecting analytics to see which features get used. No document content is ever collected.
      <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>
    </p>
    <div class="consent-banner-actions">
      <button type="button" class="secondary-btn" onclick={() => setConsent("denied")}>Decline</button>
      <button type="button" class="primary-btn" onclick={() => setConsent("granted")}>Accept</button>
    </div>
  </div>
{/if}
