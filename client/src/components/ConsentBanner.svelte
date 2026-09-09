<script lang="ts">
  import { analyticsAvailable } from "../analytics";
  import { analyticsConsent, setConsent } from "../stores/analyticsConsent";

  const show = $derived(analyticsAvailable && $analyticsConsent === "unset");
</script>

{#if show}
  <div class="consent-banner" role="region" aria-label="Analytics consent">
    <p class="consent-banner-text">
      This app uses anonymous, cookieless analytics to see which features get used — no cookies, no cross-site tracking, no document content. Allow a cookie
      for more accurate visit counts? <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>
    </p>
    <div class="consent-banner-actions">
      <button type="button" class="secondary-btn" onclick={() => setConsent("denied")}>No cookies</button>
      <button type="button" class="primary-btn" onclick={() => setConsent("granted")}>Allow</button>
    </div>
  </div>
{/if}
