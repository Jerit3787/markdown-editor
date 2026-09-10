// Server-side generation of an anonymous collaborator's identity — a
// stable id and a human label. The client no longer invents either (it
// did, per-tab, in collab.ts's deleted getGuestIdentity).

export const GUEST_ADJECTIVES = ["Quiet", "Curious", "Swift", "Gentle", "Bold", "Clever", "Calm", "Bright"];
export const GUEST_ANIMALS = ["Fox", "Owl", "Otter", "Falcon", "Panda", "Lynx", "Heron", "Wren"];

export function randomAnonId(): string {
  // Hex-encode the raw CSPRNG bytes — no modulo, so no bias (js/biased-
  // cryptographic-random). 16 bytes = 128 bits, plenty for an
  // unguessable, namespaced label.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `anon:${s}`;
}

export function randomGuestName(): string {
  const adj = GUEST_ADJECTIVES[Math.floor(Math.random() * GUEST_ADJECTIVES.length)]!;
  const animal = GUEST_ANIMALS[Math.floor(Math.random() * GUEST_ANIMALS.length)]!;
  return `${adj} ${animal}`;
}
