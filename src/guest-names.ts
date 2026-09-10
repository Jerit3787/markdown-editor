// Server-side generation of an anonymous collaborator's identity — a
// stable id and a human label. The client no longer invents either (it
// did, per-tab, in collab.ts's deleted getGuestIdentity).

export const GUEST_ADJECTIVES = ["Quiet", "Curious", "Swift", "Gentle", "Bold", "Clever", "Calm", "Bright"];
export const GUEST_ANIMALS = ["Fox", "Owl", "Otter", "Falcon", "Panda", "Lynx", "Heron", "Wren"];

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function randomAnonId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `anon:${s}`;
}

export function randomGuestName(): string {
  const adj = GUEST_ADJECTIVES[Math.floor(Math.random() * GUEST_ADJECTIVES.length)]!;
  const animal = GUEST_ANIMALS[Math.floor(Math.random() * GUEST_ANIMALS.length)]!;
  return `${adj} ${animal}`;
}
