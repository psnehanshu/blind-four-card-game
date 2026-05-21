import type { Card, Rank, Suit } from "../../../engine/types.js";

const RANK_SLUG: Record<Exclude<Rank, "JOKER">, string> = {
  A: "ace",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  "10": "10",
  J: "jack",
  Q: "queen",
  K: "king",
};

const SUITS: Suit[] = ["clubs", "diamonds", "hearts", "spades"];

export function cardImageSrc(card: Card): string {
  if (card.rank === "JOKER") {
    const trailing = card.id.match(/(\d+)$/);
    const isRed = trailing ? Number(trailing[1]) % 2 === 1 : false;
    return `/cards/${isRed ? "red" : "black"}_joker.svg`;
  }
  if (!card.suit) throw new Error(`Non-joker card missing suit: ${card.id}`);
  return `/cards/${RANK_SLUG[card.rank]}_of_${card.suit}.svg`;
}

/** Every SVG card face the game can render. Used by the splash preloader. */
export const ALL_CARD_IMAGE_URLS: readonly string[] = (() => {
  const urls: string[] = [];
  for (const suit of SUITS) {
    for (const slug of Object.values(RANK_SLUG)) {
      urls.push(`/cards/${slug}_of_${suit}.svg`);
    }
  }
  urls.push("/cards/black_joker.svg", "/cards/red_joker.svg");
  return urls;
})();

/**
 * Warm the browser image cache for every card face. Resolves when all
 * requests have settled (load or error — a missing file shouldn't stall
 * the splash forever). Calls onProgress after each settle.
 */
export function preloadCardImages(onProgress?: (loaded: number, total: number) => void): Promise<void> {
  const total = ALL_CARD_IMAGE_URLS.length;
  let loaded = 0;
  const promises = ALL_CARD_IMAGE_URLS.map(
    (url) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        const settle = () => {
          loaded += 1;
          if (onProgress) onProgress(loaded, total);
          resolve();
        };
        img.onload = settle;
        img.onerror = settle;
        img.src = url;
      }),
  );
  return Promise.all(promises).then(() => undefined);
}
