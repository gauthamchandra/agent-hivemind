export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export const systemRandom: RandomSource = {
  bytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  },
};
