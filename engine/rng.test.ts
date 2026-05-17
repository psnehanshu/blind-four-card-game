import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SeededRNG } from "./rng.js";

describe("SeededRNG — next", () => {
  it("returns values in [0, 1)", () => {
    const rng = new SeededRNG(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      assert.ok(v >= 0 && v < 1, `next() out of bounds: ${v}`);
    }
  });

  it("same seed produces same sequence", () => {
    const a = new SeededRNG(123);
    const b = new SeededRNG(123);
    for (let i = 0; i < 100; i++) {
      assert.equal(a.next(), b.next(), `sequence diverged at index ${i}`);
    }
  });

  it("different seeds produce different sequences", () => {
    const a = new SeededRNG(1);
    const b = new SeededRNG(2);
    let differed = false;
    for (let i = 0; i < 10; i++) {
      if (a.next() !== b.next()) {
        differed = true;
        break;
      }
    }
    assert.ok(differed, "seeds 1 and 2 must produce divergent sequences");
  });

  it("seed=0 is a valid seed and produces a deterministic sequence", () => {
    // The constructor uses (seed | 0), so 0 maps to 0 — must not deadlock or NaN.
    const a = new SeededRNG(0);
    const b = new SeededRNG(0);
    for (let i = 0; i < 50; i++) {
      const va = a.next();
      const vb = b.next();
      assert.equal(va, vb);
      assert.ok(va >= 0 && va < 1);
    }
  });
});

describe("SeededRNG — nextInt", () => {
  it("returns integers in [min, max] inclusive", () => {
    const rng = new SeededRNG(7);
    const min = 3;
    const max = 9;
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = rng.nextInt(min, max);
      assert.ok(Number.isInteger(v));
      assert.ok(v >= min && v <= max, `nextInt out of range: ${v}`);
      seen.add(v);
    }
    // Across 5000 draws over a 7-value range, every value should appear.
    for (let v = min; v <= max; v++) {
      assert.ok(seen.has(v), `value ${v} never produced in 5000 draws`);
    }
  });

  it("min === max always returns min", () => {
    const rng = new SeededRNG(99);
    for (let i = 0; i < 100; i++) {
      assert.equal(rng.nextInt(5, 5), 5);
    }
  });

  it("handles negative ranges", () => {
    const rng = new SeededRNG(11);
    for (let i = 0; i < 200; i++) {
      const v = rng.nextInt(-5, -1);
      assert.ok(v >= -5 && v <= -1, `out of range: ${v}`);
      assert.ok(Number.isInteger(v));
    }
  });

  it("same seed produces same sequence of ints", () => {
    const a = new SeededRNG(2024);
    const b = new SeededRNG(2024);
    for (let i = 0; i < 100; i++) {
      assert.equal(a.nextInt(0, 1000), b.nextInt(0, 1000));
    }
  });
});

describe("SeededRNG — shuffle", () => {
  it("does not mutate the input array", () => {
    const rng = new SeededRNG(1);
    const input = [1, 2, 3, 4, 5];
    const snapshot = [...input];
    rng.shuffle(input);
    assert.deepEqual(input, snapshot, "input array must be unchanged");
  });

  it("preserves all elements (is a permutation)", () => {
    const rng = new SeededRNG(13);
    const input = Array.from({ length: 50 }, (_, i) => i);
    const out = rng.shuffle(input);
    assert.equal(out.length, input.length);
    assert.deepEqual(
      [...out].sort((a, b) => a - b),
      input,
    );
  });

  it("same seed produces same permutation", () => {
    const a = new SeededRNG(77);
    const b = new SeededRNG(77);
    const input = Array.from({ length: 20 }, (_, i) => i);
    assert.deepEqual(a.shuffle(input), b.shuffle(input));
  });

  it("different seeds usually produce different permutations", () => {
    const a = new SeededRNG(1);
    const b = new SeededRNG(2);
    const input = Array.from({ length: 30 }, (_, i) => i);
    assert.notDeepEqual(a.shuffle(input), b.shuffle(input));
  });

  it("empty array returns a new empty array", () => {
    const rng = new SeededRNG(5);
    const input: number[] = [];
    const out = rng.shuffle(input);
    assert.deepEqual(out, []);
    assert.notEqual(out, input, "must return a new array, not the same reference");
  });

  it("single-element array returns a new array with that element", () => {
    const rng = new SeededRNG(5);
    const input = [42];
    const out = rng.shuffle(input);
    assert.deepEqual(out, [42]);
    assert.notEqual(out, input);
  });

  it("interleaved next/shuffle calls share the same RNG state", () => {
    // shuffle internally consumes RNG state; subsequent next() calls
    // must reflect that consumption.
    const a = new SeededRNG(33);
    a.shuffle([1, 2, 3, 4]);
    const afterShuffle = a.next();

    const b = new SeededRNG(33);
    b.shuffle([1, 2, 3, 4]);
    assert.equal(b.next(), afterShuffle, "RNG state must advance deterministically across calls");
  });
});
