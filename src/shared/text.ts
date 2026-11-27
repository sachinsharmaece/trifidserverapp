/** The most a trade history note may hold (the `trade_events` model refuses more). */
export const NOTE_LIMIT = 300;

/** Shortens a history note to fit, ending in "..." when it was cut. */
export const clip = (text: string) =>
  text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT - 3)}...` : text;
